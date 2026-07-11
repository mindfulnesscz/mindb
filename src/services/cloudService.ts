import { invoke } from '@tauri-apps/api/core';
import { open as openBrowser } from '@tauri-apps/plugin-shell';
import type { CloudToken } from '../domain/client';

const REDIRECT_URI = 'http://localhost:7623/callback';
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/* ── PKCE helpers ────────────────────────────────────────────────────────── */

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = Array.from(array, b => b.toString(16).padStart(2, '0')).join('');

  const encoded = new TextEncoder().encode(verifier);
  const digest  = await crypto.subtle.digest('SHA-256', encoded);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  return { verifier, challenge };
}

async function waitForCallback(): Promise<URLSearchParams> {
  const path   = await invoke<string>('wait_for_oauth_redirect');
  const query  = path.split('?')[1] ?? '';
  return new URLSearchParams(query);
}

/* ── Dropbox PKCE ────────────────────────────────────────────────────────── */

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

/* ── OneDrive Device Code ────────────────────────────────────────────────── */

export interface DeviceCodeInfo {
  deviceCode:      string;
  userCode:        string;
  verificationUri: string;
  expiresIn:       number;
  interval:        number;
  message:         string;
}

// Uses Rust/reqwest commands — WKWebView fetch() to Microsoft's device-code
// endpoints fails with "TypeError: Load failed" because those endpoints don't
// send CORS headers for the tauri://localhost origin.
//
// tenantId: pass 'common' for multi-tenant/personal apps, or the Azure AD
// tenant GUID for single-tenant ("My organization only") app registrations —
// those reject `/common` with AADSTS50059.
export async function startOneDriveDeviceCode(clientId: string, tenantId: string): Promise<DeviceCodeInfo> {
  return invoke<DeviceCodeInfo>('onedrive_device_code', { clientId, tenantId });
}

export async function pollOneDriveToken(
  clientId:   string,
  tenantId:   string,
  deviceCode: string,
  _intervalSecs: number,
  signal: { cancelled: boolean },
): Promise<CloudToken | null> {
  const result = await invoke<{ accessToken: string; refreshToken: string; expiresIn: number } | null>(
    'onedrive_poll_token',
    { clientId, tenantId, deviceCode },
  );

  if (signal.cancelled) return null;
  if (!result) return null;

  return {
    accessToken:  result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt:    Date.now() + result.expiresIn * 1000,
    email:        '',
    displayName:  '',
  };
}

export async function refreshOneDriveToken(
  clientId: string,
  tenantId: string,
  refreshToken: string,
): Promise<Partial<CloudToken>> {
  const result = await invoke<{ accessToken: string; refreshToken: string; expiresIn: number }>(
    'onedrive_refresh_token',
    { clientId, tenantId, refreshToken },
  );
  return {
    accessToken:  result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt:    Date.now() + result.expiresIn * 1000,
  };
}

export async function checkOneDriveConnection(accessToken: string): Promise<{ email: string; displayName: string }> {
  const res = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('OneDrive connection check failed — token may be invalid.');
  const json = await res.json();
  return {
    email:       json.mail ?? json.userPrincipalName ?? '',
    displayName: json.displayName ?? '',
  };
}

/* ── Google Drive PKCE ───────────────────────────────────────────────────── */

export async function connectGDrive(clientId: string, clientSecret: string): Promise<CloudToken> {
  const { verifier, challenge } = await generatePKCE();
  const state = crypto.randomUUID();

  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id:             clientId,
    redirect_uri:          REDIRECT_URI,
    response_type:         'code',
    scope:                 'https://www.googleapis.com/auth/drive',
    access_type:           'offline',
    prompt:                'consent',
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  });

  const callbackPromise = waitForCallback();
  await openBrowser(url);
  const params = await callbackPromise;

  if (params.get('state') !== state) throw new Error('OAuth state mismatch — possible CSRF attack.');
  const code = params.get('code');
  if (!code) throw new Error(`Google auth failed: ${params.get('error_description') ?? params.get('error') ?? 'no code'}`);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      grant_type:    'authorization_code',
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) throw new Error(`Google token exchange failed: ${await res.text()}`);
  const json = await res.json();

  return {
    accessToken:  json.access_token,
    refreshToken: json.refresh_token ?? '',
    expiresAt:    Date.now() + (json.expires_in ?? 3600) * 1000,
    email:        '',
    displayName:  '',
  };
}

