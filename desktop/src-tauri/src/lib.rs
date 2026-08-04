use std::path::Path;

mod r2;
mod cloud;
mod supabase;
mod reveal;
mod native;
mod render;

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

/// Generate a WebP thumbnail for a given source file.
/// Returns Ok(true) if created, Ok(false) if skipped (already exists), Err(msg) on failure.
///
/// Rendering is in-process — see `render`. Nothing here shells out to a tool the user had to
/// install, except LibreOffice until it is bundled.
#[tauri::command]
fn generate_thumbnail(
    app: tauri::AppHandle,
    src: String,
    dest: String,
    width: u32,
    quality: u32,
) -> Result<bool, String> {
    if Path::new(&dest).exists() { return Ok(false); }

    if let Some(parent) = Path::new(&dest).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let ext = Path::new(&src).extension()
        .and_then(|e| e.to_str()).unwrap_or("").to_lowercase();

    if ext == "pdf" {
        render::pdf_to_thumb(&app, &src, &dest, width, quality).map(|_| true)
    } else if OFFICE_EXTS.contains(&ext.as_str()) {
        render::office_to_thumb(&app, &src, &dest, width, quality).map(|_| true)
    } else if RASTER_EXTS.contains(&ext.as_str()) {
        render::image_to_thumb(&src, &dest, width, quality).map(|_| true)
    } else {
        Err(format!("Unsupported thumbnail format: {ext}"))
    }
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
              <h2 style=\"margin:0 0 .5rem;color:#4ade80\">DC Hub connected!</h2>\
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
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
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
            generate_thumbnail,
            wait_for_oauth_redirect,
            reveal::start_reveal_bridge,
            reveal::set_reveal_client_root,
            r2::upload_to_r2,
            r2::check_r2_connection,
            r2::list_r2_keys,
            r2::delete_r2_object,
            cloud::upload_to_dropbox,
            cloud::onedrive_device_code,
            cloud::onedrive_poll_token,
            cloud::onedrive_refresh_token,
            supabase::supabase_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
