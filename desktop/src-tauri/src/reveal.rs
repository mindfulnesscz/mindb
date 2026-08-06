//! Localhost bridge so the web portal can ask the desktop app to reveal a
//! package folder in Finder / Explorer.
//!
//! Web:  POST http://127.0.0.1:7624/reveal  { "clientId", "stableId" }
//! Desktop maps clientId → sourceFolder (set from the UI), walks for an exact
//! `.dchub.json` `stable_id`, then reveals the folder.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{timeout, Duration};

const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 64 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(3);
const ALLOWED_ORIGINS: &[&str] = &[
    "https://hub.disruptcollective.com",
    "https://staging.hub.disruptcollective.com",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
];

static CLIENT_ROOTS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static BRIDGE_STARTED: OnceLock<()> = OnceLock::new();

fn roots() -> &'static Mutex<HashMap<String, String>> {
    CLIENT_ROOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub fn set_reveal_client_root(
    app: tauri::AppHandle,
    client_id: String,
    source_folder: String,
) -> Result<(), String> {
    let mut map = roots().lock().map_err(|e| e.to_string())?;
    if source_folder.trim().is_empty() {
        map.remove(&client_id);
    } else {
        let root = crate::path_policy::require_allowed_directory(
            &app,
            &source_folder,
            "reveal source folder",
        )?;
        map.insert(client_id, root.to_string_lossy().into_owned());
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
        let (stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn(async move {
            if let Err(e) = handle_connection(stream).await {
                eprintln!("[reveal bridge] request failed: {e}");
            }
        });
    }
}

async fn handle_connection(mut stream: TcpStream) -> Result<(), String> {
    let request = match timeout(READ_TIMEOUT, read_request(&mut stream)).await {
        Ok(result) => result,
        Err(_) => Err("request timed out".into()),
    };
    let response = match request {
        Ok(request) => handle_request(&request),
        Err(error) => BridgeResponse::json_error(400, &error),
    };
    stream
        .write_all(response.to_http().as_bytes())
        .await
        .map_err(|e| e.to_string())
}

async fn read_request(reader: &mut (impl AsyncRead + Unpin)) -> Result<String, String> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 2048];
    let mut expected = None;

    loop {
        let read = reader.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if read == 0 {
            return Err("request ended before its declared body was complete".into());
        }
        bytes.extend_from_slice(&chunk[..read]);

        if expected.is_none() {
            expected = expected_request_len(&bytes)?;
        }
        if let Some(length) = expected {
            if bytes.len() >= length {
                bytes.truncate(length);
                return String::from_utf8(bytes).map_err(|_| "request is not UTF-8".into());
            }
        }
    }
}

fn expected_request_len(bytes: &[u8]) -> Result<Option<usize>, String> {
    let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
        if bytes.len() > MAX_HEADER_BYTES {
            return Err("request headers are too large".into());
        }
        return Ok(None);
    };
    if header_end > MAX_HEADER_BYTES {
        return Err("request headers are too large".into());
    }

    let headers = std::str::from_utf8(&bytes[..header_end])
        .map_err(|_| "request headers are not UTF-8")?;
    let mut content_length = None;
    for line in headers.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            return Err("malformed request header".into());
        };
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err("chunked requests are not supported".into());
        }
        if name.eq_ignore_ascii_case("content-length") {
            let parsed = value
                .trim()
                .parse::<usize>()
                .map_err(|_| "invalid Content-Length")?;
            if content_length.replace(parsed).is_some() {
                return Err("duplicate Content-Length".into());
            }
        }
    }
    let body_length = content_length.unwrap_or(0);
    if body_length > MAX_BODY_BYTES {
        return Err("request body is too large".into());
    }
    Ok(Some(header_end + 4 + body_length))
}

struct BridgeResponse {
    status: u16,
    body: String,
    allow_origin: Option<String>,
}

impl BridgeResponse {
    fn json_error(status: u16, error: &str) -> Self {
        Self {
            status,
            body: format!(
                r#"{{"ok":false,"error":{}}}"#,
                serde_json::to_string(error).unwrap_or_else(|_| "\"error\"".into())
            ),
            allow_origin: None,
        }
    }

