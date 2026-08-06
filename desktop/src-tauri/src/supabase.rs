use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Serialize)]
pub struct SbResponse {
    pub status: u16,
    pub ok:     bool,
    pub body:   String,
}

#[derive(Deserialize)]
struct PersistedEnvironments {
    #[serde(rename = "activeId")]
    active_id: Option<String>,
    #[serde(default)]
    list: Vec<PersistedEnvironment>,
}

#[derive(Deserialize)]
struct PersistedEnvironment {
    id: String,
    #[serde(rename = "supabaseUrl")]
    supabase_url: String,
}

fn configured_origins(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("environments.json");
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("Read configured Supabase environments {}: {e}", path.display()))?;
    let environments: PersistedEnvironments = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Parse configured Supabase environments {}: {e}", path.display()))?;
    let active_id = environments
        .active_id
        .ok_or_else(|| "No active Supabase environment is configured".to_string())?;
    let active = environments
        .list
        .into_iter()
        .find(|environment| environment.id == active_id)
        .ok_or_else(|| "The active Supabase environment is missing from configuration".to_string())?;
    Ok(vec![active.supabase_url])
}

fn validated_request_url(url: &str, configured: &[String]) -> Result<reqwest::Url, String> {
    let requested = reqwest::Url::parse(url).map_err(|e| format!("Invalid Supabase URL: {e}"))?;
    if !matches!(requested.scheme(), "http" | "https")
        || requested.host_str().is_none()
        || !requested.username().is_empty()
        || requested.password().is_some()
        || requested.fragment().is_some()
    {
        return Err("Supabase request must be an HTTP(S) URL without credentials or a fragment".into());
    }

    let requested_origin = requested.origin().ascii_serialization();
    let allowed = configured.iter().any(|value| {
        reqwest::Url::parse(value.trim())
            .ok()
            .filter(|parsed| matches!(parsed.scheme(), "http" | "https"))
            .is_some_and(|parsed| parsed.origin().ascii_serialization() == requested_origin)
    });
    if !allowed {
        return Err(format!(
            "Refusing Supabase request outside the configured origins: {requested_origin}"
        ));
    }
    Ok(requested)
}

/// HTTP proxy for Supabase REST calls, bound to the active origin persisted in `environments.json`.
///
/// Redirects are deliberately disabled. Even after validating the initial URL, following a 30x to
/// another host could forward caller-supplied API headers and recreate the same exfiltration surface.
#[tauri::command]
pub async fn supabase_request(
    app:     tauri::AppHandle,
    url:     String,
    method:  String,
    headers: HashMap<String, String>,
    body:    Option<String>,
) -> Result<SbResponse, String> {
    let url = validated_request_url(&url, &configured_origins(&app)?)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = match method.to_uppercase().as_str() {
        "GET"    => client.get(url),
        "POST"   => client.post(url),
        "PATCH"  => client.patch(url),
        "DELETE" => client.delete(url),
        m        => return Err(format!("Unsupported HTTP method: {m}")),
    };

    for (key, value) in &headers {
        req = req.header(key, value);
    }

    if let Some(body) = body {
        req = req.body(body);
    }

    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let ok = res.status().is_success();
    let body = res.text().await.map_err(|e| e.to_string())?;

    Ok(SbResponse { status, ok, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured() -> Vec<String> {
        vec![
            "https://project.supabase.co".into(),
            "http://127.0.0.1:54321".into(),
        ]
    }

    #[test]
    fn accepts_only_the_exact_configured_origin() {
        assert!(validated_request_url(
            "https://project.supabase.co/rest/v1/assets?select=id",
            &configured(),
        )
        .is_ok());
        assert!(validated_request_url("http://127.0.0.1:54321/rest/v1", &configured()).is_ok());

        assert!(validated_request_url("https://project.supabase.co.evil.test/rest/v1", &configured()).is_err());
        assert!(validated_request_url("http://project.supabase.co/rest/v1", &configured()).is_err());
        assert!(validated_request_url("http://127.0.0.1:54322/rest/v1", &configured()).is_err());
    }

    #[test]
    fn refuses_urls_with_embedded_credentials_or_fragments() {
        assert!(validated_request_url(
            "https://attacker@project.supabase.co/rest/v1",
            &configured(),
        )
        .is_err());
        assert!(validated_request_url(
            "https://project.supabase.co/rest/v1#https://evil.test",
            &configured(),
        )
        .is_err());
    }
}
