use std::collections::HashMap;
use serde::Serialize;

#[derive(Serialize)]
pub struct SbResponse {
    pub status: u16,
    pub ok:     bool,
    pub body:   String,
}

/// Generic HTTP proxy for Supabase REST API calls.
/// Runs in the native Rust context so the service role key is never sent
/// from the WebView — bypassing Supabase's browser-key restriction.
#[tauri::command]
pub async fn supabase_request(
    url:     String,
    method:  String,
    headers: HashMap<String, String>,
    body:    Option<String>,
) -> Result<SbResponse, String> {
    let client = reqwest::Client::new();

    let mut req = match method.to_uppercase().as_str() {
        "GET"    => client.get(&url),
        "POST"   => client.post(&url),
        "PATCH"  => client.patch(&url),
        "DELETE" => client.delete(&url),
        m        => return Err(format!("Unsupported HTTP method: {m}")),
    };

    for (k, v) in &headers {
        req = req.header(k, v);
    }

    if let Some(b) = body {
        req = req.body(b);
    }

    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let ok     = res.status().is_success();
    let body   = res.text().await.map_err(|e| e.to_string())?;

    Ok(SbResponse { status, ok, body })
}
