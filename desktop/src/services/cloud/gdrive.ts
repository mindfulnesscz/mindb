/* Google Drive: PKCE auth, folder resolution, upload.
 *
 * Drive has no paths. Folders are nodes addressed by id, so every upload first walks the destination
 * path segment by segment, resolving or creating each folder — which is why this is the largest of
 * the three provider modules, and why it keeps a folder-id cache.
 *
 * Files above 5 MiB go through a resumable session; smaller ones as a single multipart request.
 */

import { open as openBrowser } from '@tauri-apps/plugin-shell';
import type { CloudToken } from '../../domain/client';
import { REDIRECT_URI, generatePKCE, waitForCallback } from './oauth';

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


/* ── Google Drive file upload ────────────────────────────────────────────── */

// sharedDriveId: pass a Shared Drive ID to target that team drive instead of
// the signed-in account's own My Drive — required so uploads land in one
// shared location regardless of which teammate's account authorized the
// connection. All requests need supportsAllDrives=true for this to work.
//
// Folder IDs are memoized for the process lifetime so a pipeline run that
// uploads many files under the same tree does not re-list every path segment.
const gdriveFolderCache = new Map<string, string>();

async function getOrCreateGDriveFolder(
  accessToken:   string,
  folderPath:    string,
  sharedDriveId: string,
): Promise<string> {
  const cacheKey = `${sharedDriveId.trim() || 'root'}::${folderPath}`;
  const cached = gdriveFolderCache.get(cacheKey);
  if (cached) return cached;

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
  gdriveFolderCache.set(cacheKey, parentId);
  return parentId;
}

type GDriveRemoteFile = {
  id: string
  size?: string
  md5Checksum?: string
  webViewLink?: string
}

/** Find an existing non-trashed file by exact name under a Drive folder. */
async function findGDriveFile(
  accessToken: string,
  folderId: string,
  fileName: string,
  sharedDriveId: string,
): Promise<GDriveRemoteFile | null> {
  const q = `name='${fileName.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
  const params = new URLSearchParams({
    q,
    fields: 'files(id,size,md5Checksum,webViewLink)',
    pageSize: '1',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  if (sharedDriveId.trim()) {
    params.set('corpora', 'drive');
    params.set('driveId', sharedDriveId.trim());
  }
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`GDrive list failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { files?: GDriveRemoteFile[] };
  return data.files?.[0] ?? null;
}

async function ensureGDriveShareLink(
  accessToken: string,
  fileId: string,
  existingLink?: string,
): Promise<string | null> {
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?supportsAllDrives=true`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ role: 'reader', type: 'anyone' }),
  }).catch(() => { /* already shared or policy-blocked */ });
  if (existingLink) return existingLink;
  const meta = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=webViewLink&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!meta.ok) return null;
  const data = await meta.json() as { webViewLink?: string };
  return data.webViewLink ?? null;
}

/**
 * Sync a file to Google Drive with skip-if-unchanged semantics.
 * Bytes are loaded lazily via `getBytes` — unchanged remotes never read the local file.
 * - Same-name file + matching size → skip
 * - Same-name file + different size → media update in place
 * - Missing → multipart create
 */
// Multipart create holds the whole body in memory and is capped for large
// files; above this, use a resumable session instead.
const GDRIVE_SIMPLE_MAX = 5 * 1024 * 1024;

/** Resumable upload/update — supports files far beyond the multipart limit.
 *  Pass fileId to update existing content; omit it (with parents) to create. */
async function gdriveResumableUpload(
  accessToken: string,
  opts:        { fileId?: string; name: string; parents?: string[] },
  bytes:       Uint8Array<ArrayBuffer>,
  mimeType:    string,
): Promise<{ id?: string; webViewLink?: string }> {
  const isUpdate = !!opts.fileId;
  const initUrl = isUpdate
    ? `https://www.googleapis.com/upload/drive/v3/files/${opts.fileId}?uploadType=resumable&fields=id,webViewLink&supportsAllDrives=true`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink&supportsAllDrives=true`;
  // parents may only be set on create; changing them on update needs addParents.
  const meta = isUpdate ? { name: opts.name } : { name: opts.name, parents: opts.parents };

  const initRes = await fetch(initUrl, {
    method:  isUpdate ? 'PATCH' : 'POST',
    headers: {
      Authorization:            `Bearer ${accessToken}`,
      'Content-Type':           'application/json; charset=UTF-8',
      'X-Upload-Content-Type':  mimeType,
      'X-Upload-Content-Length': String(bytes.byteLength),
    },
    body: JSON.stringify(meta),
  });
  if (!initRes.ok) throw new Error(`GDrive resumable init failed (${initRes.status}): ${await initRes.text()}`);
  const sessionUrl = initRes.headers.get('Location');
  if (!sessionUrl) throw new Error('GDrive resumable session URL missing from response.');

  const putRes = await fetch(sessionUrl, {
    method:  'PUT',
    headers: { 'Content-Type': mimeType, 'Content-Length': String(bytes.byteLength) },
    body:    bytes,
  });
  if (!putRes.ok) throw new Error(`GDrive resumable upload failed (${putRes.status}): ${await putRes.text()}`);
  return await putRes.json() as { id?: string; webViewLink?: string };
}

