use md5::{Digest, Md5};
use std::io::{BufReader, Read};

mod r2;
mod cloud;
mod keychain;
mod supabase;
mod reveal;
mod native;
mod render;
mod path_policy;
mod quickxor;
mod upload_stream;

/// Extensions routed through LibreOffice → PDF → PDFium.
///
/// Word and Excel are here as well as PowerPoint: all four are one conversion path, and the caller
/// (`THUMB_EXTS` in the pipeline) decides what it actually offers up.
const OFFICE_EXTS: &[&str] = &[
    "pptx", "pptm", "ppt", // presentations
    "docx", "docm", "doc", // documents
    "xlsx", "xlsm", "xls", // spreadsheets
];

/// Extensions decoded directly by the `image` crate.
const RASTER_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "tif", "tiff", "bmp"];

/* WHY EVERY BLOCKING COMMAND BELOW IS `#[tauri::command(async)]`.
 *
 * Tauri v2: "Commands without the `async` keyword are executed on the main thread unless defined
 * with `#[tauri::command(async)]`." The main thread runs the macOS/Windows event loop, so a sync
 * command holding it for seconds is a window that cannot repaint — the app reads as hung, and on
 * macOS the user gets a spinning beachball for the whole render phase.
 *
 * Every command here does exactly that kind of work: hashing a whole file, comparing two files byte
 * for byte, or — worst — a ~6.4s LibreOffice conversion (`render::office_previews`). The pipeline
 * dispatches these 8 at a time (`thumbnails.ts`), and sync commands serialise all eight onto that
 * one thread, so the batching bought nothing and the freeze was cumulative.
 *
 * `(async)` moves a *sync* fn onto a worker thread with no change to its body or to any call site
 * (the frontend already awaits every `invoke`). Do NOT "fix" this by making them `async fn` instead:
 * that parks blocking work on the async runtime's executor, which is the same bug wearing a
 * different hat. The trivial commands — keychain, reveal — stay sync on purpose.
 */

/// Exact, streaming content comparison. NO LONGER called by the pipeline's unchanged check:
/// reading a Dropbox online-only file forces macOS File Provider to download it, so the
/// byte-compare made every no-change export materialize the whole library on disk
/// (`isUnchanged` in pipeline/fs.ts is metadata-only now — see the comment there).
/// Kept for a future explicit "deep compare / verify" action, where downloading is the point.
/// Streaming avoids loading two large creative files into the webview at once.
#[tauri::command(async)]
fn files_equal(
    app: tauri::AppHandle,
    source_path: String,
    destination_path: String,
) -> Result<bool, String> {
    const CHUNK: usize = 64 * 1024;
    let source_path = path_policy::require_allowed_file(&app, &source_path, "comparison source")?;
    let destination_path =
        path_policy::require_allowed_file(&app, &destination_path, "comparison destination")?;
    let source = std::fs::File::open(&source_path)
        .map_err(|e| format!("open {}: {e}", source_path.display()))?;
    let destination = std::fs::File::open(&destination_path)
        .map_err(|e| format!("open {}: {e}", destination_path.display()))?;
    if source.metadata().map_err(|e| e.to_string())?.len()
        != destination.metadata().map_err(|e| e.to_string())?.len()
    {
        return Ok(false);
    }

    let mut left = BufReader::new(source);
    let mut right = BufReader::new(destination);
    let mut left_buf = [0_u8; CHUNK];
    let mut right_buf = [0_u8; CHUNK];
    loop {
        let left_len = left.read(&mut left_buf).map_err(|e| e.to_string())?;
        let right_len = right.read(&mut right_buf).map_err(|e| e.to_string())?;
        if left_len != right_len || left_buf[..left_len] != right_buf[..right_len] {
            return Ok(false);
        }
        if left_len == 0 {
            return Ok(true);
        }
    }
}

