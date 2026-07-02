use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

const EMPTY_HASH: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const REGION:     &str = "auto"; // Cloudflare R2 uses "auto"

// ── Crypto helpers ────────────────────────────────────────────────────────────

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn derive_signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let date_key    = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let region_key  = hmac_sha256(&date_key,  region.as_bytes());
    let service_key = hmac_sha256(&region_key, service.as_bytes());
    hmac_sha256(&service_key, b"aws4_request")
}

// ── UTC timestamp ─────────────────────────────────────────────────────────────

fn utc_now() -> (String, String) {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (date, time) = epoch_to_utc(secs);
    (format!("{}T{}Z", date, time), date)
}

fn epoch_to_utc(mut secs: u64) -> (String, String) {
    let s = secs % 60; secs /= 60;
    let m = secs % 60; secs /= 60;
    let h = secs % 24; secs /= 24;
    let (y, mo, d) = days_to_ymd(secs);
    (format!("{y:04}{mo:02}{d:02}"), format!("{h:02}{m:02}{s:02}"))
}

fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    let mut y = 1970u64;
    loop {
        let ydays = if is_leap(y) { 366 } else { 365 };
        if days < ydays { break; }
        days -= ydays;
        y += 1;
    }
    let mdays = [31u64, if is_leap(y) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut mo = 1u64;
    for &md in &mdays {
        if days < md { break; }
        days -= md;
        mo += 1;
    }
    (y, mo, days + 1)
}

fn is_leap(y: u64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

// ── URI encoding ──────────────────────────────────────────────────────────────

fn uri_encode(s: &str, encode_slash: bool) -> String {
    s.bytes().flat_map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
        | b'-' | b'_' | b'.' | b'~' => vec![b as char],
        b'/' if !encode_slash        => vec!['/'],
        b                            => format!("%{b:02X}").chars().collect(),
    }).collect()
}

// ── Generic SigV4 signer ──────────────────────────────────────────────────────
//
// `query` must be a pre-sorted canonical query string (param names URI-encoded,
// values URI-encoded, sorted by name then value, joined with `&`).
// `content_type` is Some for PUT, None for GET/DELETE.

fn sign(
    method:        &str,
    host:          &str,
    canonical_uri: &str,  // e.g. "/dc-hub-ess/thumbnails/foo.webp"
    query:         &str,  // e.g. "list-type=2&max-keys=0"
    body_hash:     &str,
    content_type:  Option<&str>,
    datetime:      &str,
    date:          &str,
    access_key_id: &str,
    secret_key:    &str,
) -> String {
    let (canonical_headers, signed_headers) = if let Some(ct) = content_type {
        (
            format!("content-type:{ct}\nhost:{host}\nx-amz-content-sha256:{body_hash}\nx-amz-date:{datetime}\n"),
            "content-type;host;x-amz-content-sha256;x-amz-date",
        )
    } else {
        (
            format!("host:{host}\nx-amz-content-sha256:{body_hash}\nx-amz-date:{datetime}\n"),
            "host;x-amz-content-sha256;x-amz-date",
        )
    };

    let canonical_request = format!(
        "{method}\n{canonical_uri}\n{query}\n{canonical_headers}\n{signed_headers}\n{body_hash}"
    );

    let scope          = format!("{date}/{REGION}/s3/aws4_request");
    let cr_hash        = sha256_hex(canonical_request.as_bytes());
    let string_to_sign = format!("AWS4-HMAC-SHA256\n{datetime}\n{scope}\n{cr_hash}");

    let signing_key = derive_signing_key(secret_key, date, REGION, "s3");
    let signature   = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes()));

    format!("AWS4-HMAC-SHA256 Credential={access_key_id}/{scope},SignedHeaders={signed_headers},Signature={signature}")
}

// ── Shared reqwest client builder ─────────────────────────────────────────────

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

fn host_from(endpoint: &str) -> &str {
    endpoint
        .trim_start_matches("https://")
        .trim_start_matches("http://")
}

// ── XML key extraction (no xml crate needed) ──────────────────────────────────