export async function uploadGDriveFile(
  accessToken:   string,
  localSize:     number,
  getBytes:      () => Promise<Uint8Array<ArrayBuffer>>,
  mimeType:      string,
  fileName:      string,
  folderPath:    string,   // e.g. "Sotto/ESS"
  getLink:       boolean,
  sharedDriveId: string = '',
): Promise<{ url: string | null; skipped: boolean }> {
  const folderId = await getOrCreateGDriveFolder(accessToken, folderPath, sharedDriveId);
  const existing = await findGDriveFile(accessToken, folderId, fileName, sharedDriveId);
  const sizeStr  = String(localSize);

  if (existing && existing.size === sizeStr) {
    if (!getLink) return { url: null, skipped: true };
    if (existing.webViewLink) return { url: existing.webViewLink, skipped: true };
    const url = await ensureGDriveShareLink(accessToken, existing.id);
    return { url, skipped: true };
  }

  const bytes = await getBytes();

  if (existing) {
    // Content changed — update in place (no second same-name file).
    const updated = bytes.byteLength > GDRIVE_SIMPLE_MAX
      ? await gdriveResumableUpload(accessToken, { fileId: existing.id, name: fileName }, bytes, mimeType)
      : await (async () => {
          const updateRes = await fetch(
            `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media&fields=id,webViewLink&supportsAllDrives=true`,
            {
              method:  'PATCH',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': mimeType },
              body:    bytes,
            },
          );
          if (!updateRes.ok) throw new Error(`GDrive update failed (${updateRes.status}): ${await updateRes.text()}`);
          return await updateRes.json() as { id?: string; webViewLink?: string };
        })();
    const url = getLink && updated.id
      ? await ensureGDriveShareLink(accessToken, updated.id, updated.webViewLink)
      : null;
    return { url, skipped: false };
  }

  // Large new file → resumable session (multipart create is memory-bound / capped).
  if (bytes.byteLength > GDRIVE_SIMPLE_MAX) {
    const fileData = await gdriveResumableUpload(
      accessToken, { name: fileName, parents: [folderId] }, bytes, mimeType,
    );
    const url = getLink && fileData.id
      ? await ensureGDriveShareLink(accessToken, fileData.id, fileData.webViewLink)
      : null;
    return { url, skipped: false };
  }

  // Multipart create: metadata + file bytes
  const boundary = '----sotto_boundary';
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

  const url = getLink && fileData.id
    ? await ensureGDriveShareLink(accessToken, fileData.id, fileData.webViewLink)
    : null;
  return { url, skipped: false };
}

