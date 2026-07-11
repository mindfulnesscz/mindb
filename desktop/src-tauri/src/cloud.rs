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
    file_path:    String,
    remote_path:  String,
    access_token: String,
    get_link:     bool,
) -> Result<DropboxUploadResult, String> {
    let client = reqwest::Client::new();

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
        .map_err(|e| format!("Cannot read {file_path}: {e}"))?;

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

    let url = if get_link {
        dropbox_sharing_link(&client, &access_token, &remote_path).await?
    } else {
        None
    };

    Ok(DropboxUploadResult { url, skipped: false })
}

/* ── OneDrive device code auth ───────────────────────────────────────────────
 * Run via reqwest instead of WKWebView fetch() — Microsoft's device-code
 * endpoints don't send CORS headers for tauri://localhost, which makes the
 * webview fail with "TypeError: Load failed" before sign-in ever starts. */

const ONEDRIVE_SCOPE: &str = "Files.ReadWrite offline_access User.Read";

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