    fn cors_error(status: u16, error: &str, allow_origin: Option<String>) -> Self {
        let mut response = Self::json_error(status, error);
        response.allow_origin = allow_origin;
        response
    }

    fn to_http(&self) -> String {
        let reason = match self.status {
            200 => "OK",
            204 => "No Content",
            400 => "Bad Request",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            _ => "Error",
        };
        let cors = self.allow_origin.as_ref().map_or_else(String::new, |origin| {
            format!(
                "Access-Control-Allow-Origin: {origin}\r\n\
                 Access-Control-Allow-Methods: POST, OPTIONS\r\n\
                 Access-Control-Allow-Headers: Content-Type\r\n\
                 Vary: Origin\r\n"
            )
        });
        format!(
            "HTTP/1.1 {} {}\r\n\
             Content-Type: application/json; charset=utf-8\r\n\
             {}\
             Connection: close\r\n\
             Content-Length: {}\r\n\r\n\
             {}",
            self.status,
            reason,
            cors,
            self.body.len(),
            self.body,
        )
    }
}

fn request_header<'a>(request: &'a str, wanted: &str) -> Option<&'a str> {
    request
        .split("\r\n\r\n")
        .next()?
        .lines()
        .skip(1)
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case(wanted).then(|| value.trim())
        })
}

fn allowed_origin(request: &str) -> Option<String> {
    let origin = request_header(request, "Origin")?;
    ALLOWED_ORIGINS.contains(&origin).then(|| origin.to_string())
}

fn handle_request(request: &str) -> BridgeResponse {
    let mut request_line = request.lines().next().unwrap_or("").split_whitespace();
    let method = request_line.next().unwrap_or("");
    let path = request_line.next().unwrap_or("");
    let supplied_origin = request_header(request, "Origin");
    let origin = allowed_origin(request);

    if method == "GET" && path == "/health" {
        if supplied_origin.is_some() && origin.is_none() {
            return BridgeResponse::json_error(403, "origin is not allowed");
        }
        return BridgeResponse {
            status: 200,
            body: r#"{"ok":true,"service":"sotto-reveal"}"#.into(),
            allow_origin: origin,
        };
    }

    if path != "/reveal" {
        return BridgeResponse::json_error(404, "not found");
    }
    if origin.is_none() {
        return BridgeResponse::json_error(403, "origin is not allowed");
    }
    if method == "OPTIONS" {
        return BridgeResponse {
            status: 204,
            body: String::new(),
            allow_origin: origin,
        };
    }
    if method != "POST" {
        return BridgeResponse::cors_error(405, "method not allowed", origin);
    }
    if !request_header(request, "Content-Type")
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
    {
        return BridgeResponse::cors_error(
            400,
            "Content-Type must be application/json",
            origin,
        );
    }

    let result = parse_reveal_payload(request).and_then(|payload| {
        reveal_package(&payload.client_id, &payload.stable_id)
    });
    match result {
        Ok(path) => BridgeResponse {
            status: 200,
            body: format!(
                r#"{{"ok":true,"path":{}}}"#,
                serde_json::to_string(&path).unwrap_or_else(|_| "\"\"".into())
            ),
            allow_origin: origin,
        },
        Err(error) => BridgeResponse::cors_error(404, &error, origin),
    }
}

#[derive(Deserialize)]
struct RevealPayload {
    #[serde(rename = "clientId")]
    client_id: String,
    #[serde(rename = "stableId")]
    stable_id: String,
}

fn parse_reveal_payload(request: &str) -> Result<RevealPayload, String> {
    let body = request
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .filter(|body| !body.trim().is_empty())
        .ok_or_else(|| "Need clientId and stableId in the JSON body".to_string())?;
    let payload: RevealPayload = serde_json::from_str(body).map_err(|e| e.to_string())?;
    if payload.client_id.trim().is_empty() || payload.stable_id.trim().is_empty() {
        return Err("clientId and stableId must not be empty".into());
    }
    Ok(payload)
}

