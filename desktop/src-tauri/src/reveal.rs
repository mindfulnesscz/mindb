//! Localhost bridge so the web portal can ask the desktop app to reveal a
//! package folder in Finder / Explorer.
//!
//! Web:  POST http://127.0.0.1:7624/reveal  { "clientId", "stableId" }
//! Desktop maps clientId → sourceFolder (set from the UI), walks for
//! `.dchub.json` with that stable_id, then reveals the folder.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

static CLIENT_ROOTS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static BRIDGE_STARTED: OnceLock<()> = OnceLock::new();

fn roots() -> &'static Mutex<HashMap<String, String>> {
    CLIENT_ROOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub fn set_reveal_client_root(client_id: String, source_folder: String) -> Result<(), String> {
    let mut map = roots().lock().map_err(|e| e.to_string())?;
    if source_folder.trim().is_empty() {
        map.remove(&client_id);
    } else {
        map.insert(client_id, source_folder);
    }
    Ok(())
}

#[tauri::command]
pub fn start_reveal_bridge() -> Result<(), String> {
    if BRIDGE_STARTED.set(()).is_err() {
        return Ok(()); // already running
    }
    tauri::async_runtime::spawn(async {
        if let Err(e) = run_bridge().await {
            eprintln!("[reveal bridge] stopped: {e}");
        }
    });
    Ok(())
}

async fn run_bridge() -> Result<(), String> {
    let listener = TcpListener::bind("127.0.0.1:7624")
        .await
        .map_err(|e| format!("Cannot bind reveal bridge on :7624 ({e})"))?;
    eprintln!("[reveal bridge] listening on http://127.0.0.1:7624");

    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).await.unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let (status, body) = handle_request(&req);
        let resp = format!(
            "HTTP/1.1 {status}\r\n\
             Content-Type: application/json; charset=utf-8\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
             Access-Control-Allow-Headers: Content-Type\r\n\
             Connection: close\r\n\
             Content-Length: {}\r\n\r\n\
             {body}",
            body.len()
        );
        let _ = stream.write_all(resp.as_bytes()).await;
    }
}

fn handle_request(req: &str) -> (u16, String) {
    let first = req.lines().next().unwrap_or("");
    if first.starts_with("OPTIONS ") {
        return (204, String::new());
    }

    if first.starts_with("GET /health") {
        return (200, r#"{"ok":true,"service":"dc-hub-reveal"}"#.into());
    }

    if !(first.starts_with("POST /reveal") || first.starts_with("GET /reveal")) {
        return (404, r#"{"ok":false,"error":"not found"}"#.into());
    }

    let payload = parse_reveal_payload(req);
    match payload {
        Ok(p) => match reveal_package(&p.client_id, &p.stable_id) {
            Ok(path) => (
                200,
                format!(
                    r#"{{"ok":true,"path":{}}}"#,
                    serde_json::to_string(&path).unwrap_or_else(|_| "\"\"".into())
                ),
            ),
            Err(e) => (404, format!(r#"{{"ok":false,"error":{}}}"#, serde_json::to_string(&e).unwrap_or_else(|_| "\"error\"".into()))),
        },
        Err(e) => (400, format!(r#"{{"ok":false,"error":{}}}"#, serde_json::to_string(&e).unwrap_or_else(|_| "\"bad request\"".into()))),
    }
}

#[derive(Deserialize)]
struct RevealPayload {
    #[serde(rename = "clientId")]
    client_id: String,
    #[serde(rename = "stableId")]
    stable_id: String,
}

fn parse_reveal_payload(req: &str) -> Result<RevealPayload, String> {
    // Query string on GET
    if let Some(line) = req.lines().next() {
        if let Some(q) = line.split_whitespace().nth(1).and_then(|p| p.split('?').nth(1)) {
            let mut client_id = String::new();
            let mut stable_id = String::new();
            for part in q.split('&') {
                let mut kv = part.splitn(2, '=');
                let k = kv.next().unwrap_or("");
                let v = urlencoding_decode(kv.next().unwrap_or(""));
                match k {
                    "clientId" => client_id = v,
                    "stableId" => stable_id = v,
                    _ => {}
                }
            }
            if !client_id.is_empty() && !stable_id.is_empty() {
                return Ok(RevealPayload { client_id, stable_id });
            }
        }
    }
    // JSON body on POST
    if let Some(idx) = req.find("\r\n\r\n") {
        let body = req[idx + 4..].trim();
        if !body.is_empty() {
            return serde_json::from_str(body).map_err(|e| e.to_string());
        }
    }
    Err("Need clientId and stableId (JSON body or query)".into())
}

fn urlencoding_decode(s: &str) -> String {
    let bytes: Vec<u8> = {
        let mut out = Vec::new();
        let b = s.as_bytes();
        let mut i = 0;
        while i < b.len() {
            match b[i] {
                b'+' => { out.push(b' '); i += 1; }
                b'%' if i + 2 < b.len() => {
                    let h = u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap_or(b'?');
                    out.push(h);
                    i += 3;
                }
                c => { out.push(c); i += 1; }
            }
        }
        out
    };
    String::from_utf8_lossy(&bytes).into_owned()
}

fn reveal_package(client_id: &str, stable_id: &str) -> Result<String, String> {
    let root = {
        let map = roots().lock().map_err(|e| e.to_string())?;
        map.get(client_id).cloned()
    };
    let root = root.ok_or_else(|| {
        "Desktop app has no source folder for this client — open the client in DC Hub desktop first.".to_string()
    })?;
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("Source folder missing on this machine: {root}"));
    }

    let found = find_stable_dir(&root_path, stable_id, 0)
        .ok_or_else(|| format!("No package with stable_id “{stable_id}” under source folder"))?;

    reveal_in_file_manager(&found)?;
    Ok(found.to_string_lossy().into_owned())
}

fn find_stable_dir(dir: &Path, stable_id: &str, depth: u32) -> Option<PathBuf> {
    if depth > 12 {
        return None;
    }
    let manifest = dir.join(".dchub.json");
    if manifest.is_file() {
        if let Ok(text) = std::fs::read_to_string(&manifest) {
            if text.contains(&format!("\"stable_id\"")) && text.contains(stable_id) {
                // Prefer exact JSON match when possible
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    if v.get("stable_id").and_then(|x| x.as_str()) == Some(stable_id) {
                        return Some(dir.to_path_buf());
                    }
                } else if text.contains(stable_id) {
                    return Some(dir.to_path_buf());
                }
            }
        }
    }
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name()?.to_string_lossy();
            if name.starts_with('.') { continue; }
            if let Some(found) = find_stable_dir(&path, stable_id, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path.to_string_lossy()])
            .status()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(format!("/select,{}", path.to_string_lossy()))
            .status()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux: open the containing directory
        let parent = path.parent().unwrap_or(path);
        Command::new("xdg-open")
            .arg(parent)
            .status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
