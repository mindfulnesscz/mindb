/* Provider uploads — the size thresholds, the drive/folder targeting, and the skip decision.
 *
 * This is the end of a delivery run: the files are already staged and the client is waiting on a
 * link. Three things here fail SILENTLY rather than loudly, which is why they are pinned:
 *
 *   1. drive targeting — a wrong `driveId` uploads a client's deliverables into someone else's
 *      drive and still returns 200;
 *   2. the simple/chunked boundary — Graph rejects a >4 MiB single PUT, and Drive's multipart create
 *      holds the whole file in memory, so picking the wrong branch fails only on large files;
 *   3. Drive's same-size skip — too eager and a re-export silently keeps the OLD file; too timid and
 *      every run re-uploads every asset.
 *
 * Chunk ranges get exact assertions because Graph requires contiguous, correctly-labelled ranges and
 * answers a wrong one with a 4xx that reaches the operator as "chunk upload failed".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFetchStub, type FetchStub } from '../../test/fetchStub';
import { invokeStub } from '../../test/invokeStub';

vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args: Record<string, unknown>) => invokeStub.invoke(cmd, args) }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));

const { graphDriveBase, uploadOneDriveFile } = await import('./onedrive');
const { uploadGDriveFile } = await import('./gdrive');
const { uploadDropboxFile } = await import('./dropbox');

const MIB = 1024 * 1024;
const bytes = (n: number) => new Uint8Array(n) as Uint8Array<ArrayBuffer>;

/* Graph */
const GRAPH_PUT     = /graph\.microsoft\.com\/.*:\/content$/;
const GRAPH_SESSION = /createUploadSession$/;
const GRAPH_LINK    = /createLink$/;
const CHUNK_URL     = 'https://upload.example/session/abc';

/* Drive */
const DRIVE_LIST      = /www\.googleapis\.com\/drive\/v3\/files\?/;
const DRIVE_CREATE    = /www\.googleapis\.com\/drive\/v3\/files\?supportsAllDrives/;
const DRIVE_MULTIPART = /upload\/drive\/v3\/files\?uploadType=multipart/;
const DRIVE_RESUMABLE = /upload\/drive\/v3\/files.*uploadType=resumable/;
const DRIVE_MEDIA     = /upload\/drive\/v3\/files\/[^?]+\?uploadType=media/;
const RESUMABLE_URL   = 'https://upload.example/gdrive/session/xyz';
/* A folder lookup asks mimeType='…folder'; a FILE lookup asks mimeType!='…folder'. */
const FOLDER_Q        = /mimeType='application\/vnd\.google-apps\.folder'/;

let stub: FetchStub;

beforeEach(() => {
  invokeStub.reset();
  stub = installFetchStub();
});
afterEach(() => stub.restore());

/* ════════════════════════════════════════════════════════════════════════════
   graphDriveBase — pure, and the single point where SharePoint diverges
   ════════════════════════════════════════════════════════════════════════════ */

