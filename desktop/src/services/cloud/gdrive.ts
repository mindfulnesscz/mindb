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
import { asyncPool } from '../pipeline/pool';
import { REDIRECT_URI, generatePKCE, waitForCallback, delay } from './oauth';

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Drive query literals are single-quoted; a name may contain a quote. */
function driveQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

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
const gdriveFolderInflight = new Map<string, Promise<string>>();

export interface GDriveFolderRef {
  id: string;
  name?: string;
  createdTime?: string;
}

/**
 * The one rule for "which of these same-named folders is THE folder": the oldest by `createdTime`,
 * with the id as a tiebreak.
 *
 * Drive lets one parent hold many folders of the same name, so a duplicate set is not an error state
 * the API will resolve — whoever reads it has to choose, and `files[0]` is Drive's whim. Two runs
 * picking differently is what scatters one client's deliverables across three folders that all look
 * identical in Finder. Both the uploader and the dedupe tool call this, so a merge converges on the
 * folder that the next export will also pick. A missing `createdTime` sorts LAST: a folder of known
 * age is a better canonical than one of unknown age.
 */
export function pickCanonicalGDriveFolder<T extends GDriveFolderRef>(folders: T[]): T | null {
  if (!folders.length) return null;
  return [...folders].sort((a, b) => {
    const at = a.createdTime || '￿';
    const bt = b.createdTime || '￿';
    return at === bt ? a.id.localeCompare(b.id) : at < bt ? -1 : 1;
  })[0];
}

/* Duplicate folder sets seen while resolving a path. Reported rather than thrown: an export must
   still deliver, and the operator needs to know the tree needs a cleanup pass (Settings → the Drive
   destination → Clean up duplicate folders). Drained by the cloud-export stage into its run log. */
export interface GDriveDuplicateFolderNotice {
  path:    string;
  count:   number;
  chosenId: string;
}
const gdriveDuplicateFolders: GDriveDuplicateFolderNotice[] = [];

export function drainGDriveDuplicateFolders(): GDriveDuplicateFolderNotice[] {
  return gdriveDuplicateFolders.splice(0, gdriveDuplicateFolders.length);
}

