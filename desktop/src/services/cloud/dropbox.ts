/* Dropbox: connect, refresh, verify, upload.
 *
 * Uploads over ~150 MB must use a chunked session rather than a single PUT; the Rust side owns that
 * split (see cloud.rs), so this module hands the whole file to `upload_to_dropbox` and lets it decide.
 */

import { invoke } from '@tauri-apps/api/core';
import { open as openBrowser } from '@tauri-apps/plugin-shell';
import type { CloudToken } from '../../domain/client';
import { REDIRECT_URI, generatePKCE, waitForCallback } from './oauth';

export async function connectDropbox(clientId: string): Promise<CloudToken> {
  const { verifier, challenge } = await generatePKCE();
  const state = crypto.randomUUID();

  const url = 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
    client_id:             clientId,
    response_type:         'code',
    redirect_uri:          REDIRECT_URI,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    token_access_type:     'offline',
    scope:                 'account_info.read files.content.write files.metadata.read sharing.read sharing.write',
    state,
  });

  // Start listener BEFORE opening browser so we don't miss the redirect
  const callbackPromise = waitForCallback();
  await openBrowser(url);
  const params = await callbackPromise;

  if (params.get('state') !== state) throw new Error('OAuth state mismatch — possible CSRF attack.');
  const code = params.get('code');
  if (!code) throw new Error(`Dropbox auth failed: ${params.get('error_description') ?? params.get('error') ?? 'no code'}`);

  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      grant_type:    'authorization_code',
      client_id:     clientId,
      redirect_uri:  REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) throw new Error(`Dropbox token exchange failed: ${await res.text()}`);
  const json = await res.json();

  return {
    accessToken:  json.access_token,
    refreshToken: json.refresh_token ?? '',
    expiresAt:    Date.now() + (json.expires_in ?? 14400) * 1000,
    email:        '',
    displayName:  '',
  };
}

export async function refreshDropboxToken(
  clientId: string,
  refreshToken: string,
): Promise<Partial<CloudToken>> {
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     clientId,
    }),
  });
  if (!res.ok) throw new Error(`Dropbox refresh failed: ${await res.text()}`);
  const json = await res.json();
  return {
    accessToken: json.access_token,
    expiresAt:   Date.now() + (json.expires_in ?? 14400) * 1000,
  };
}

export async function checkDropboxConnection(accessToken: string): Promise<{ email: string; displayName: string }> {
  const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('Dropbox connection check failed — token may be invalid.');
  const json = await res.json();
  return { email: json.email ?? '', displayName: json.name?.display_name ?? '' };
}

/* ── Dropbox file upload ─────────────────────────────────────────────────── */

// Uses the Rust upload_to_dropbox command — avoids WKWebView body-size limits
// and CSP restrictions that affect large binary fetch bodies on macOS.
// Skips the upload if the file already exists on Dropbox; returns { url, skipped }.
export async function uploadDropboxFile(
  accessToken: string,
  filePath:     string,   // local absolute path to the file
  remotePath:   string,   // full Dropbox path, e.g. "/DC Hub/ESS/file.pdf"
  getLink:      boolean,
): Promise<{ url: string | null; skipped: boolean }> {
  return invoke<{ url: string | null; skipped: boolean }>('upload_to_dropbox', {
    filePath,
    remotePath,
    accessToken,
    getLink,
  });
}

