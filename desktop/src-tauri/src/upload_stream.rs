/* Send a file — or one byte range of it — as a request body, without ever holding it in memory.
 *
 * WHY THIS EXISTS. Every provider upload used to buffer the whole deliverable before sending it,
 * just in different places. Drive and OneDrive pulled the bytes across the IPC bridge into the
 * webview (`readFile()`) and posted them from there, so a 500 MB video was copied twice and resident
 * in the webview for the length of the transfer. Dropbox looked like the exception and was not: it
 * ran natively, but `std::fs::read` put the same 500 MB in a `Vec<u8>` and the chunked session then
 * copied each 48 MB slice again. "Native" was buying a smaller copy, not no copy.
 *
 * This is the one place bytes move now. The JS modules keep everything that is actually provider
 * knowledge — auth, folder resolution, the skip decision, which upload shape a file needs, the exact
 * URL and headers — and hand the transfer down. Memory here is one 8 KiB read buffer regardless of
 * file size.
 *
 * ── THE DESTINATION IS BOUND, DELIBERATELY ───────────────────────────────────────────────────────
 *
 * This command reads a file the path policy allows and sends it, with caller-supplied headers, to a
 * caller-supplied URL. Unbound, that is an exfiltration primitive: anything that can reach the IPC
 * bridge could post a client's originals anywhere, carrying an `Authorization` header the app
 * supplied. `supabase_request` is bound to the active origin for exactly this reason, and the same
 * rule applies to every native proxy added after it.
 *
 * So the host is checked against `UPLOAD_HOSTS` before a single byte is read, and the list mirrors
 * the desktop CSP's `connect-src`. Widening it is a deliberate act with a reason written down —
 * never a fix for "the upload failed".
 */

use std::io::SeekFrom;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

/// Hosts a file may be streamed to. An entry matches the host exactly or as a dot-suffix, so
/// `googleapis.com` covers `www.googleapis.com` and the resumable session host Drive hands back,
/// and `sharepoint.com` covers a tenant's `contoso-my.sharepoint.com` upload session.
///
/// Kept in step with `connect-src` in `tauri.conf.json`. The one deliberate difference is
/// `content.dropboxapi.com`: the webview is not allowed to reach it and does not need to, because
/// Dropbox uploads have always gone through Rust.
const UPLOAD_HOSTS: &[&str] = &[
    "content.dropboxapi.com",
    "googleapis.com",
    "graph.microsoft.com",
    "1drv.com",
    "sharepoint.com",
];