fn extract_xml_text<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open  = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(s) = rest.find(&*open) {
        rest = &rest[s + open.len()..];
        if let Some(e) = rest.find(&*close) {
            out.push(&rest[..e]);
            rest = &rest[e + close.len()..];
        } else { break; }
    }
    out
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct R2UploadResult {
    pub url:     String,
    pub skipped: bool,  // true when object already existed on R2 and upload was skipped
}

/// Check whether an object already exists in R2 using a signed HEAD request.
async fn r2_object_exists(
    endpoint:      &str,
    bucket:        &str,
    object_key:    &str,
    access_key_id: &str,
    secret_key:    &str,
) -> Result<bool, String> {
    let (datetime, date) = utc_now();
    let host = host_from(endpoint);
    let canonical_uri = format!("/{}/{}", uri_encode(bucket, true), uri_encode(object_key, false));
    let auth = sign("HEAD", host, &canonical_uri, "", EMPTY_HASH,
                    None, &datetime, &date, access_key_id, secret_key);

    let url = format!("{endpoint}/{bucket}/{object_key}");
    let res = client()
        .head(&url)
        .header("host",                  host)
        .header("x-amz-date",           &datetime)
        .header("x-amz-content-sha256",  EMPTY_HASH)
        .header("authorization",         &auth)
        .send()
        .await
        .map_err(|e| format!("R2 HEAD failed: {e}"))?;

    match res.status().as_u16() {
        200       => Ok(true),
        404 | 403 => Ok(false),   // 403 on R2 also means "doesn't exist" for missing keys
        s         => Err(format!("R2 HEAD unexpected status {s}")),
    }
}

/// Upload a local file to R2. Skips the upload if the object already exists.
/// Returns the public CDN URL and whether the upload was skipped.
#[tauri::command]
pub async fn upload_to_r2(
    file_path:     String,
    object_key:    String,
    endpoint:      String,
    bucket:        String,
    access_key_id: String,
    secret_key:    String,
    public_domain: String,
) -> Result<R2UploadResult, String> {
    let endpoint = endpoint.trim_end_matches('/');
    let public_url = format!("{}/{object_key}", public_domain.trim_end_matches('/'));

    // Skip upload if the object is already on R2
    if r2_object_exists(endpoint, &bucket, &object_key, &access_key_id, &secret_key).await? {
        return Ok(R2UploadResult { url: public_url, skipped: true });
    }

    let body      = std::fs::read(&file_path).map_err(|e| format!("Cannot read {file_path}: {e}"))?;
    let body_hash = sha256_hex(&body);
    let (datetime, date) = utc_now();
    let host      = host_from(endpoint);

    let canonical_uri = format!("/{}/{}", uri_encode(&bucket, true), uri_encode(&object_key, false));
    let auth = sign("PUT", host, &canonical_uri, "", &body_hash,
                    Some("image/webp"), &datetime, &date, &access_key_id, &secret_key);

    let url = format!("{endpoint}/{bucket}/{object_key}");
    let res = client()
        .put(&url)
        .header("host",                  host)
        .header("x-amz-date",           &datetime)
        .header("x-amz-content-sha256", &body_hash)
        .header("content-type",          "image/webp")
        .header("authorization",         &auth)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("R2 request failed: {e}"))?;

    if res.status().is_success() {
        Ok(R2UploadResult { url: public_url, skipped: false })
    } else {
        let status = res.status();
        let body   = res.text().await.unwrap_or_default();
        Err(format!("R2 upload failed ({status}): {body}"))
    }
}

/// Check that the R2 credentials and bucket are reachable.
/// Returns Ok("Connected") or Err(reason).
#[tauri::command]
pub async fn check_r2_connection(
    endpoint:      String,
    bucket:        String,
    access_key_id: String,
    secret_key:    String,
) -> Result<String, String> {
    let (datetime, date) = utc_now();
    let endpoint  = endpoint.trim_end_matches('/');
    let host      = host_from(endpoint);

    // ListObjectsV2 with max-keys=0 — cheapest valid S3 call
    let query = "list-type=2&max-keys=0";
    let canonical_uri = format!("/{}", uri_encode(&bucket, true));
    let auth = sign("GET", host, &canonical_uri, query, EMPTY_HASH,
                    None, &datetime, &date, &access_key_id, &secret_key);

    let url = format!("{endpoint}/{bucket}?{query}");
    let res = client()
        .get(&url)
        .header("host",                  host)
        .header("x-amz-date",           &datetime)
        .header("x-amz-content-sha256",  EMPTY_HASH)
        .header("authorization",         &auth)
        .send()
        .await
        .map_err(|e| format!("Connection failed: {e}"))?;

    match res.status().as_u16() {
        200 => Ok("Connected".into()),
        403 => Err("Access denied — check Access Key ID and Secret.".into()),
        404 => Err(format!("Bucket \"{bucket}\" not found.").into()),
        s   => {
            let body = res.text().await.unwrap_or_default();
            Err(format!("HTTP {s}: {body}"))
        }
    }
}