/// Google Drive exposes an MD5 checksum for binary files. Hash locally in Rust so a same-size
/// content change is not mistaken for an unchanged upload, without loading the file into the
/// webview or duplicating the asset identity rules.
fn reader_md5(mut reader: impl Read) -> Result<String, String> {
    const CHUNK: usize = 64 * 1024;
    let mut hasher = Md5::new();
    let mut buffer = [0_u8; CHUNK];
    loop {
        let read = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[tauri::command(async)]
fn file_md5(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let path = path_policy::require_allowed_file(&app, &path, "checksum source")?;
    let file = std::fs::File::open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    reader_md5(BufReader::new(file))
}

/// The OneDrive half of the same question: Graph publishes `file.hashes.quickXorHash` for an item,
/// so a local file can be proved identical to the remote copy without uploading it. Streams from
/// disk for the same reason `file_md5` does — the decision is "should this 500 MB video be sent
/// again", and loading it into the webview to answer that would cost more than sending it.
#[tauri::command(async)]
fn file_quick_xor_hash(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let path = path_policy::require_allowed_file(&app, &path, "checksum source")?;
    let file = std::fs::File::open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    quickxor::reader_quick_xor_hash(BufReader::new(file))
}

#[cfg(test)]
mod checksum_tests {
    use super::reader_md5;

    #[test]
    fn computes_drive_compatible_md5() {
        assert_eq!(
            reader_md5("Sotto".as_bytes()).unwrap(),
            "c39024601df40316b87597c62fe31275",
        );
    }
}

/// Generate a WebP thumbnail for a given source file.
/// Returns Ok(true) if created, Ok(false) if the source fingerprint/settings are current,
/// Err(msg) on failure.
///
/// Rendering is in-process — see `render`. Nothing here shells out to a tool the user had to
/// install, except LibreOffice until it is bundled.
#[tauri::command(async)]
fn generate_thumbnail(
    app: tauri::AppHandle,
    src: String,
    dest: String,
    width: u32,
    quality: u32,
) -> Result<bool, String> {
    let src_path = path_policy::require_allowed_file(&app, &src, "thumbnail source")?;
    let dest_path = path_policy::require_allowed_output(&app, &dest, "thumbnail destination")?;
    if render::thumbnail_current(&src_path, &dest_path, width, quality) { return Ok(false); }

    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let ext = src_path.extension()
        .and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let src = src_path.to_string_lossy();
    let dest = dest_path.to_string_lossy();

    if ext == "pdf" {
        render::pdf_to_thumb(&app, &src, &dest, width, quality)?;
    } else if OFFICE_EXTS.contains(&ext.as_str()) {
        render::office_to_thumb(&app, &src, &dest, width, quality)?;
    } else if RASTER_EXTS.contains(&ext.as_str()) {
        render::image_to_thumb(&src, &dest, width, quality)?;
    } else {
        return Err(format!("Unsupported thumbnail format: {ext}"));
    }
    // Written last: a failed render can leave the previous thumbnail in place, but not a fresh
    // manifest that would incorrectly mark it current on the next run.
    render::write_thumbnail_manifest(&src_path, &dest_path, width, quality)?;
    Ok(true)
}

/// Extensions that get per-page previews at all. Images are a single page by definition.
fn supports_pages(ext: &str) -> bool {
    ext == "pdf" || OFFICE_EXTS.contains(&ext)
}

/// What `generate_document_previews` reports back to the pipeline.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewReport {
    /// Pages the document has. May exceed `rendered` — the portal uses the difference to tell the
    /// viewer to download the asset for the rest.
    total: u32,
    /// Pages written to the preview folder.
    rendered: u32,
    /// True when nothing was re-rendered because the existing previews were already current.
    cached: bool,
}

/// Generate the title thumbnail and per-page previews for one document.
///
/// Separate from `generate_thumbnail` because it does BOTH from a single LibreOffice conversion —
/// that conversion is ~6.4s against ~28ms per rasterised page, so producing the thumbnail and the
/// pages in two passes would nearly double the cost of every document in the library.
///
/// `limit` is the administrator's per-client page cap; spreadsheets are capped at 1 regardless (see
/// `render::page_budget`). A document with more pages than the cap renders the first `limit` and
/// still reports its real `total`.
#[tauri::command(async)]
fn generate_document_previews(
    app: tauri::AppHandle,
    src: String,
    thumb: String,
    pages_dir: String,
    width: u32,
    quality: u32,
    limit: u32,
) -> Result<PreviewReport, String> {
    let src_path = path_policy::require_allowed_file(&app, &src, "preview source")?;
    let thumb_path = path_policy::require_allowed_output(&app, &thumb, "preview thumbnail")?;
    let pages_path = path_policy::require_allowed_output(&app, &pages_dir, "preview directory")?;
    render::validate_preview_area(&src_path, &thumb_path, &pages_path)?;

    let ext = src_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if !supports_pages(&ext) {
        return Err(format!("Per-page previews are not supported for .{ext}"));
    }

    let budget = render::page_budget(&ext, limit);

    // Cheap check first: unchanged source, same limit and same output settings means the previews on
    // disk are still the right ones. Re-runs over a processed library do no rendering at all.
    if let Some(existing) = render::previews_current(&src_path, &pages_path, budget, width, quality) {
        if thumb_path.is_file() {
            return Ok(PreviewReport {
                total: existing.total,
                rendered: existing.rendered,
                cached: true,
            });
        }
    }

    let src = src_path.to_string_lossy();
    let thumb = thumb_path.to_string_lossy();
    let pages_dir = pages_path.to_string_lossy();
    let outcome = if ext == "pdf" {
        render::pdf_previews(&app, &src, &thumb, Some(&pages_dir), width, quality, budget)?
    } else {
        render::office_previews(&app, &src, &thumb, Some(&pages_dir), width, quality, budget)?
    };

    let manifest = render::write_manifest(&src_path, &pages_path, &outcome, budget, width, quality)?;
    Ok(PreviewReport {
        total: manifest.total,
        rendered: manifest.rendered,
        cached: false,
    })
}

/// Bind localhost:7623, wait for one OAuth redirect request, reply with a
/// success page, and return the raw request path (e.g. "/cb?code=…&state=…").
/// Times out after 10 minutes (hosted-email delivery can lag). Async so it
/// never blocks the Tauri IPC thread.
#[tauri::command]
async fn wait_for_oauth_redirect() -> Result<String, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;
    use tokio::time::{timeout, Duration};

    let listener = TcpListener::bind("127.0.0.1:7623")
        .await
        .map_err(|e| format!("Cannot start OAuth listener on :7623 — is another flow in progress? ({e})"))?;

    let accept = async {
        let (stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).await.ok();

        let path = request_line
            .split_whitespace()
            .nth(1)
            .unwrap_or("/")
            .to_string();

        let html = b"HTTP/1.1 200 OK\r\n\
            Content-Type: text/html; charset=utf-8\r\n\
            Connection: close\r\n\r\n\
            <!DOCTYPE html><html><body style=\"\
              font-family:-apple-system,sans-serif;\
              background:#111;color:#fff;\
              display:flex;align-items:center;justify-content:center;\
              min-height:100vh;margin:0;text-align:center\">\
            <div>\
              <div style=\"font-size:3rem;margin-bottom:1rem\">\xe2\x9c\x93</div>\
              <h2 style=\"margin:0 0 .5rem;color:#4ade80\">Sotto connected!</h2>\
              <p style=\"color:#888;margin:0\">You can close this tab and return to the app.</p>\
            </div></body></html>";

        writer.write_all(html).await.ok();
        Ok::<String, String>(path)
    };

    timeout(Duration::from_secs(600), accept)
        .await
        .map_err(|_| "OAuth timed out — no redirect received within 10 minutes.".into())
        .and_then(|r| r)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    /* Render-worker mode, checked before anything Tauri touches.
       PDFium cannot be used concurrently in one process (measured: 8 threads on 8 distinct
       documents failed every render), so each PDF rasterisation happens in a short-lived child
       process — this same executable, re-invoked with a hidden flag. It must not build a webview,
       show a window, or touch the store, so it returns before the builder runs. */
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == render::WORKER_FLAG) {
        std::process::exit(render::worker_main(&args));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            path_policy::restore_persisted_scope(app.handle())
                .map_err(std::io::Error::other)?;
            Ok(())
        })
        /* Updater deliberately NOT registered. Its config is gone from tauri.conf.json — the
           `pubkey` there was a pasted Supabase publishable key rather than a minisign key, and the
           release workflow publishes no `latest.json` for the endpoint to fetch, so auto-update has
           never been able to work. Registering a plugin whose config is absent is the shape most
           likely to fail at startup, and nothing calls it: no frontend usage, and no updater
           permission in capabilities/default.json.

           The crates stay in Cargo.toml and package.json, so turning this on is: generate a keypair
           (`npx tauri signer generate`), put the private key + password in repo secrets, add
           `pubkey`/`endpoints` back, have release-desktop.yml emit updater artifacts, and restore
           this line. */
        .invoke_handler(tauri::generate_handler![
            files_equal,
            file_md5,
            file_quick_xor_hash,
            generate_thumbnail,
            generate_document_previews,
            wait_for_oauth_redirect,
            reveal::start_reveal_bridge,
            reveal::set_reveal_client_root,
            r2::upload_to_r2,
            r2::check_r2_connection,
            r2::list_r2_keys,
            r2::delete_r2_object,
            cloud::upload_to_dropbox,
            upload_stream::cloud_upload_stream,
            cloud::onedrive_device_code,
            cloud::onedrive_poll_token,
            cloud::onedrive_refresh_token,
            keychain::keychain_set_secret,
            keychain::keychain_get_secret,
            keychain::keychain_delete_secret,
            supabase::supabase_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
