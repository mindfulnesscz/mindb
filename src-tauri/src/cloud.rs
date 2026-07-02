use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
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