/// `true` when `url` is an HTTPS address at an allowed upload host.
///
/// HTTPS is required rather than assumed: these requests carry a bearer token and a client's
/// deliverable, and a caller that built an `http://` URL by accident would send both in the clear.
pub fn upload_host_allowed(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else { return false };
    if parsed.scheme() != "https" {
        return false;
    }
    let Some(host) = parsed.host_str() else { return false };
    let host = host.to_ascii_lowercase();
    UPLOAD_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

#[derive(serde::Serialize, Debug)]
pub struct CloudUploadResponse {
    pub status: u16,
    pub body:   String,
}

impl CloudUploadResponse {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Stream `length` bytes of `path` starting at `offset` as the body of one request.
///
/// Separate from the command so the streaming itself can be tested against a real socket without
/// standing up an HTTPS host — the host check belongs to the command, not to the transfer.
pub async fn send_file_stream(
    url:      &str,
    method:   &str,
    headers:  &[(String, String)],
    path:     &std::path::Path,
    offset:   u64,
    length:   Option<u64>,
) -> Result<CloudUploadResponse, String> {
    let method = match method.to_ascii_uppercase().as_str() {
        "PUT"   => reqwest::Method::PUT,
        "POST"  => reqwest::Method::POST,
        "PATCH" => reqwest::Method::PATCH,
        other   => return Err(format!("Unsupported upload method: {other}")),
    };

    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    let total = file
        .metadata()
        .await
        .map_err(|e| format!("Cannot stat {}: {e}", path.display()))?
        .len();

    /* The range is validated against the file rather than trusted. A chunked session declares
       `Content-Range: bytes a-b/total` and the provider matches it against what actually arrives —
       a body one byte short of its declared length does not fail, it HANGS, waiting for a byte that
       is never coming. Catching it here turns that into an error with a number in it. */
    if offset > total {
        return Err(format!(
            "Upload range starts past the end of {} ({offset} > {total})", path.display(),
        ));
    }
    let length = length.unwrap_or(total - offset);
    if offset + length > total {
        return Err(format!(
            "Upload range {offset}+{length} exceeds {} ({total} bytes)", path.display(),
        ));
    }

    if offset > 0 {
        file.seek(SeekFrom::Start(offset))
            .await
            .map_err(|e| format!("Cannot seek {} to {offset}: {e}", path.display()))?;
    }

    let body = reqwest::Body::wrap_stream(ReaderStream::new(file.take(length)));

    let mut request = reqwest::Client::new().request(method, url);
    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }
    /* Set explicitly, and last, so it cannot be overridden by a caller's header. A streaming body
       has no length hyper can infer, so without this the request goes out chunked — which Graph's
       upload sessions and Drive's resumable PUT both reject. */
    request = request.header(reqwest::header::CONTENT_LENGTH, length);

    let res = request
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Upload request to {url} failed: {e}"))?;

    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();
    Ok(CloudUploadResponse { status, body })
}

/// Stream a local file to one of the provider upload endpoints.
///
/// `offset`/`length` address one chunk of a resumable session; omitting both sends the whole file.
/// `async fn` rather than `#[tauri::command(async)]` on purpose: every wait in here is real async
/// I/O, so it belongs on the runtime — the rule about blocking commands is about work that pins a
/// thread, which this does not.
#[tauri::command]
pub async fn cloud_upload_stream(
    app:       tauri::AppHandle,
    url:       String,
    method:    String,
    headers:   Vec<(String, String)>,
    file_path: String,
    offset:    Option<u64>,
    length:    Option<u64>,
) -> Result<CloudUploadResponse, String> {
    if !upload_host_allowed(&url) {
        return Err(format!(
            "Refusing to upload to {url}: not an allowed provider upload host. \
             If a provider has moved endpoint, add it to UPLOAD_HOSTS and to the desktop CSP.",
        ));
    }
    let path = crate::path_policy::require_allowed_file(&app, &file_path, "cloud upload source")?;
    send_file_stream(&url, &method, &headers, &path, offset.unwrap_or(0), length).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    #[test]
    fn allows_each_provider_upload_host() {
        for url in [
            "https://content.dropboxapi.com/2/files/upload",
            "https://www.googleapis.com/upload/drive/v3/files",
            "https://googleapis.com/upload/drive/v3/files",
            "https://graph.microsoft.com/v1.0/me/drive/root:/a.pdf:/content",
            "https://abc-my.sharepoint.com/_api/upload/session",
            "https://xyz.up.1drv.com/rup/session",
        ] {
            assert!(upload_host_allowed(url), "{url}");
        }
    }

    #[test]
    fn refuses_anything_that_is_not_a_provider_upload_host() {
        /* The point of the list. Each of these is a way a bug or a compromised caller could turn a
           file-streaming command into a way to post a client's originals somewhere else, with an
           Authorization header the app supplied. */
        for url in [
            "https://evil.example.com/collect",
            // Suffix matching must not be substring matching.
            "https://googleapis.com.evil.example/upload",
            "https://notsharepoint.com/upload",
            "https://sharepoint.com.attacker.net/x",
            // Plaintext, even to a real host: bearer token and bytes in the clear.
            "http://graph.microsoft.com/v1.0/me/drive",
            // Non-HTTP schemes and unparseable input.
            "file:///etc/passwd",
            "not a url",
            "",
        ] {
            assert!(!upload_host_allowed(url), "{url}");
        }
    }

    #[test]
    fn matches_the_host_case_insensitively() {
        // Hosts are case-insensitive in DNS; a mixed-case URL is valid and must not be refused.
        assert!(upload_host_allowed("https://WWW.GoogleAPIs.com/upload/drive/v3/files"));
    }

    /// Read one HTTP request off a socket and answer 200. Returns the request's headers (lowercased
    /// names) and its body, so a test can assert what actually went over the wire.
    async fn capture_one_request(
        listener: TcpListener,
    ) -> (std::collections::HashMap<String, String>, Vec<u8>) {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0_u8; 4096];

        // Headers first, then exactly Content-Length bytes of body.
        let head_end = loop {
            let read = socket.read(&mut chunk).await.unwrap();
            buf.extend_from_slice(&chunk[..read]);
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
            assert!(read > 0, "connection closed before the headers were complete");
        };

        let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
        let headers: std::collections::HashMap<String, String> = head
            .lines()
            .skip(1)
            .filter_map(|line| line.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
            .collect();

        let content_length: usize =
            headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
        let mut body = buf[head_end..].to_vec();
        while body.len() < content_length {
            let read = socket.read(&mut chunk).await.unwrap();
            assert!(read > 0, "connection closed with {} of {content_length} bytes", body.len());
            body.extend_from_slice(&chunk[..read]);
        }

        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").await.unwrap();
        socket.flush().await.unwrap();
        (headers, body)
    }

    async fn stream_to_socket(
        contents: &[u8],
        offset:   u64,
        length:   Option<u64>,
        headers:  &[(String, String)],
    ) -> (std::collections::HashMap<String, String>, Vec<u8>, CloudUploadResponse) {
        let dir = std::env::temp_dir().join(format!("sotto-upload-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("body-{offset}-{}.bin", contents.len()));
        std::fs::write(&path, contents).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/upload", listener.local_addr().unwrap());
        let server = tokio::spawn(capture_one_request(listener));

        let res = send_file_stream(&url, "PUT", headers, &path, offset, length).await.unwrap();
        let (sent_headers, sent_body) = server.await.unwrap();
        std::fs::remove_file(&path).ok();
        (sent_headers, sent_body, res)
    }

    #[tokio::test]
    async fn sends_the_whole_file_with_a_real_content_length() {
        /* The half of this that cannot be reasoned about, only observed: a streaming body has no
           length hyper can infer, so without an explicit Content-Length the request goes out with
           `Transfer-Encoding: chunked` — which Graph's upload sessions and Drive's resumable PUT
           reject. This asserts the bytes on the wire, not the intent. */
        let contents: Vec<u8> = (0..5000_u32).map(|i| i as u8).collect();
        let (headers, body, res) = stream_to_socket(&contents, 0, None, &[]).await;

        assert!(res.ok());
        assert_eq!(headers.get("content-length").map(String::as_str), Some("5000"));
        assert!(!headers.contains_key("transfer-encoding"));
        assert_eq!(body, contents);
    }

    #[tokio::test]
    async fn sends_exactly_the_requested_range() {
        // What a chunked session depends on: the bytes sent must be the ones the Content-Range
        // header claims, or the provider stalls waiting for a byte that is never coming.
        let contents: Vec<u8> = (0..5000_u32).map(|i| i as u8).collect();
        let (headers, body, _) = stream_to_socket(
            &contents, 1000, Some(2500),
            &[("Content-Range".into(), "bytes 1000-3499/5000".into())],
        ).await;

        assert_eq!(headers.get("content-length").map(String::as_str), Some("2500"));
        assert_eq!(headers.get("content-range").map(String::as_str), Some("bytes 1000-3499/5000"));
        assert_eq!(body, contents[1000..3500]);
    }

    #[tokio::test]
    async fn sends_the_tail_when_only_an_offset_is_given() {
        let contents: Vec<u8> = (0..300_u32).map(|i| i as u8).collect();
        let (headers, body, _) = stream_to_socket(&contents, 250, None, &[]).await;

        assert_eq!(headers.get("content-length").map(String::as_str), Some("50"));
        assert_eq!(body, contents[250..]);
    }

    #[tokio::test]
    async fn refuses_a_range_that_runs_past_the_end_instead_of_sending_a_short_body() {
        let dir = std::env::temp_dir().join(format!("sotto-upload-short-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("small.bin");
        std::fs::write(&path, b"12345").unwrap();

        let err = send_file_stream("https://content.dropboxapi.com/x", "PUT", &[], &path, 2, Some(99))
            .await
            .unwrap_err();
        assert!(err.contains("exceeds"), "{err}");

        let err = send_file_stream("https://content.dropboxapi.com/x", "PUT", &[], &path, 50, None)
            .await
            .unwrap_err();
        assert!(err.contains("past the end"), "{err}");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn refuses_a_method_that_is_not_an_upload() {
        let path = std::env::temp_dir().join("sotto-upload-method.bin");
        std::fs::write(&path, b"x").unwrap();
        let err = send_file_stream("https://content.dropboxapi.com/x", "DELETE", &[], &path, 0, None)
            .await
            .unwrap_err();
        assert!(err.contains("Unsupported upload method"), "{err}");
        std::fs::remove_file(&path).ok();
    }
}