async function resolveGDriveFolderPart(
  accessToken: string,
  parentId: string,
  part: string,
  sharedDriveId: string,
  reportPath: string,
): Promise<string> {
  const q = `name='${driveQuote(part)}' and mimeType='${FOLDER_MIME}' and '${parentId}' in parents and trashed=false`;
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,createdTime)',
    orderBy: 'createdTime',
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
  if (!res.ok) throw new Error(`GDrive folder list failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { files?: GDriveFolderRef[] };
  const existing = pickCanonicalGDriveFolder(data.files ?? []);
  if (existing) {
    if ((data.files?.length ?? 0) > 1) {
      gdriveDuplicateFolders.push({
        path: reportPath, count: data.files!.length, chosenId: existing.id,
      });
    }
    return existing.id;
  }

  const create = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: part,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  });
  if (!create.ok) throw new Error(`GDrive folder create failed (${create.status}): ${await create.text()}`);
  const folder = await create.json() as { id?: string };
  if (!folder.id) throw new Error('GDrive folder create returned no id.');
  return folder.id;
}

async function getOrCreateGDriveFolder(
  accessToken:   string,
  folderPath:    string,
  sharedDriveId: string,
  cacheScope:    string,
): Promise<string> {
  const rootId = sharedDriveId.trim() || 'root';
  let parentId = rootId;
  const parts  = folderPath.split('/').filter(Boolean);
  const scope = `${cacheScope || 'default'}::${rootId}`;
  let prefix = '';

  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    const cacheKey = `${scope}::${prefix}`;
    const cached = gdriveFolderCache.get(cacheKey);
    if (cached) {
      parentId = cached;
      continue;
    }

    // The memo holds the IN-FLIGHT promise, set before the await: eight uploads starting together
    // into a not-yet-existing folder would otherwise all list-empty and all create it, and Drive
    // accepts every one of them. It is per SEGMENT, not per path, because two different packages
    // share their leading segments. A rejected resolve is evicted (`finally`), so one transient
    // 5xx does not poison the folder id for the rest of the run.
    let pending = gdriveFolderInflight.get(cacheKey);
    if (!pending) {
      pending = resolveGDriveFolderPart(accessToken, parentId, part, sharedDriveId, prefix)
        .then(id => {
          gdriveFolderCache.set(cacheKey, id);
          return id;
        })
        .finally(() => gdriveFolderInflight.delete(cacheKey));
      gdriveFolderInflight.set(cacheKey, pending);
    }
    parentId = await pending;
  }
  return parentId;
}

/**
 * Resolve a run's destination folder paths once, before any concurrent upload starts.
 *
 * Belt to the in-flight memo's braces: with the tree already resolved, the 8-wide upload batch never
 * races for a folder at all, and any duplicate sets are reported before the first file moves rather
 * than interleaved with it. Sequential on purpose — these are a handful of paths, and the point is
 * to not be concurrent.
 *
 * Returns the resolved id for each DISTINCT path, which is what lets the caller sweep those folders'
 * children once instead of asking Drive about every file (`sweepGDriveFolderFiles`).
 */
export async function ensureGDriveFolderPaths(
  accessToken:   string,
  folderPaths:   string[],
  sharedDriveId: string,
  cacheScope:    string,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  for (const folderPath of [...new Set(folderPaths)]) {
    resolved.set(
      folderPath,
      await getOrCreateGDriveFolder(accessToken, folderPath, sharedDriveId, cacheScope),
    );
  }
  return resolved;
}

export type GDriveRemoteFile = {
  id: string
  size?: string
  md5Checksum?: string
  webViewLink?: string
}

/** Folder listings run a few at a time: these are read-only metadata calls, but a large tree is
 *  still one per folder and Drive's per-user quota is easy to reach. */
const SWEEP_CONCURRENCY = 4;

/**
 * One children listing per destination FOLDER, in place of one `files.list` per FILE.
 *
 * `findGDriveFile` costs a round trip (~200–400 ms) for every file the local upload cache misses,
 * and the whole library misses whenever that cache is cold — a first run, a reconnected destination,
 * a cleared app data folder. A destination with 300 assets in 12 folders pays 300 of those requests
 * to learn what 12 would have told it. This is the same trade the CDN stage already makes with its
 * one key-manifest sweep per prefix (`fetchTieredManifest` in `pipeline/cdnUpload.ts`).
 *
 * `null` means the sweep failed and the caller must fall back to per-file lookups — the same
 * convention, and for the same reason: a listing that came back short would read as "this file is
 * not there yet" and create a SECOND copy beside the client's existing one. `listGDriveChildren`
 * pages to the end and throws rather than returning a partial page, so short is not a state this
 * can be in; a thrown page fails the whole sweep instead of quietly shrinking it.
 */
export async function sweepGDriveFolderFiles(
  accessToken:   string,
  folderIds:     Iterable<string>,
  sharedDriveId: string,
): Promise<Map<string, Map<string, GDriveRemoteFile>> | null> {
  const ids = [...new Set(folderIds)];
  const byFolder = new Map<string, Map<string, GDriveRemoteFile>>();
  if (!ids.length) return byFolder;

  const outcomes = await asyncPool(SWEEP_CONCURRENCY, ids, async (folderId) => {
    const { files } = await listGDriveChildren(accessToken, folderId, sharedDriveId);
    const byName = new Map<string, GDriveRemoteFile>();
    // Drive allows two FILES of one name in a folder just as it allows two folders, and the listing
    // is ordered by createdTime — so first-wins is oldest-wins, the same rule
    // `pickCanonicalGDriveFolder` applies above. Two runs must not update different copies.
    for (const file of files) {
      if (!byName.has(file.name)) byName.set(file.name, file);
    }
    byFolder.set(folderId, byName);
  });

  return outcomes.every(o => o.status === 'fulfilled') ? byFolder : null;
}

/** Find an existing non-trashed file by exact name under a Drive folder. */
async function findGDriveFile(
  accessToken: string,
  folderId: string,
  fileName: string,
  sharedDriveId: string,
): Promise<GDriveRemoteFile | null> {
  const q = `name='${driveQuote(fileName)}' and '${folderId}' in parents and trashed=false and mimeType!='${FOLDER_MIME}'`;
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

/* A file this run just created, folded back into the swept listing.
 *
 * Without it the sweep would be a REGRESSION on one path the per-file lookup handles: two jobs
 * writing the same name into the same folder — a flattened export where two galleries hold an
 * `01.jpg`, say. The second one used to list, find the first one's file and update it in place;
 * against a listing taken before either ran it would instead create a second copy, which is the
 * duplicate-in-Drive shape `DONE_02` spent a release removing for folders.
 *
 * No md5 is recorded: the caller has the bytes, not their hash, and an absent checksum makes the
 * next comparison update in place rather than skip — the safe direction. */
function rememberCreatedFile(
  listed:   Map<string, GDriveRemoteFile> | null,
  fileName: string,
  created:  { id?: string; webViewLink?: string },
  sizeStr:  string,
): void {
  if (!listed || !created.id) return;
  listed.set(fileName, { id: created.id, size: sizeStr, webViewLink: created.webViewLink });
}

/**
 * Sync a file to Google Drive with skip-if-unchanged semantics.
 * Bytes are loaded lazily via `getBytes` — unchanged remotes never load the local file into memory.
 * - Same-name file + matching size and MD5 → skip
 * - Same-name file + changed size or MD5 → media update in place
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
  getMd5:        () => Promise<string>,
  mimeType:      string,
  fileName:      string,
  folderPath:    string,   // e.g. "Sotto/ESS"
  getLink:       boolean,
  sharedDriveId: string = '',
  cacheScope:    string = '',
  /** Children of each destination folder, listed once up front by `sweepGDriveFolderFiles`. When
   *  a folder is present here its contents are authoritative and no per-file lookup is made; `null`
   *  (a failed or unattempted sweep) falls back to one `files.list` per file. A file created below
   *  is written back into it, so a later upload of the same name in the same run still updates in
   *  place rather than adding a second copy. */
  preListed:     Map<string, Map<string, GDriveRemoteFile>> | null = null,
): Promise<{ url: string | null; skipped: boolean }> {
  const folderId = await getOrCreateGDriveFolder(accessToken, folderPath, sharedDriveId, cacheScope);
  const listed   = preListed?.get(folderId) ?? null;
  const existing = listed
    ? (listed.get(fileName) ?? null)
    : await findGDriveFile(accessToken, folderId, fileName, sharedDriveId);
  const sizeStr  = String(localSize);

  if (existing?.size === sizeStr && existing.md5Checksum) {
    const localMd5 = await getMd5();
    if (localMd5.toLowerCase() === existing.md5Checksum.toLowerCase()) {
      if (!getLink) return { url: null, skipped: true };
      if (existing.webViewLink) return { url: existing.webViewLink, skipped: true };
      const url = await ensureGDriveShareLink(accessToken, existing.id);
      return { url, skipped: true };
    }
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
    // Same reason as a create, plus the size it now holds — a later job for this name must not
    // compare against the size the sweep saw before this write.
    rememberCreatedFile(listed, fileName, { id: updated.id ?? existing.id, webViewLink: updated.webViewLink }, sizeStr);
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
    rememberCreatedFile(listed, fileName, fileData, sizeStr);
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
  rememberCreatedFile(listed, fileName, fileData, sizeStr);

  const url = getLink && fileData.id
    ? await ensureGDriveShareLink(accessToken, fileData.id, fileData.webViewLink)
    : null;
  return { url, skipped: false };
}


/* ── Maintenance: reading and rearranging an existing tree ───────────────────
 *
 * Used by the duplicate-folder cleanup (./gdriveDedupe.ts), not by the upload path. These are the
 * only calls in the app that MOVE or TRASH something a client can see, so they are deliberately
 * narrow: list a folder, move one child between two known parents, trash one node. Nothing here
 * takes a path or searches the drive — the caller resolves ids first and stays inside the subtree it
 * walked.
 *
 * Every one of them goes through `driveApiFetch`, which retries a rate-limited or transient failure.
 * A sweep over a large tree is thousands of requests and Drive's per-user quota is easy to reach; a
 * cleanup that dies half way through has left files moved and folders not yet emptied.
 */

const DRIVE_RETRY_DELAYS_MS = [500, 1500, 4000, 9000];

async function driveApiFetch(
  url:   string,
  init:  RequestInit,
  label: string,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= DRIVE_RETRY_DELAYS_MS.length) {
      throw new Error(`GDrive ${label} failed (${res.status}): ${await res.text()}`);
    }
    await delay(DRIVE_RETRY_DELAYS_MS[attempt]);
  }
}

function driveAuth(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function driveScope(params: URLSearchParams, sharedDriveId: string): URLSearchParams {
  params.set('supportsAllDrives', 'true');
  params.set('includeItemsFromAllDrives', 'true');
  if (sharedDriveId.trim()) {
    params.set('corpora', 'drive');
    params.set('driveId', sharedDriveId.trim());
  }
  return params;
}

export interface GDriveChild {
  id:           string;
  name:         string;
  mimeType:     string;
  size?:        string;
  md5Checksum?: string;
  createdTime?: string;
  /** Requested so the upload sweep can answer a share-link request without a second round trip;
   *  the dedupe tool ignores it. */
  webViewLink?: string;
}

export interface GDriveChildren {
  folders: GDriveChild[];
  files:   GDriveChild[];
}

/** Every non-trashed child of one folder, following `nextPageToken` to the end.
 *  A partial listing is worse than none here — it reads as "this folder is empty enough to delete" —
 *  so a failed page throws rather than returning what it has. */
export async function listGDriveChildren(
  accessToken:   string,
  folderId:      string,
  sharedDriveId: string,
): Promise<GDriveChildren> {
  const folders: GDriveChild[] = [];
  const files:   GDriveChild[] = [];
  let pageToken = '';

  do {
    const params = driveScope(new URLSearchParams({
      q:        `'${driveQuote(folderId)}' in parents and trashed=false`,
      fields:   'nextPageToken,files(id,name,mimeType,size,md5Checksum,createdTime,webViewLink)',
      orderBy:  'createdTime',
      pageSize: '200',
    }), sharedDriveId);
    if (pageToken) params.set('pageToken', pageToken);

    const res = await driveApiFetch(`${DRIVE_FILES}?${params}`, { headers: driveAuth(accessToken) }, 'list');
    const data = await res.json() as { files?: GDriveChild[]; nextPageToken?: string };
    for (const child of data.files ?? []) {
      (child.mimeType === FOLDER_MIME ? folders : files).push(child);
    }
    pageToken = data.nextPageToken ?? '';
  } while (pageToken);

  return { folders, files };
}

/**
 * Resolve a destination path to a folder id WITHOUT creating anything.
 *
 * The uploader's resolver creates missing segments, which is exactly wrong for a maintenance tool:
 * a typo in `remotePath` would mint an empty folder and then report a spotless tree. A missing
 * segment is an error here, and duplicate segments are reported so the caller can say which level
 * of the path is already duplicated.
 */
export async function resolveGDriveFolderPathStrict(
  accessToken:   string,
  folderPath:    string,
  sharedDriveId: string,
): Promise<{ id: string; duplicatePathSegments: GDriveDuplicateFolderNotice[] }> {
  const duplicatePathSegments: GDriveDuplicateFolderNotice[] = [];
  let parentId = sharedDriveId.trim() || 'root';
  let prefix = '';

  for (const part of folderPath.split('/').filter(Boolean)) {
    prefix = prefix ? `${prefix}/${part}` : part;
    const params = driveScope(new URLSearchParams({
      q:       `name='${driveQuote(part)}' and mimeType='${FOLDER_MIME}' and '${driveQuote(parentId)}' in parents and trashed=false`,
      fields:  'files(id,name,createdTime)',
      orderBy: 'createdTime',
    }), sharedDriveId);

    const res = await driveApiFetch(`${DRIVE_FILES}?${params}`, { headers: driveAuth(accessToken) }, 'folder list');
    const data = await res.json() as { files?: GDriveFolderRef[] };
    const match = pickCanonicalGDriveFolder(data.files ?? []);
    if (!match) throw new Error(`Drive folder "${prefix}" does not exist — nothing to clean up under it.`);
    if ((data.files?.length ?? 0) > 1) {
      duplicatePathSegments.push({ path: prefix, count: data.files!.length, chosenId: match.id });
    }
    parentId = match.id;
  }

  return { id: parentId, duplicatePathSegments };
}

/** Re-parent one child. Drive's move is a parent swap, so both ends are named explicitly and the
 *  file keeps its id — every rating, comment and share link that points at it survives. */
export async function moveGDriveChild(
  accessToken:  string,
  childId:      string,
  fromParentId: string,
  toParentId:   string,
): Promise<void> {
  const params = new URLSearchParams({
    addParents:        toParentId,
    removeParents:     fromParentId,
    fields:            'id,parents',
    supportsAllDrives: 'true',
  });
  await driveApiFetch(
    `${DRIVE_FILES}/${encodeURIComponent(childId)}?${params}`,
    { method: 'PATCH', headers: { ...driveAuth(accessToken), 'Content-Type': 'application/json' }, body: '{}' },
    'move',
  );
}

/** Trash, never `files.delete`: a merge that guessed wrong is recoverable from Drive's trash, and a
 *  trashed node is already invisible to `trashed=false` listings and to the mirrored local folder. */
export async function trashGDriveNode(accessToken: string, nodeId: string): Promise<void> {
  await driveApiFetch(
    `${DRIVE_FILES}/${encodeURIComponent(nodeId)}?supportsAllDrives=true&fields=id,trashed`,
    {
      method:  'PATCH',
      headers: { ...driveAuth(accessToken), 'Content-Type': 'application/json' },
      body:    JSON.stringify({ trashed: true }),
    },
    'trash',
  );
}