describe('graphDriveBase', () => {
  it('addresses the signed-in user’s own drive when no drive is configured', () => {
    expect(graphDriveBase()).toBe('https://graph.microsoft.com/v1.0/me/drive');
  });

  it('addresses a named drive when one is configured', () => {
    expect(graphDriveBase('b!abc123')).toBe('https://graph.microsoft.com/v1.0/drives/b!abc123');
  });

  it('treats a blank or whitespace-only drive id as "not configured"', () => {
    // The field is a text input on the destination form; an operator clearing it leaves whitespace,
    // and `/drives/%20` is a 400 rather than a fallback.
    expect(graphDriveBase('')).toContain('/me/drive');
    expect(graphDriveBase('   ')).toContain('/me/drive');
  });

  it('trims and percent-encodes the id — SharePoint ids contain ! and =', () => {
    expect(graphDriveBase('  b!x=y/z  ')).toBe('https://graph.microsoft.com/v1.0/drives/b!x%3Dy%2Fz');
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   OneDrive upload — the 4 MiB boundary
   ════════════════════════════════════════════════════════════════════════════ */

describe('uploadOneDriveFile — simple vs session', () => {
  beforeEach(() => {
    stub.route(GRAPH_PUT, { json: { id: 'item1' } });
    stub.route(GRAPH_SESSION, { json: { uploadUrl: CHUNK_URL } });
    stub.route(new RegExp(CHUNK_URL.replace(/[/.]/g, '\\$&')), { status: 202 });
  });

  it('uploads a small file as a single PUT', async () => {
    await uploadOneDriveFile('tok', bytes(1024), 'Sotto/ESS/deck.pdf', false);

    const call = stub.one(GRAPH_PUT);
    expect(call.method).toBe('PUT');
    expect(call.headers.Authorization).toBe('Bearer tok');
    expect(stub.matching(GRAPH_SESSION)).toHaveLength(0);
  });

  it('still uses a single PUT at EXACTLY 4 MiB — the boundary is inclusive', async () => {
    await uploadOneDriveFile('tok', bytes(4 * MIB), 'a/b.pdf', false);
    expect(stub.matching(GRAPH_PUT)).toHaveLength(1);
    expect(stub.matching(GRAPH_SESSION)).toHaveLength(0);
  });

  it('switches to an upload session one byte over the boundary', async () => {
    await uploadOneDriveFile('tok', bytes(4 * MIB + 1), 'a/b.pdf', false);
    expect(stub.matching(GRAPH_SESSION)).toHaveLength(1);
    expect(stub.matching(GRAPH_PUT)).toHaveLength(0);
  });

  it('asks the session to REPLACE on conflict, so a re-export overwrites rather than duplicating', async () => {
    await uploadOneDriveFile('tok', bytes(5 * MIB), 'a/b.pdf', false);
    expect(stub.one(GRAPH_SESSION).json()).toEqual({
      item: { '@microsoft.graph.conflictBehavior': 'replace' },
    });
  });

  it('sends contiguous, correctly-labelled chunks covering the whole file', async () => {
    const total = 12 * MIB;                       // → 10 MiB + 2 MiB
    await uploadOneDriveFile('tok', bytes(total), 'a/b.pdf', false);

    const chunks = stub.matching(/upload\.example\/session/);
    expect(chunks).toHaveLength(2);
    expect(chunks.map(c => c.headers['Content-Range'])).toEqual([
      `bytes 0-${10 * MIB - 1}/${total}`,
      `bytes ${10 * MIB}-${total - 1}/${total}`,
    ]);
    // The declared length must match the bytes actually sent, or Graph stalls the session.
    expect(chunks.map(c => c.size())).toEqual([10 * MIB, 2 * MIB]);
    expect(chunks.map(c => Number(c.headers['Content-Length']))).toEqual([10 * MIB, 2 * MIB]);
  });

  it('accepts 200 and 201 on the final chunk, not only 202', async () => {
    stub.route(/upload\.example\/session/, c =>
      (c.headers['Content-Range'] as string).startsWith('bytes 10485760') ? { status: 201 } : { status: 202 });
    await expect(uploadOneDriveFile('tok', bytes(12 * MIB), 'a/b.pdf', false)).resolves.toBeNull();
  });

  it('throws on an unexpected chunk status rather than reporting success', async () => {
    stub.route(/upload\.example\/session/, { status: 500, text: 'boom' });
    await expect(uploadOneDriveFile('tok', bytes(5 * MIB), 'a/b.pdf', false))
      .rejects.toThrow(/chunk upload failed \(500\).*boom/s);
  });

  it('throws when the session cannot be created', async () => {
    stub.route(GRAPH_SESSION, { status: 403, text: 'quota' });
    await expect(uploadOneDriveFile('tok', bytes(5 * MIB), 'a/b.pdf', false))
      .rejects.toThrow(/upload session failed \(403\).*quota/s);
  });

  it('throws on a failed simple upload', async () => {
    stub.route(GRAPH_PUT, { status: 507, text: 'insufficient storage' });
    await expect(uploadOneDriveFile('tok', bytes(10), 'a/b.pdf', false))
      .rejects.toThrow(/upload failed \(507\).*insufficient storage/s);
  });
});

describe('uploadOneDriveFile — targeting and links', () => {
  beforeEach(() => {
    stub.route(GRAPH_PUT, { json: { id: 'item1' } });
    stub.route(GRAPH_LINK, { json: { link: { webUrl: 'https://share/x' } } });
  });

  it('routes into the configured SharePoint drive, not the personal one', async () => {
    await uploadOneDriveFile('tok', bytes(10), 'a/b.pdf', false, 'b!drive');
    expect(stub.calls[0].url).toContain('/drives/b!drive/root:/');
    expect(stub.calls[0].url).not.toContain('/me/drive');
  });

  it('encodes each path SEGMENT but keeps the separators', async () => {
    /* "Client Assets/ESS 2026/a+b.pdf" must stay three folders deep with the spaces and + escaped —
       encoding the whole string would turn the slashes into %2F and create one long filename.
       The first segment deliberately CONTAINS A SPACE: that is what this test proves, and it used to
       be the product name until the Sotto rename replaced it with a single word, which quietly
       removed the space from the fixture while the encoded expectation still read `DC%20Hub`. */
    await uploadOneDriveFile('tok', bytes(10), 'Client Assets/ESS 2026/a+b.pdf', false);
    expect(stub.calls[0].url).toContain('root:/Client%20Assets/ESS%202026/a%2Bb.pdf:/content');
  });

  it('returns null and requests no link when getLink is false', async () => {
    await expect(uploadOneDriveFile('tok', bytes(10), 'a/b.pdf', false)).resolves.toBeNull();
    expect(stub.matching(GRAPH_LINK)).toHaveLength(0);
  });

  it('creates and returns a share link when asked', async () => {
    await expect(uploadOneDriveFile('tok', bytes(10), 'a/b.pdf', true)).resolves.toBe('https://share/x');
    expect(stub.matching(GRAPH_LINK)).toHaveLength(1);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   Google Drive upload — folder walk, the skip decision, the 5 MiB boundary
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * Drive answers the same `/drive/v3/files` URL for a folder lookup, a folder create and a file
 * lookup, so the fake dispatches on method and on the `q` parameter — closer to the real API's
 * shape than one canned reply would be.
 *
 * Folder paths must be UNIQUE per test: `getOrCreateGDriveFolder` caches ids in module state, which
 * is the behaviour the last test in this block asserts.
 */
function routeDrive(opts: { existing?: { id: string; size: string; webViewLink?: string } | null } = {}) {
  stub.route(DRIVE_LIST, c => {
    const q = new URL(c.url).searchParams.get('q') ?? '';
    if (FOLDER_Q.test(q)) return { json: { files: [{ id: `folder-${q.match(/name='([^']*)'/)?.[1]}` }] } };
    return { json: { files: opts.existing ? [opts.existing] : [] } };
  });
  stub.route(DRIVE_MULTIPART, { json: { id: 'new-file', webViewLink: 'https://drive/new' } });
  stub.route(DRIVE_MEDIA,     { json: { id: 'updated-file', webViewLink: 'https://drive/updated' } });
  stub.route(DRIVE_RESUMABLE, { headers: { Location: RESUMABLE_URL }, json: {} });
  stub.route(/upload\.example\/gdrive/, { json: { id: 'resumable-file', webViewLink: 'https://drive/big' } });
}

const upload = (over: Partial<{
  size: number; name: string; folder: string; getLink: boolean; driveId: string;
}> = {}) => uploadGDriveFile(
  'tok',
  over.size ?? 1024,
  async () => bytes(over.size ?? 1024),
  'application/pdf',
  over.name ?? 'deck.pdf',
  over.folder ?? 'Sotto/ESS',
  over.getLink ?? false,
  over.driveId ?? '',
);

describe('uploadGDriveFile — the same-size skip', () => {
  it('SKIPS the upload when a same-name file already has the same size', async () => {
    // Drive has no cheap content hash, so size is the cheap proxy. This is what keeps a re-export of
    // an unchanged 200-asset client from re-transferring every file.
    routeDrive({ existing: { id: 'old', size: '1024', webViewLink: 'https://drive/old' } });
    const r = await upload({ size: 1024, folder: 'skip/same' });

    expect(r).toEqual({ url: null, skipped: true });
    expect(stub.matching(DRIVE_MULTIPART)).toHaveLength(0);
    expect(stub.matching(DRIVE_MEDIA)).toHaveLength(0);
  });

  it('returns the EXISTING link when a skipped file is asked for one', async () => {
    routeDrive({ existing: { id: 'old', size: '1024', webViewLink: 'https://drive/old' } });
    await expect(upload({ size: 1024, getLink: true, folder: 'skip/link' }))
      .resolves.toEqual({ url: 'https://drive/old', skipped: true });
  });

  it('never reads the file bytes when it skips', async () => {
    // The whole point of the skip: no disk read, no transfer.
    routeDrive({ existing: { id: 'old', size: '1024' } });
    const getBytes = vi.fn(async () => bytes(1024));
    await uploadGDriveFile('tok', 1024, getBytes, 'application/pdf', 'deck.pdf', 'skip/noread', false);
    expect(getBytes).not.toHaveBeenCalled();
  });

  it('UPDATES IN PLACE when the size differs — no second same-name file', async () => {
    // Creating instead of updating leaves two "deck.pdf" in one folder and the client opens the
    // wrong one; Drive allows duplicate names, unlike a filesystem.
    routeDrive({ existing: { id: 'old', size: '999' } });
    const r = await upload({ size: 2048, folder: 'update/media' });

    expect(r.skipped).toBe(false);
    expect(stub.one(DRIVE_MEDIA).method).toBe('PATCH');
    expect(stub.one(DRIVE_MEDIA).url).toContain('/files/old?');
    expect(stub.matching(DRIVE_MULTIPART)).toHaveLength(0);
  });

  it('uses a resumable session for a large in-place update', async () => {
    routeDrive({ existing: { id: 'old', size: '999' } });
    await upload({ size: 6 * MIB, folder: 'update/big' });

    expect(stub.matching(DRIVE_RESUMABLE)).toHaveLength(1);
    expect(stub.matching(DRIVE_MEDIA)).toHaveLength(0);
  });
});

describe('uploadGDriveFile — the 5 MiB boundary', () => {
  it('creates a small new file with a multipart request', async () => {
    routeDrive();
    const r = await upload({ size: 1024, folder: 'new/small', getLink: true });

    expect(r).toEqual({ url: 'https://drive/new', skipped: false });
    const call = stub.one(DRIVE_MULTIPART);
    expect(call.headers['Content-Type']).toContain('multipart/related; boundary=');
    // Metadata and bytes travel in one body, so it must be longer than the file itself.
    expect(call.size()).toBeGreaterThan(1024);
  });

  it('still uses multipart at EXACTLY 5 MiB', async () => {
    routeDrive();
    await upload({ size: 5 * MIB, folder: 'new/exact' });
    expect(stub.matching(DRIVE_MULTIPART)).toHaveLength(1);
    expect(stub.matching(DRIVE_RESUMABLE)).toHaveLength(0);
  });

  it('switches to a resumable session one byte over', async () => {
    routeDrive();
    const r = await upload({ size: 5 * MIB + 1, folder: 'new/over' });

    expect(stub.matching(DRIVE_RESUMABLE)).toHaveLength(1);
    expect(stub.matching(DRIVE_MULTIPART)).toHaveLength(0);
    expect(r).toEqual({ url: null, skipped: false });
  });

  it('names the file and parents it correctly in the multipart metadata', async () => {
    routeDrive();
    await upload({ name: 'Q3 deck.pdf', folder: 'new/meta' });

    const body = new TextDecoder().decode(stub.one(DRIVE_MULTIPART).body as Uint8Array);
    expect(body).toContain('"name":"Q3 deck.pdf"');
    expect(body).toContain('"parents":["folder-meta"]');
  });

  it('throws with the provider body when a create fails', async () => {
    routeDrive();
    stub.route(DRIVE_MULTIPART, { status: 403, text: 'storageQuotaExceeded' });
    await expect(upload({ folder: 'new/fail' })).rejects.toThrow(/upload failed \(403\).*storageQuotaExceeded/s);
  });
});

describe('uploadGDriveFile — folder resolution', () => {
  it('walks the path segment by segment, because Drive folders are ids and not paths', async () => {
    routeDrive();
    await upload({ folder: 'walk/Sotto/ESS' });

    const queries = stub.matching(DRIVE_LIST)
      .map(c => new URL(c.url).searchParams.get('q') ?? '')
      .filter(q => FOLDER_Q.test(q));
    expect(queries).toHaveLength(3);
    // Each lookup is scoped to the id resolved by the previous one — a flat search would match a
    // same-named folder anywhere in the drive.
    expect(queries[0]).toContain("'root' in parents");
    expect(queries[1]).toContain("'folder-walk' in parents");
    expect(queries[2]).toContain("'folder-Sotto' in parents");
  });

  it('creates a missing folder instead of failing the upload', async () => {
    stub.route(DRIVE_LIST, { json: { files: [] } });
    stub.route(DRIVE_CREATE, c => c.method === 'POST' ? { json: { id: 'made' } } : { json: { files: [] } });
    stub.route(DRIVE_MULTIPART, { json: { id: 'f' } });

    await upload({ folder: 'create/Missing' });
    const creates = stub.matching(DRIVE_CREATE).filter(c => c.method === 'POST');
    expect(creates).toHaveLength(2);
    expect(creates[0].json()).toMatchObject({ mimeType: 'application/vnd.google-apps.folder', name: 'create' });
  });

  it('scopes the search to a shared drive when one is configured', async () => {
    routeDrive();
    await upload({ folder: 'shared/path', driveId: 'sd-1' });

    const q = stub.matching(DRIVE_LIST)[0];
    const params = new URL(q.url).searchParams;
    expect(params.get('corpora')).toBe('drive');
    expect(params.get('driveId')).toBe('sd-1');
    // The walk starts at the shared drive's root, not the user's My Drive.
    expect(params.get('q')).toContain("'sd-1' in parents");
  });

  it('escapes a quote in a folder name rather than breaking the query', async () => {
    routeDrive();
    await upload({ folder: "quote/Bob's Files" });
    const q = stub.matching(DRIVE_LIST).map(c => new URL(c.url).searchParams.get('q') ?? '');
    expect(q.some(s => s.includes("Bob\\'s Files"))).toBe(true);
  });

  it('CACHES a resolved folder path — a 200-asset run resolves it once', async () => {
    routeDrive();
    await upload({ folder: 'cached/once', name: 'a.pdf' });
    const first = stub.matching(DRIVE_LIST).filter(c => FOLDER_Q.test(new URL(c.url).searchParams.get('q') ?? '')).length;

    await upload({ folder: 'cached/once', name: 'b.pdf' });
    const second = stub.matching(DRIVE_LIST).filter(c => FOLDER_Q.test(new URL(c.url).searchParams.get('q') ?? '')).length;

    expect(first).toBe(2);
    expect(second).toBe(2);   // unchanged: the second upload made no folder lookups
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   Dropbox — delegated to Rust
   ════════════════════════════════════════════════════════════════════════════ */

describe('uploadDropboxFile', () => {
  it('hands the whole job to Rust, which owns the chunked-session split', async () => {
    // Deliberately NOT implemented in the webview: Dropbox needs a chunked session above ~150 MB,
    // and streaming from disk in Rust avoids holding a large deliverable in webview memory.
    invokeStub.replies.set('upload_to_dropbox', { url: 'https://db/x', skipped: false });

    const r = await uploadDropboxFile('tok', '/local/OUT/deck.pdf', '/Sotto/ESS/deck.pdf', true);

    expect(r).toEqual({ url: 'https://db/x', skipped: false });
    expect(invokeStub.argsFor('upload_to_dropbox')).toEqual([{
      filePath: '/local/OUT/deck.pdf',
      remotePath: '/Sotto/ESS/deck.pdf',
      accessToken: 'tok',
      getLink: true,
    }]);
    expect(stub.calls).toHaveLength(0);
  });
});