fn reveal_package(client_id: &str, stable_id: &str) -> Result<String, String> {
    let root = {
        let map = roots().lock().map_err(|e| e.to_string())?;
        map.get(client_id).cloned()
    };
    let root = root.ok_or_else(|| {
        "Desktop app has no source folder for this client — open the client in Sotto desktop first."
            .to_string()
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
        let exact_match = std::fs::read(&manifest)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|value| {
                value
                    .get("stable_id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
            .is_some_and(|manifest_id| manifest_id == stable_id);
        if exact_match {
            return Some(dir.to_path_buf());
        }
    }
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let name = path.file_name()?.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        if let Some(found) = find_stable_dir(&path, stable_id, depth + 1) {
            return Some(found);
        }
    }
    None
}

// The early `return`s are load-bearing across platforms, not needless: each cfg block must stop the
// function, or a build for one OS would fall through into the next block's command. Clippy only ever
// sees one configured branch, where the return looks like the tail expression it is not.
#[allow(clippy::needless_return)]
fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    // Package dirs: open *inside* the folder. Files: select in the parent.
    #[cfg(target_os = "macos")]
    {
        if path.is_dir() {
            Command::new("open")
                .arg(path)
                .status()
                .map_err(|e| e.to_string())?;
        } else {
            Command::new("open")
                .args(["-R", &path.to_string_lossy()])
                .status()
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        if path.is_dir() {
            Command::new("explorer")
                .arg(path)
                .status()
                .map_err(|e| e.to_string())?;
        } else {
            Command::new("explorer")
                .arg(format!("/select,{}", path.to_string_lossy()))
                .status()
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let target = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        Command::new("xdg-open")
            .arg(target)
            .status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn request(method: &str, path: &str, origin: &str, body: &str) -> String {
        format!(
            "{method} {path} HTTP/1.1\r\nOrigin: {origin}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
    }

    fn temp_root() -> PathBuf {
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("sotto-reveal-{}-{suffix}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn cors_allows_only_known_portals_and_post() {
        let preflight = request("OPTIONS", "/reveal", ALLOWED_ORIGINS[0], "");
        let response = handle_request(&preflight);
        assert_eq!(response.status, 204);
        assert_eq!(response.allow_origin.as_deref(), Some(ALLOWED_ORIGINS[0]));
        assert!(!response.to_http().contains("Access-Control-Allow-Origin: *"));

        let hostile = request("POST", "/reveal", "https://evil.test", "{}");
        assert_eq!(handle_request(&hostile).status, 403);

        let get = request("GET", "/reveal", ALLOWED_ORIGINS[0], "");
        assert_eq!(handle_request(&get).status, 405);
    }

    #[test]
    fn manifest_match_requires_valid_json_and_exact_stable_id() {
        let root = temp_root();
        let malformed = root.join("Malformed __deadbeef");
        std::fs::create_dir(&malformed).unwrap();
        std::fs::write(
            malformed.join(".dchub.json"),
            r#"not json but contains "stable_id" and deadbeef"#,
        )
        .unwrap();
        let wrong = root.join("Wrong __feedface");
        std::fs::create_dir(&wrong).unwrap();
        std::fs::write(wrong.join(".dchub.json"), r#"{"stable_id":"feedface-deadbeef"}"#).unwrap();

        assert_eq!(find_stable_dir(&root, "deadbeef", 0), None);

        let exact = root.join("Exact __deadbeef");
        std::fs::create_dir(&exact).unwrap();
        std::fs::write(exact.join(".dchub.json"), r#"{"stable_id":"deadbeef"}"#).unwrap();
        assert_eq!(find_stable_dir(&root, "deadbeef", 0), Some(exact));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn request_reader_collects_a_body_larger_than_one_chunk() {
        tauri::async_runtime::block_on(async {
            let padding = "x".repeat(9_000);
            let body = format!(r#"{{"clientId":"client","stableId":"deadbeef","padding":"{padding}"}}"#);
            let request = request("POST", "/reveal", ALLOWED_ORIGINS[0], &body);
            let (mut writer, mut reader) = tokio::io::duplex(32 * 1024);
            writer.write_all(request.as_bytes()).await.unwrap();
            drop(writer);

            let read = read_request(&mut reader).await.unwrap();
            assert_eq!(read, request);
            assert_eq!(parse_reveal_payload(&read).unwrap().stable_id, "deadbeef");
        });
    }
}