export async function refreshGDriveToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<Partial<CloudToken>> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Google Drive refresh failed: ${await res.text()}`);
  const json = await res.json();
  return {
    accessToken: json.access_token,
    expiresAt:   Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

export async function checkGDriveConnection(accessToken: string): Promise<{ email: string; displayName: string }> {
  const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('Google Drive connection check failed — token may be invalid.');
  const json = await res.json();
  return {
    email:       json.user?.emailAddress ?? '',
    displayName: json.user?.displayName ?? '',
  };
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

/* ── OneDrive file upload ────────────────────────────────────────────────── */

export async function uploadOneDriveFile(
  accessToken: string,
  bytes:        Uint8Array,
  remotePath:   string,   // e.g. "DC Hub/ESS/file.pdf"
  getLink:      boolean,
): Promise<string | null> {
  const encodedPath = remotePath.split('/').map(encodeURIComponent).join('/');
  const uploadRes = await fetch(
    `https://graph.microsoft.com/v1.0/me/drive/root:/${encodedPath}:/content`,
    {
      method:  'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/octet-stream' },
      body:    bytes,
    },
  );
  if (!uploadRes.ok) throw new Error(`OneDrive upload failed (${uploadRes.status}): ${await uploadRes.text()}`);

  if (!getLink) return null;

  const linkRes = await fetch(
    `https://graph.microsoft.com/v1.0/me/drive/root:/${encodedPath}:/createLink`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'view', scope: 'anonymous' }),
    },
  );
  if (!linkRes.ok) return null;
  const data = await linkRes.json() as { link?: { webUrl?: string } };
  return data.link?.webUrl ?? null;
}

/* ── Google Drive file upload ────────────────────────────────────────────── */

// sharedDriveId: pass a Shared Drive ID to target that team drive instead of
// the signed-in account's own My Drive — required so uploads land in one
// shared location regardless of which teammate's account authorized the
// connection. All requests need supportsAllDrives=true for this to work.
async function getOrCreateGDriveFolder(
  accessToken:   string,
  folderPath:    string,
  sharedDriveId: string,
): Promise<string> {
  const rootId = sharedDriveId.trim() || 'root';
  let parentId = rootId;
  const parts  = folderPath.split('/').filter(Boolean);

  for (const part of parts) {
    const q      = `name='${part.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
    const params = new URLSearchParams({ q, fields: 'files(id)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
    if (sharedDriveId.trim()) {
      params.set('corpora', 'drive');
      params.set('driveId', sharedDriveId.trim());
    }
    const res  = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json() as { files?: Array<{ id: string }> };
    if (data.files?.length) {
      parentId = data.files[0].id;
    } else {
      const cr = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
        method:  'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: part, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
      });
      const folder = await cr.json() as { id: string };
      parentId = folder.id;
    }
  }
  return parentId;
}

export async function uploadGDriveFile(
  accessToken:   string,
  bytes:         Uint8Array,
  mimeType:      string,
  fileName:      string,
  folderPath:    string,   // e.g. "DC Hub/ESS"
  getLink:       boolean,
  sharedDriveId: string = '',
): Promise<string | null> {
  const folderId = await getOrCreateGDriveFolder(accessToken, folderPath, sharedDriveId);

  // Multipart upload: metadata + file bytes
  const boundary = '----dc_hub_boundary';
  const meta     = JSON.stringify({ name: fileName, parents: [folderId] });
  const encoder  = new TextEncoder();
  const parts    = [
    encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    encoder.encode(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    bytes,
    encoder.encode(`\r\n--${boundary}--`),
  ];
  const totalLen = parts.reduce((s, p) => s + p.byteLength, 0);
  const body     = new Uint8Array(totalLen);
  let offset     = 0;
  for (const p of parts) { body.set(p, offset); offset += p.byteLength; }

  const uploadRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true',
    {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!uploadRes.ok) throw new Error(`GDrive upload failed (${uploadRes.status}): ${await uploadRes.text()}`);
  const fileData = await uploadRes.json() as { id?: string; webViewLink?: string };

  if (!getLink || !fileData.id) return null;

  // Make file publicly viewable and return sharing link
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileData.id}/permissions?supportsAllDrives=true`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  return fileData.webViewLink ?? null;
}

/* ── Token refresh dispatcher ────────────────────────────────────────────── */

export async function refreshCloudToken(
  config: { type: string; clientId?: string; tenantId?: string; clientSecret?: string; token: CloudToken | null },
): Promise<Partial<CloudToken>> {
  if (!config.token?.refreshToken) throw new Error('No refresh token available.');
  const { type, clientId = '', tenantId = 'common', token } = config;
  if (type === 'dropbox')  return refreshDropboxToken(clientId, token.refreshToken);
  if (type === 'onedrive') return refreshOneDriveToken(clientId, tenantId, token.refreshToken);
  if (type === 'gdrive')   return refreshGDriveToken(clientId, (config as { clientSecret: string }).clientSecret ?? '', token.refreshToken);
  throw new Error(`Unknown provider: ${type}`);
}

export { delay };
