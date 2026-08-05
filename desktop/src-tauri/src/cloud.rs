use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(serde::Serialize)]
pub struct DropboxUploadResult {
    pub url:     Option<String>,
    pub skipped: bool,  // true when file already existed on Dropbox and upload was skipped
}

/// Returns true if a file exists at remote_path on Dropbox.
async fn dropbox_file_exists(
    client:       &reqwest::Client,
    access_token: &str,
    remote_path:  &str,
) -> Result<bool, String> {
    let res = client
        .post("https://api.dropboxapi.com/2/files/get_metadata")
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .header(CONTENT_TYPE, "application/json")
        .body(json!({"path": remote_path}).to_string())
        .send()
        .await
        .map_err(|e| format!("Dropbox metadata check failed: {e}"))?;

    if res.status().is_success() {
        return Ok(true);
    }
    // 409 with path/not_found means the file simply doesn't exist yet
    if res.status().as_u16() == 409 {
        return Ok(false);
    }
    let status = res.status().as_u16();
    let body   = res.text().await.unwrap_or_default();
    Err(format!("Dropbox metadata check failed ({status}): {body}"))
}

/// Fetch the first existing shared link for a file via list_shared_links.
async fn dropbox_list_sharing_link(
    client:       &reqwest::Client,
    access_token: &str,
    remote_path:  &str,
) -> Result<Option<String>, String> {
    let body = json!({ "path": remote_path, "direct_only": true }).to_string();

    let res = client
        .post("https://api.dropboxapi.com/2/sharing/list_shared_links")
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .header(CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Dropbox list_shared_links failed: {e}"))?;

    let status = res.status().as_u16();
    let text   = res.text().await.unwrap_or_default();

    if status != 200 {
        return Err(format!("Dropbox list_shared_links failed ({status}): {text}"));
    }

    let val: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    Ok(val["links"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|link| link["url"].as_str())
        .map(String::from))
}

/// Create or retrieve a public sharing link for a file already on Dropbox.
async fn dropbox_sharing_link(
    client:       &reqwest::Client,
    access_token: &str,
    remote_path:  &str,
) -> Result<Option<String>, String> {
    let body = json!({
        "path":     remote_path,
        "settings": { "requested_visibility": { ".tag": "public" } }
    })
    .to_string();

    let res = client
        .post("https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings")
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .header(CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Dropbox link request failed: {e}"))?;

    let status = res.status().as_u16();
    let text   = res.text().await.unwrap_or_default();
    let val: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();

    if status == 200 {
        // New link created successfully
        return Ok(val["url"].as_str().map(String::from));
    }

    if status == 409 {
        // Link already exists — try to get URL from error metadata first.
        // When the existing link has the same settings, Dropbox returns no metadata;
        // fall back to list_shared_links in that case.
        if let Some(url) = val["error"]["shared_link_already_exists"]["metadata"]["url"].as_str() {
            return Ok(Some(url.to_string()));
        }
        return dropbox_list_sharing_link(client, access_token, remote_path).await;
    }

    // Any other status (403 missing scope, 401 bad token, etc.) — surface the error
    Err(format!("Dropbox sharing link failed ({status}): {text}"))
}

/// Upload a local file to Dropbox, skipping if already present, and optionally return a sharing URL.
/// Uses Rust/reqwest — no WKWebView body-size or CSP restrictions.
#[tauri::command]
pub async fn upload_to_dropbox(
    app:          tauri::AppHandle,
    file_path:    String,
    remote_path:  String,
    access_token: String,
    get_link:     bool,
) -> Result<DropboxUploadResult, String> {
    let client = reqwest::Client::new();
    let file_path =
        crate::path_policy::require_allowed_file(&app, &file_path, "Dropbox upload source")?;

    // Skip upload if the file already exists on Dropbox
    if dropbox_file_exists(&client, &access_token, &remote_path).await? {
        let url = if get_link {
            dropbox_sharing_link(&client, &access_token, &remote_path).await?
        } else {
            None
        };
        return Ok(DropboxUploadResult { url, skipped: true });
    }

    let bytes = std::fs::read(&file_path)
        .map_err(|e| format!("Cannot read {}: {e}", file_path.display()))?;

    // Dropbox's simple /files/upload endpoint is capped at 150 MB; larger files
    // must use a chunked upload session (start → append_v2 → finish).
    const DROPBOX_SIMPLE_MAX: usize = 150 * 1024 * 1024;

    if bytes.len() > DROPBOX_SIMPLE_MAX {
        dropbox_upload_session(&client, &access_token, &remote_path, &bytes).await?;
    } else {
        let api_arg = json!({
            "path":       remote_path,
            "mode":       "overwrite",
            "autorename": false,
            "mute":       false,
        })
        .to_string();

        let upload_res = client
            .post("https://content.dropboxapi.com/2/files/upload")
            .header(AUTHORIZATION, format!("Bearer {access_token}"))
            .header(CONTENT_TYPE, "application/octet-stream")
            .header("Dropbox-API-Arg", &api_arg)
            .body(bytes)
            .send()
            .await
            .map_err(|e| format!("Dropbox upload request failed: {e}"))?;

        if !upload_res.status().is_success() {
            let status = upload_res.status().as_u16();
            let body   = upload_res.text().await.unwrap_or_default();
            return Err(format!("Dropbox upload failed ({status}): {body}"));
        }
    }

    let url = if get_link {
        dropbox_sharing_link(&client, &access_token, &remote_path).await?
    } else {
        None
    };

    Ok(DropboxUploadResult { url, skipped: false })
}

/// Chunked upload for files above Dropbox's 150 MB simple-upload limit.
/// start (first chunk) → append_v2 (middle chunks) → finish (last chunk + commit).
async fn dropbox_upload_session(
    client:       &reqwest::Client,
    access_token: &str,
    remote_path:  &str,
    bytes:        &[u8],
) -> Result<(), String> {
    // 48 MB chunks (Dropbox requires a multiple of 4 MB, max 150 MB per request).
    const CHUNK: usize = 48 * 1024 * 1024;
    let total = bytes.len();

    // Start with the first chunk.
    let first_end = std::cmp::min(CHUNK, total);
    let start_res = client
        .post("https://content.dropboxapi.com/2/files/upload_session/start")
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .header(CONTENT_TYPE, "application/octet-stream")
        .header("Dropbox-API-Arg", json!({ "close": false }).to_string())
        .body(bytes[0..first_end].to_vec())
        .send()
        .await
        .map_err(|e| format!("Dropbox session start failed: {e}"))?;
    if !start_res.status().is_success() {
        let status = start_res.status().as_u16();
        return Err(format!("Dropbox session start failed ({status}): {}", start_res.text().await.unwrap_or_default()));
    }
    let start_text = start_res.text().await.unwrap_or_default();
    let start_val: serde_json::Value = serde_json::from_str(&start_text).unwrap_or_default();
    let session_id = start_val["session_id"].as_str().unwrap_or_default().to_string();
    if session_id.is_empty() {
        return Err(format!("Dropbox session start returned no session_id: {start_text}"));
    }

    let mut offset = first_end;
    loop {
        // Commit once everything is uploaded (also covers the single-chunk case).
        if offset >= total {
            let commit_arg = json!({
                "cursor": { "session_id": session_id, "offset": offset },
                "commit": { "path": remote_path, "mode": "overwrite", "autorename": false, "mute": false },
            }).to_string();
            let fin = client
                .post("https://content.dropboxapi.com/2/files/upload_session/finish")
                .header(AUTHORIZATION, format!("Bearer {access_token}"))
                .header(CONTENT_TYPE, "application/octet-stream")
                .header("Dropbox-API-Arg", commit_arg)
                .body(Vec::new())
                .send()
                .await
                .map_err(|e| format!("Dropbox session finish failed: {e}"))?;
            if !fin.status().is_success() {
                let status = fin.status().as_u16();
                return Err(format!("Dropbox session finish failed ({status}): {}", fin.text().await.unwrap_or_default()));
            }
            break;
        }

        let end = std::cmp::min(offset + CHUNK, total);
        let chunk = bytes[offset..end].to_vec();
        if end < total {
            let arg = json!({ "cursor": { "session_id": session_id, "offset": offset }, "close": false }).to_string();
            let res = client
                .post("https://content.dropboxapi.com/2/files/upload_session/append_v2")
                .header(AUTHORIZATION, format!("Bearer {access_token}"))
                .header(CONTENT_TYPE, "application/octet-stream")
                .header("Dropbox-API-Arg", arg)
                .body(chunk)
                .send()
                .await
                .map_err(|e| format!("Dropbox session append failed: {e}"))?;
            if !res.status().is_success() {
                let status = res.status().as_u16();
                return Err(format!("Dropbox session append failed ({status}): {}", res.text().await.unwrap_or_default()));
            }
        } else {
            let commit_arg = json!({
                "cursor": { "session_id": session_id, "offset": offset },
                "commit": { "path": remote_path, "mode": "overwrite", "autorename": false, "mute": false },
            }).to_string();
            let fin = client
                .post("https://content.dropboxapi.com/2/files/upload_session/finish")
                .header(AUTHORIZATION, format!("Bearer {access_token}"))
                .header(CONTENT_TYPE, "application/octet-stream")
                .header("Dropbox-API-Arg", commit_arg)
                .body(chunk)
                .send()
                .await
                .map_err(|e| format!("Dropbox session finish failed: {e}"))?;
            if !fin.status().is_success() {
                let status = fin.status().as_u16();
                return Err(format!("Dropbox session finish failed ({status}): {}", fin.text().await.unwrap_or_default()));
            }
        }
        offset = end;
    }

    Ok(())
}

/* ── OneDrive device code auth ───────────────────────────────────────────────
 * Run via reqwest instead of WKWebView fetch() — Microsoft's device-code
 * endpoints don't send CORS headers for tauri://localhost, which makes the
 * webview fail with "TypeError: Load failed" before sign-in ever starts. */

// Files.ReadWrite → the user's own drive; Sites.ReadWrite.All → SharePoint /
// OneDrive-for-Business shared document libraries (client-delivery target).
const ONEDRIVE_SCOPE: &str = "Files.ReadWrite Sites.ReadWrite.All offline_access User.Read";

/// Single-tenant Azure app registrations reject the `/common` endpoint with
/// AADSTS50059 ("no tenant-identifying information") — the tenant GUID (or
/// `/organizations`, `/consumers`) must be used instead. Defaults to `common`
/// for multi-tenant/personal apps, or when the caller (e.g. a destination
/// saved before tenant IDs existed) omits the field entirely.
fn ms_authority(tenant_id: &Option<String>) -> &str {
    match tenant_id.as_deref().map(str::trim) {
        Some(t) if !t.is_empty() => t,
        _ => "common",
    }
}

fn device_code_url(tenant_id: &Option<String>) -> String {
    format!("https://login.microsoftonline.com/{}/oauth2/v2.0/devicecode", ms_authority(tenant_id))
}

fn token_url(tenant_id: &Option<String>) -> String {
    format!("https://login.microsoftonline.com/{}/oauth2/v2.0/token", ms_authority(tenant_id))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OneDriveDeviceCodeInfo {
    pub device_code:      String,
    pub user_code:        String,
    pub verification_uri: String,
    pub expires_in:       u64,
    pub interval:         u64,
    pub message:          String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OneDriveTokenResult {
    pub access_token:  String,
    pub refresh_token: String,
    pub expires_in:    u64,
}

#[derive(Deserialize, Default)]
struct MsTokenResponse {
    access_token:      Option<String>,
    refresh_token:     Option<String>,
    expires_in:         Option<u64>,
    error:             Option<String>,
    error_description: Option<String>,
}

#[tauri::command]
pub async fn onedrive_device_code(
    client_id: String,
    tenant_id: Option<String>,
) -> Result<OneDriveDeviceCodeInfo, String> {
    let client = reqwest::Client::new();
    let res = client
        .post(device_code_url(&tenant_id))
        .form(&[("client_id", client_id.as_str()), ("scope", ONEDRIVE_SCOPE)])
        .send()
        .await
        .map_err(|e| format!("OneDrive device code request failed: {e}"))?;

    let status = res.status();
    let text   = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("OneDrive device code request failed ({}): {text}", status.as_u16()));
    }

    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("OneDrive device code response parse failed: {e}"))?;

    Ok(OneDriveDeviceCodeInfo {
        device_code:      json["device_code"].as_str().unwrap_or_default().to_string(),
        user_code:        json["user_code"].as_str().unwrap_or_default().to_string(),
        verification_uri: json["verification_uri"].as_str().unwrap_or_default().to_string(),
        expires_in:       json["expires_in"].as_u64().unwrap_or(900),
        interval:         json["interval"].as_u64().unwrap_or(5),
        message:          json["message"].as_str().unwrap_or_default().to_string(),
    })
}

/// Poll the device-code token endpoint once. Returns Ok(None) while the user
/// hasn't finished signing in yet (`authorization_pending` / `slow_down`),
/// Ok(Some(..)) once a token is issued, and Err on decline/expiry.
#[tauri::command]
pub async fn onedrive_poll_token(
    client_id:   String,
    tenant_id:   Option<String>,
    device_code: String,
) -> Result<Option<OneDriveTokenResult>, String> {
    let client = reqwest::Client::new();
    let res = client
        .post(token_url(&tenant_id))
        .form(&[
            ("grant_type",  "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id",   client_id.as_str()),
            ("device_code", device_code.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("OneDrive token poll failed: {e}"))?;

    let text = res.text().await.unwrap_or_default();
    let json: MsTokenResponse = serde_json::from_str(&text).unwrap_or_default();

    if let Some(access_token) = json.access_token {
        return Ok(Some(OneDriveTokenResult {
            access_token,
            refresh_token: json.refresh_token.unwrap_or_default(),
            expires_in:    json.expires_in.unwrap_or(3600),
        }));
    }

    if let Some(error) = json.error {
        if error == "authorization_declined" || error == "expired_token" {
            return Err(json.error_description.unwrap_or(error));
        }
    }

    // 'authorization_pending' or 'slow_down' — caller keeps polling
    Ok(None)
}

#[tauri::command]
pub async fn onedrive_refresh_token(
    client_id:     String,
    tenant_id:     Option<String>,
    refresh_token: String,
) -> Result<OneDriveTokenResult, String> {
    let client = reqwest::Client::new();
    let res = client
        .post(token_url(&tenant_id))
        .form(&[
            ("grant_type",    "refresh_token"),
            ("client_id",     client_id.as_str()),
            ("refresh_token", refresh_token.as_str()),
            ("scope",         ONEDRIVE_SCOPE),
        ])
        .send()
        .await
        .map_err(|e| format!("OneDrive refresh request failed: {e}"))?;

    let status = res.status();
    let text   = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("OneDrive refresh failed ({}): {text}", status.as_u16()));
    }

    let json: MsTokenResponse = serde_json::from_str(&text)
        .map_err(|e| format!("OneDrive refresh response parse failed: {e}"))?;

    Ok(OneDriveTokenResult {
        access_token:  json.access_token.unwrap_or_default(),
        refresh_token: json.refresh_token.unwrap_or(refresh_token),
        expires_in:    json.expires_in.unwrap_or(3600),
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────
//
// The tenant fallback below decides which Microsoft login authority every OneDrive OAuth
// call is aimed at. Getting it wrong sends a personal-account user to an organisation
// endpoint (or the reverse) and the only symptom is an opaque AADSTS error at sign-in.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ms_authority_uses_the_configured_tenant() {
        assert_eq!(ms_authority(&Some("contoso.onmicrosoft.com".into())), "contoso.onmicrosoft.com");
        assert_eq!(
            ms_authority(&Some("72f988bf-86f1-41af-91ab-2d7cd011db47".into())),
            "72f988bf-86f1-41af-91ab-2d7cd011db47",
        );
    }

    #[test]
    fn ms_authority_falls_back_to_common_for_missing_or_blank_tenants() {
        // "common" is the multi-tenant/personal-account authority — the right default for a
        // user who never configured an Azure tenant.
        assert_eq!(ms_authority(&None), "common");
        assert_eq!(ms_authority(&Some(String::new())), "common");
        assert_eq!(ms_authority(&Some("   ".into())), "common");
        assert_eq!(ms_authority(&Some("\t\n".into())), "common");
    }

    #[test]
    fn ms_authority_trims_a_padded_tenant_rather_than_building_a_broken_url() {
        assert_eq!(ms_authority(&Some("  contoso  ".into())), "contoso");
    }

    #[test]
    fn device_code_url_targets_the_v2_endpoint_for_the_resolved_authority() {
        assert_eq!(
            device_code_url(&Some("contoso".into())),
            "https://login.microsoftonline.com/contoso/oauth2/v2.0/devicecode",
        );
        assert_eq!(
            device_code_url(&None),
            "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode",
        );
    }

    #[test]
    fn token_url_targets_the_v2_endpoint_for_the_resolved_authority() {
        assert_eq!(
            token_url(&Some("contoso".into())),
            "https://login.microsoftonline.com/contoso/oauth2/v2.0/token",
        );
        assert_eq!(
            token_url(&None),
            "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        );
    }

    #[test]
    fn device_code_and_token_urls_share_one_authority() {
        // A device-code flow started on one authority cannot be completed on another, so
        // these two must never diverge.
        let tenant = Some("contoso".into());
        let authority = |u: &str| u.split("/oauth2/").next().unwrap().to_string();
        assert_eq!(authority(&device_code_url(&tenant)), authority(&token_url(&tenant)));
        assert_eq!(authority(&device_code_url(&None)), authority(&token_url(&None)));
    }
}
