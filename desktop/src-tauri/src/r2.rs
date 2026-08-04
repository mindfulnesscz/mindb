// Sprint 9 (deferred): replace hand-rolled SigV4 with aws-sdk-s3 or aws-sigv4 crate.
// See docs/pages/getting-started/platform-division.mdx — do not block feature work on this.
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
    (y.is_multiple_of(4) && !y.is_multiple_of(100)) || y.is_multiple_of(400)
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

// `extra_headers`: any headers beyond the fixed host/x-amz-content-sha256/x-amz-date base
// (e.g. content-type, x-amz-meta-sha256) — order doesn't matter, this function sorts them.
// SigV4 requires canonical headers sorted lexicographically by name.
//
// The parameter list is long because SigV4 signs exactly these inputs; grouping them into a struct
// would restate the same fields one layer away and make the call sites harder to read against the
// specification.
#[allow(clippy::too_many_arguments)]
fn sign(
    method:        &str,
    host:          &str,
    canonical_uri: &str,  // e.g. "/sotto-ess/thumbnails/foo.webp"
    query:         &str,  // e.g. "list-type=2&max-keys=0"
    body_hash:     &str,
    extra_headers: &[(&str, &str)],
    datetime:      &str,
    date:          &str,
    access_key_id: &str,
    secret_key:    &str,
) -> String {
    let mut headers: Vec<(&str, String)> = vec![
        ("host",                  host.to_string()),
        ("x-amz-content-sha256",  body_hash.to_string()),
        ("x-amz-date",            datetime.to_string()),
    ];
    for (k, v) in extra_headers { headers.push((k, v.to_string())); }
    headers.sort_by(|a, b| a.0.cmp(b.0));

    let canonical_headers: String = headers.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed_headers = headers.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(";");

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

// ── Shared reqwest client — keep-alive pool, one TLS handshake per host ──────

fn client() -> &'static reqwest::Client {
    static HTTP: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    HTTP.get_or_init(reqwest::Client::new)
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

/// Temporary credentials (Control API grants) must sign the session token as
/// an `x-amz-security-token` header on every request.
fn token_headers(session_token: Option<&str>) -> Vec<(&'static str, &str)> {
    match session_token {
        Some(t) => vec![("x-amz-security-token", t)],
        None    => vec![],
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct R2UploadResult {
    pub url:     String,
    pub skipped: bool,  // true when object already existed on R2 and upload was skipped
    pub sha256:  String, // content hash of the local file, for caller-side caching (avoids re-hashing unchanged files next run)
}

/// Reads back the `x-amz-meta-sha256` custom metadata header of an object via a signed
/// HEAD request, if the object exists and carries one. `None` covers both "doesn't exist"
/// and "exists but predates this metadata convention" — both mean "upload, don't skip."
async fn r2_object_meta_sha256(
    endpoint:      &str,
    bucket:        &str,
    object_key:    &str,
    access_key_id: &str,
    secret_key:    &str,
    session_token: Option<&str>,
) -> Result<Option<String>, String> {
    let (datetime, date) = utc_now();
    let host = host_from(endpoint);
    let canonical_uri = format!("/{}/{}", uri_encode(bucket, true), uri_encode(object_key, false));
    let extra = token_headers(session_token);
    let auth = sign("HEAD", host, &canonical_uri, "", EMPTY_HASH,
                    &extra, &datetime, &date, access_key_id, secret_key);

    let url = format!("{endpoint}/{bucket}/{object_key}");
    let mut rb = client()
        .head(&url)
        .header("host",                  host)
        .header("x-amz-date",           &datetime)
        .header("x-amz-content-sha256",  EMPTY_HASH)
        .header("authorization",         &auth);
    if let Some(t) = session_token { rb = rb.header("x-amz-security-token", t); }
    let res = rb
        .send()
        .await
        .map_err(|e| format!("R2 HEAD failed: {e}"))?;

    match res.status().as_u16() {
        200 => Ok(res.headers().get("x-amz-meta-sha256")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)),
        404 | 403 => Ok(None),   // 403 on R2 also means "doesn't exist" for missing keys
        s         => Err(format!("R2 HEAD unexpected status {s}")),
    }
}

/// Upload a local file to R2, skipping the upload if an object already at this key has the
/// same content (compared by sha256, stored as R2 object metadata — not by mere existence,
/// since some keys are intentionally stable across content changes, e.g. version bumps
/// reusing the same key; an existence-only check would silently skip those real updates).
/// Returns the public CDN URL and whether the upload was skipped.
///
/// `remote_exists`: caller's knowledge from an upfront LIST of the key prefix —
/// Some(false) means the key is definitely absent, so the HEAD round-trip is skipped
/// and the upload proceeds directly. None means unknown (HEAD as before).
/// `known_sha256`: the content hash the caller last uploaded to this key (from its
/// local cache) — if the file still hashes to it and the object hasn't vanished,
/// skip without a HEAD.
///
/// The argument list is the command's wire format: Tauri deserialises these by name from the
/// JavaScript call. A struct would move the same fields into a #[derive(Deserialize)] without
/// reducing anything.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn upload_to_r2(
    file_path:     String,
    object_key:    String,
    endpoint:      String,
    bucket:        String,
    access_key_id: String,
    secret_key:    String,
    public_domain: String,
    content_type:  String,
    remote_exists: Option<bool>,
    known_sha256:  Option<String>,
    session_token: Option<String>,
) -> Result<R2UploadResult, String> {
    let endpoint = endpoint.trim_end_matches('/');

    let body      = tokio::fs::read(&file_path).await.map_err(|e| format!("Cannot read {file_path}: {e}"))?;
    let body_hash = sha256_hex(&body);
    // Content-hash query so gallery URLs change when bytes change (version-stable keys
    // otherwise keep the same path and browsers serve a cached older image).
    let v = &body_hash[..12.min(body_hash.len())];
    let public_url = format!(
        "{}/{object_key}?v={v}",
        public_domain.trim_end_matches('/')
    );

    // Skip upload only if the object at this key already has this exact content.
    if remote_exists != Some(false) {
        if known_sha256.as_deref() == Some(body_hash.as_str()) {
            return Ok(R2UploadResult { url: public_url, skipped: true, sha256: body_hash });
        }
        let existing = r2_object_meta_sha256(endpoint, &bucket, &object_key, &access_key_id, &secret_key, session_token.as_deref()).await?;
        if existing.as_deref() == Some(body_hash.as_str()) {
            return Ok(R2UploadResult { url: public_url, skipped: true, sha256: body_hash });
        }
    }

    let (datetime, date) = utc_now();
    let host      = host_from(endpoint);
    // Long cache is safe: public URLs carry ?v=<content-hash>, so a new file gets a new URL.
    let cache_control = "public, max-age=31536000, immutable";

    let canonical_uri = format!("/{}/{}", uri_encode(&bucket, true), uri_encode(&object_key, false));
    let mut extra: Vec<(&str, &str)> = vec![
        ("cache-control", cache_control),
        ("content-type", &content_type),
        ("x-amz-meta-sha256", &body_hash),
    ];
    if let Some(ref t) = session_token { extra.push(("x-amz-security-token", t)); }
    let auth = sign("PUT", host, &canonical_uri, "", &body_hash,
                    &extra, &datetime, &date, &access_key_id, &secret_key);

    let url = format!("{endpoint}/{bucket}/{object_key}");
    let mut rb = client()
        .put(&url)
        .header("host",                  host)
        .header("x-amz-date",           &datetime)
        .header("x-amz-content-sha256", &body_hash)
        .header("cache-control",         cache_control)
        .header("content-type",          &content_type)
        .header("x-amz-meta-sha256",     &body_hash)
        .header("authorization",         &auth);
    if let Some(ref t) = session_token { rb = rb.header("x-amz-security-token", t); }
    let res = rb
        .body(body)
        .send()
        .await
        .map_err(|e| format!("R2 request failed: {e}"))?;

    if res.status().is_success() {
        Ok(R2UploadResult { url: public_url, skipped: false, sha256: body_hash })
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
    session_token: Option<String>,
) -> Result<String, String> {
    let (datetime, date) = utc_now();
    let endpoint  = endpoint.trim_end_matches('/');
    let host      = host_from(endpoint);

    // ListObjectsV2 with max-keys=0 — cheapest valid S3 call
    let query = "list-type=2&max-keys=0";
    let canonical_uri = format!("/{}", uri_encode(&bucket, true));
    let extra = token_headers(session_token.as_deref());
    let auth = sign("GET", host, &canonical_uri, query, EMPTY_HASH,
                    &extra, &datetime, &date, &access_key_id, &secret_key);

    let url = format!("{endpoint}/{bucket}?{query}");
    let mut rb = client()
        .get(&url)
        .header("host",                  host)
        .header("x-amz-date",           &datetime)
        .header("x-amz-content-sha256",  EMPTY_HASH)
        .header("authorization",         &auth);
    if let Some(ref t) = session_token { rb = rb.header("x-amz-security-token", t); }
    let res = rb
        .send()
        .await
        .map_err(|e| format!("Connection failed: {e}"))?;

    match res.status().as_u16() {
        200 => Ok("Connected".into()),
        403 => Err("Access denied — check Access Key ID and Secret.".into()),
        404 => Err(format!("Bucket \"{bucket}\" not found.")),
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
    session_token: Option<String>,
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

        let extra = token_headers(session_token.as_deref());
        let auth = sign("GET", host, &canonical_uri, &query, EMPTY_HASH,
                        &extra, &datetime, &date, &access_key_id, &secret_key);

        let url = format!("{endpoint}/{bucket}?{query}");
        let mut rb = client()
            .get(&url)
            .header("host",                  host)
            .header("x-amz-date",           &datetime)
            .header("x-amz-content-sha256",  EMPTY_HASH)
            .header("authorization",         &auth);
        if let Some(ref t) = session_token { rb = rb.header("x-amz-security-token", t); }
        let res = rb
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
    session_token: Option<String>,
) -> Result<(), String> {
    let (datetime, date) = utc_now();
    let endpoint  = endpoint.trim_end_matches('/');
    let host      = host_from(endpoint);

    let canonical_uri = format!("/{}/{}", uri_encode(&bucket, true), uri_encode(&object_key, false));
    let extra = token_headers(session_token.as_deref());
    let auth = sign("DELETE", host, &canonical_uri, "", EMPTY_HASH,
                    &extra, &datetime, &date, &access_key_id, &secret_key);

    let url = format!("{endpoint}/{bucket}/{object_key}");
    let mut rb = client()
        .delete(&url)
        .header("host",                  host)
        .header("x-amz-date",           &datetime)
        .header("x-amz-content-sha256",  EMPTY_HASH)
        .header("authorization",         &auth);
    if let Some(ref t) = session_token { rb = rb.header("x-amz-security-token", t); }
    let res = rb
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

// ── Tests ─────────────────────────────────────────────────────────────────────
//
// Everything below is pure: date arithmetic, URI encoding, XML scraping and the SigV4
// signer. All of it is hand-rolled (see the deferral note at the top of this file), and all
// of it sits on the request path — a wrong `x-amz-date` or a mis-encoded key makes every
// upload fail authentication, which surfaces to a user as "the CDN is broken" with no clue
// why. Cheap to test, expensive to get wrong.

#[cfg(test)]
mod tests {
    use super::*;

    /* ── Leap-year rules ──────────────────────────────────────────────────── */

    #[test]
    fn leap_years_follow_the_full_gregorian_rule() {
        assert!(is_leap(2024), "divisible by 4");
        assert!(!is_leap(2023), "not divisible by 4");
        assert!(is_leap(2000), "divisible by 400 — the rule a naive %4 check gets right by luck");
        assert!(!is_leap(1900), "divisible by 100 but not 400 — the rule a naive %4 check gets WRONG");
        assert!(!is_leap(2100), "the next century that is not a leap year");
        assert!(is_leap(2400));
    }

    /* ── Epoch → UTC date/time ────────────────────────────────────────────── */

    #[test]
    fn epoch_zero_is_the_unix_epoch() {
        assert_eq!(epoch_to_utc(0), ("19700101".into(), "000000".into()));
    }

    #[test]
    fn epoch_converts_a_known_timestamp() {
        // 2001-09-09T01:46:40Z — the widely-quoted 1e9 epoch.
        assert_eq!(epoch_to_utc(1_000_000_000), ("20010909".into(), "014640".into()));
    }

    #[test]
    fn epoch_handles_the_32_bit_rollover_moment() {
        // 2038-01-19T03:14:07Z. u64 arithmetic must not care, but assert it anyway.
        assert_eq!(epoch_to_utc(2_147_483_647), ("20380119".into(), "031407".into()));
    }

    #[test]
    fn epoch_lands_on_february_29_in_a_leap_year() {
        assert_eq!(epoch_to_utc(1_709_164_800).0, "20240229");
    }

    #[test]
    fn epoch_skips_february_29_in_a_common_year() {
        // 2025 is not a leap year: Feb 1 + 28 days is March 1, not Feb 29.
        assert_eq!(epoch_to_utc(1_740_787_200).0, "20250301");
    }

    #[test]
    fn epoch_honours_the_400_year_leap_exception() {
        // 2000-02-29 exists only because of the %400 rule.
        assert_eq!(epoch_to_utc(951_782_400).0, "20000229");
    }

    #[test]
    fn epoch_honours_the_100_year_leap_exception() {
        // 2100-02-29 does NOT exist, so Feb 1 + 28 days is March 1.
        assert_eq!(epoch_to_utc(4_107_542_400).0, "21000301");
    }

    #[test]
    fn epoch_keeps_time_of_day_zero_padded() {
        // 1970-01-01T01:02:03Z — a naive formatter would emit "123".
        assert_eq!(epoch_to_utc(3723), ("19700101".into(), "010203".into()));
    }

    #[test]
    fn epoch_rolls_over_the_last_second_of_a_year() {
        assert_eq!(epoch_to_utc(1_735_689_599), ("20241231".into(), "235959".into()));
        assert_eq!(epoch_to_utc(1_735_689_600), ("20250101".into(), "000000".into()));
    }

    #[test]
    fn days_to_ymd_is_one_indexed_for_month_and_day() {
        // Day 0 must be January 1st, not month 0 / day 0.
        assert_eq!(days_to_ymd(0), (1970, 1, 1));
        assert_eq!(days_to_ymd(31), (1970, 2, 1));
        assert_eq!(days_to_ymd(364), (1970, 12, 31));
        assert_eq!(days_to_ymd(365), (1971, 1, 1));
    }

    #[test]
    fn utc_now_returns_a_matching_datetime_and_date_pair() {
        // The signer passes both to `sign`; if they ever disagree the request is rejected
        // with an opaque SignatureDoesNotMatch.
        let (datetime, date) = utc_now();
        assert_eq!(datetime.len(), 16, "YYYYMMDDTHHMMSSZ");
        assert!(datetime.starts_with(&date));
        assert!(datetime.ends_with('Z'));
        assert_eq!(&datetime[8..9], "T");
    }

    /* ── URI encoding (S3 canonical form) ─────────────────────────────────── */

    #[test]
    fn uri_encode_leaves_unreserved_characters_alone() {
        assert_eq!(uri_encode("AZaz09-_.~", true), "AZaz09-_.~");
    }

    #[test]
    fn uri_encode_keeps_slashes_in_a_path_but_escapes_them_in_a_query() {
        let key = "thumbnails/a1b2c3d4/c1.webp";
        assert_eq!(uri_encode(key, false), key);
        assert_eq!(uri_encode(key, true), "thumbnails%2Fa1b2c3d4%2Fc1.webp");
    }

    #[test]
    fn uri_encode_escapes_spaces_as_percent_20_not_plus() {
        // A '+' here would be silently interpreted as a space by some servers and as a
        // literal plus by S3 — the classic canonical-request mismatch.
        assert_eq!(uri_encode("Product Slides Deck.pdf", false), "Product%20Slides%20Deck.pdf");
    }

    #[test]
    fn uri_encode_escapes_a_literal_plus() {
        assert_eq!(uri_encode("a+b", false), "a%2Bb");
    }

    #[test]
    fn uri_encode_escapes_the_bracket_tags_real_filenames_carry() {
        // Translated deliverables routinely look like "(PRD)(SlD) Deck v2.pdf".
        assert_eq!(
            uri_encode("(PRD)(SlD) Deck v2.pdf", false),
            "%28PRD%29%28SlD%29%20Deck%20v2.pdf",
        );
    }

    #[test]
    fn uri_encode_escapes_multibyte_utf8_per_byte() {
        // Client folder names contain accented characters ("Deda Energie", "Mucha Family"
        // are tame; "Šumava" is not). Each UTF-8 byte gets its own %XX.
        assert_eq!(uri_encode("ü", false), "%C3%BC");
        assert_eq!(uri_encode("é", false), "%C3%A9");
        assert_eq!(uri_encode("🚫", false), "%F0%9F%9A%AB");
    }

    #[test]
    fn uri_encode_uses_uppercase_hex() {
        // Lowercase hex is a valid URL but a DIFFERENT canonical request, so the signature
        // would not match what S3 recomputes.
        assert_eq!(uri_encode("~!", false), "~%21");
        assert!(!uri_encode("ü", false).contains("c3"));
    }

    #[test]
    fn uri_encode_handles_the_empty_string() {
        assert_eq!(uri_encode("", true), "");
    }

    /* ── Endpoint host extraction ─────────────────────────────────────────── */

    #[test]
    fn host_from_strips_either_scheme() {
        assert_eq!(host_from("https://acct.r2.cloudflarestorage.com"), "acct.r2.cloudflarestorage.com");
        assert_eq!(host_from("http://localhost:9000"), "localhost:9000");
    }

    #[test]
    fn host_from_passes_through_a_bare_host() {
        assert_eq!(host_from("acct.r2.cloudflarestorage.com"), "acct.r2.cloudflarestorage.com");
    }

    /* ── XML scraping ─────────────────────────────────────────────────────── */

    #[test]
    fn extract_xml_text_reads_every_occurrence_in_order() {
        let xml = "<ListBucketResult><Contents><Key>a/1.webp</Key></Contents>\
                   <Contents><Key>a/2.webp</Key></Contents></ListBucketResult>";
        assert_eq!(extract_xml_text(xml, "Key"), vec!["a/1.webp", "a/2.webp"]);
    }

    #[test]
    fn extract_xml_text_returns_empty_when_the_tag_is_absent() {
        assert_eq!(extract_xml_text("<ListBucketResult/>", "Key"), Vec::<&str>::new());
    }

    #[test]
    fn extract_xml_text_stops_at_an_unclosed_tag_instead_of_looping() {
        // A truncated response must terminate, not spin or panic.
        assert_eq!(extract_xml_text("<Key>a</Key><Key>truncated", "Key"), vec!["a"]);
    }

    #[test]
    fn extract_xml_text_yields_an_empty_string_for_an_empty_element() {
        assert_eq!(extract_xml_text("<Key></Key>", "Key"), vec![""]);
    }

    /* ── Session-token headers ────────────────────────────────────────────── */

    #[test]
    fn token_headers_are_present_only_for_temporary_credentials() {
        // R2 Control API grants are temporary and MUST sign x-amz-security-token; permanent
        // keys must NOT send it, or the request is rejected.
        assert_eq!(token_headers(Some("tok")), vec![("x-amz-security-token", "tok")]);
        assert!(token_headers(None).is_empty());
    }

    /* ── Hashing and key derivation ───────────────────────────────────────── */

    #[test]
    fn sha256_of_empty_input_matches_the_empty_hash_constant() {
        // EMPTY_HASH is hardcoded and used as the body hash of every GET/DELETE.
        assert_eq!(sha256_hex(b""), EMPTY_HASH);
    }

    #[test]
    fn sha256_hex_is_lowercase_hex_of_the_right_length() {
        let h = sha256_hex(b"sotto");
        assert_eq!(h.len(), 64);
        assert!(h.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }

    #[test]
    fn derive_signing_key_matches_the_published_aws_test_vector() {
        // From the AWS SigV4 documentation's worked example. This pins the whole
        // HMAC chain (AWS4 prefix → date → region → service → aws4_request).
        let key = derive_signing_key(
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "20150830",
            "us-east-1",
            "iam",
        );
        assert_eq!(
            hex::encode(key),
            "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9",
        );
    }

    /* ── The signer ───────────────────────────────────────────────────────── */

    fn sign_fixture(extra: &[(&str, &str)], body_hash: &str) -> String {
        sign(
            "PUT", "acct.r2.cloudflarestorage.com", "/bucket/thumbnails/a1b2c3d4/c1.webp", "",
            body_hash, extra, "20260729T101112Z", "20260729", "AKIDEXAMPLE", "secret",
        )
    }

    #[test]
    fn sign_produces_a_credential_scope_for_r2s_auto_region() {
        let auth = sign_fixture(&[], EMPTY_HASH);
        assert!(auth.starts_with("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260729/auto/s3/aws4_request"));
    }

    #[test]
    fn sign_lists_signed_headers_sorted_and_lowercase() {
        // SigV4 requires the SignedHeaders list to be sorted; `sign` must sort whatever
        // order the caller passed its extra headers in.
        let auth = sign_fixture(&[("x-amz-meta-sha256", "abc"), ("content-type", "image/webp")], EMPTY_HASH);
        let signed = auth
            .split("SignedHeaders=").nth(1).unwrap()
            .split(',').next().unwrap();
        assert_eq!(signed, "content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256");
    }

    #[test]
    fn sign_is_order_independent_for_extra_headers() {
        let a = sign_fixture(&[("content-type", "image/webp"), ("x-amz-meta-sha256", "abc")], EMPTY_HASH);
        let b = sign_fixture(&[("x-amz-meta-sha256", "abc"), ("content-type", "image/webp")], EMPTY_HASH);
        assert_eq!(a, b);
    }

    #[test]
    fn sign_is_deterministic_for_identical_input() {
        assert_eq!(sign_fixture(&[], EMPTY_HASH), sign_fixture(&[], EMPTY_HASH));
    }

    #[test]
    fn sign_changes_when_the_body_hash_changes() {
        // The body hash is part of the canonical request; a signature that ignored it would
        // let a tampered payload through.
        let a = sign_fixture(&[], EMPTY_HASH);
        let b = sign_fixture(&[], &sha256_hex(b"different content"));
        assert_ne!(a, b);
    }

    #[test]
    fn sign_includes_the_security_token_in_signed_headers_when_present() {
        let auth = sign_fixture(&token_headers(Some("session-token")), EMPTY_HASH);
        assert!(auth.contains("x-amz-security-token"));
        assert!(!sign_fixture(&[], EMPTY_HASH).contains("x-amz-security-token"));
    }

    #[test]
    fn sign_emits_a_64_hex_character_signature() {
        let auth = sign_fixture(&[], EMPTY_HASH);
        let sig = auth.split("Signature=").nth(1).unwrap();
        assert_eq!(sig.len(), 64);
        assert!(sig.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