/// List all object keys in the bucket under `prefix` (e.g. "thumbnails/").
/// Handles S3 pagination automatically.
#[tauri::command]
pub async fn list_r2_keys(
    endpoint:      String,
    bucket:        String,
    access_key_id: String,
    secret_key:    String,
    prefix:        String,
) -> Result<Vec<String>, String> {
    let endpoint = endpoint.trim_end_matches('/');
    let host     = host_from(endpoint);
    let canonical_uri = format!("/{}", uri_encode(&bucket, true));
    let encoded_prefix = uri_encode(&prefix, true);
    let mut keys: Vec<String> = Vec::new();
    let mut continuation: Option<String> = None;

    loop {
        let (datetime, date) = utc_now();

        // Build canonical query — parameters MUST be sorted by name
        let query = if let Some(ref token) = continuation {
            // c < l < m < p
            format!("continuation-token={}&list-type=2&max-keys=1000&prefix={}",
                uri_encode(token, true), encoded_prefix)
        } else {
            // l < m < p
            format!("list-type=2&max-keys=1000&prefix={}", encoded_prefix)
        };

        let auth = sign("GET", host, &canonical_uri, &query, EMPTY_HASH,
                        None, &datetime, &date, &access_key_id, &secret_key);

        let url = format!("{endpoint}/{bucket}?{query}");
        let res = client()
            .get(&url)
            .header("host",                  host)
            .header("x-amz-date",           &datetime)
            .header("x-amz-content-sha256",  EMPTY_HASH)
            .header("authorization",         &auth)
            .send()
            .await
            .map_err(|e| format!("R2 list failed: {e}"))?;

        if !res.status().is_success() {
            let status = res.status();
            let body   = res.text().await.unwrap_or_default();
            return Err(format!("R2 list failed ({status}): {body}"));
        }

        let xml = res.text().await.map_err(|e| e.to_string())?;
        for k in extract_xml_text(&xml, "Key") {
            keys.push(k.to_string());
        }

        // Check for next page
        let truncated = extract_xml_text(&xml, "IsTruncated")
            .first().copied().unwrap_or("false");
        if truncated == "true" {
            continuation = extract_xml_text(&xml, "NextContinuationToken")
                .first().map(|s| s.to_string());
            if continuation.is_none() { break; }
        } else {
            break;
        }
    }

    Ok(keys)
}

/// Delete a single object from R2 by key.
#[tauri::command]
pub async fn delete_r2_object(
    endpoint:      String,
    bucket:        String,
    access_key_id: String,
    secret_key:    String,
    object_key:    String,
) -> Result<(), String> {
    let (datetime, date) = utc_now();
    let endpoint  = endpoint.trim_end_matches('/');
    let host      = host_from(endpoint);

    let canonical_uri = format!("/{}/{}", uri_encode(&bucket, true), uri_encode(&object_key, false));
    let auth = sign("DELETE", host, &canonical_uri, "", EMPTY_HASH,
                    None, &datetime, &date, &access_key_id, &secret_key);

    let url = format!("{endpoint}/{bucket}/{object_key}");
    let res = client()
        .delete(&url)
        .header("host",                  host)
        .header("x-amz-date",           &datetime)
        .header("x-amz-content-sha256",  EMPTY_HASH)
        .header("authorization",         &auth)
        .send()
        .await
        .map_err(|e| format!("R2 delete failed: {e}"))?;

    if res.status().is_success() || res.status().as_u16() == 204 {
        Ok(())
    } else {
        let status = res.status();
        let body   = res.text().await.unwrap_or_default();
        Err(format!("R2 delete failed ({status}): {body}"))
    }
}
