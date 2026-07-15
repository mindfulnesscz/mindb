use std::path::Path;
use std::process::Command;

mod r2;
mod cloud;
mod supabase;

fn which_soffice() -> Option<String> {
    if let Ok(out) = Command::new("which").arg("soffice").output() {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() { return Some(p); }
        }
    }
    let mac = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
    if Path::new(mac).exists() { return Some(mac.to_string()); }
    None
}

fn encode_webp(src: &str, dest: &str, width: u32, quality: u32) -> Result<(), String> {
    let out = Command::new("cwebp")
        .args([
            "-quiet",
            "-resize", &width.to_string(), "0",
            "-q", &quality.to_string(),
            src, "-o", dest,
        ])
        .output()
        .map_err(|_| "cwebp not found — install: brew install webp".to_string())?;

    if out.status.success() { Ok(()) }
    else { Err(format!("cwebp: {}", String::from_utf8_lossy(&out.stderr).trim())) }
}

fn pdf_to_thumb(pdf: &str, dest: &str, width: u32, quality: u32) -> Result<(), String> {
    let tmp = std::env::temp_dir().join(format!("dchub-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let png_base = tmp.join("page");

    let out = Command::new("pdftoppm")
        .args(["-png", "-f", "1", "-singlefile", pdf, &png_base.to_string_lossy()])
        .output()
        .map_err(|_| "pdftoppm not found — install: brew install poppler".to_string())?;

    let png = png_base.with_extension("png");
    if !out.status.success() || !png.exists() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("pdftoppm failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }

    let result = encode_webp(&png.to_string_lossy(), dest, width, quality);
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

fn pptx_to_thumb(pptx: &str, dest: &str, width: u32, quality: u32) -> Result<(), String> {
    let soffice = which_soffice()
        .ok_or_else(|| "LibreOffice not found — install from libreoffice.org or: brew install --cask libreoffice".to_string())?;

    let tmp = std::env::temp_dir().join(format!("dchub-pptx-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    let out = Command::new(&soffice)
        .args(["--headless", "--convert-to", "pdf", "--outdir", &tmp.to_string_lossy(), pptx])
        .output()
        .map_err(|e| format!("soffice launch failed: {}", e))?;

    let stem = Path::new(pptx).file_stem()
        .and_then(|s| s.to_str()).unwrap_or("output");
    let pdf = tmp.join(format!("{}.pdf", stem));

    if !out.status.success() || !pdf.exists() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("LibreOffice conversion failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }

    let result = pdf_to_thumb(&pdf.to_string_lossy(), dest, width, quality);
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

/// Generate a WebP thumbnail for a given source file.
/// Returns Ok(true) if created, Ok(false) if skipped (already exists), Err(msg) on failure.
#[tauri::command]
fn generate_thumbnail(src: String, dest: String, width: u32, quality: u32) -> Result<bool, String> {
    if Path::new(&dest).exists() { return Ok(false); }

    if let Some(parent) = Path::new(&dest).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let ext = Path::new(&src).extension()
        .and_then(|e| e.to_str()).unwrap_or("").to_lowercase();

    match ext.as_str() {
        "pdf"                         => pdf_to_thumb(&src, &dest, width, quality).map(|_| true),
        "pptx" | "pptm" | "ppt"      => pptx_to_thumb(&src, &dest, width, quality).map(|_| true),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "tif" | "tiff"
                                      => encode_webp(&src, &dest, width, quality).map(|_| true),
        _ => Err(format!("Unsupported thumbnail format: {}", ext)),
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            generate_thumbnail,
            wait_for_oauth_redirect,
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
