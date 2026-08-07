/* Provider uploads — the size thresholds, the drive/folder targeting, and the skip decision.
 *
 * This is the end of a delivery run: the files are already staged and the client is waiting on a
 * link. Three things here fail SILENTLY rather than loudly, which is why they are pinned:
 *
 *   1. drive targeting — a wrong `driveId` uploads a client's deliverables into someone else's
 *      drive and still returns 200;
 *   2. the simple/chunked boundary — Graph rejects a >4 MiB single PUT, and Drive's multipart create
 *      holds the whole file in memory, so picking the wrong branch fails only on large files;
 *   3. Drive's checksum skip — too eager and a re-export silently keeps the OLD file; too timid and
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

const { graphDriveBase, uploadOneDriveFile, oneDriveRemoteItem, oneDriveShareLink } = await import('./onedrive');
const { uploadGDriveFile, drainGDriveDuplicateFolders, pickCanonicalGDriveFolder, sweepGDriveFolderFiles } = await import('./gdrive');
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

/* Bytes above each provider's threshold no longer travel through the webview — they are streamed
   from disk by `cloud_upload_stream`. So the large-file assertions moved from the fetch stub to the
   invoke stub, and they got STRONGER rather than weaker: as well as the URL and headers, they now
   pin the byte range actually read off disk, which is what a chunked session depends on and what
   `body.byteLength` could only imply. */
const streamedUploads = () => invokeStub.argsFor('cloud_upload_stream');
const streamedHeaders = (call: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(call.headers as Array<[string, string]>);

/** A file to upload, as the providers now take it. `bytes()` is the ≤threshold path only. */
const source = (size: number, path = '/local/OUT/deck.pdf') =>
  ({ path, size, bytes: async () => bytes(size) });

beforeEach(() => {
  invokeStub.reset();
  // A streamed upload succeeds by default; tests that care about the status override it.
  invokeStub.replies.set('cloud_upload_stream', {
    status: 200,
    body: JSON.stringify({ id: 'resumable-file', webViewLink: 'https://drive/big' }),
  });
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
    await uploadOneDriveFile('tok', source(1024), 'Sotto/ESS/deck.pdf', false);

    const call = stub.one(GRAPH_PUT);
    expect(call.method).toBe('PUT');
    expect(call.headers.Authorization).toBe('Bearer tok');
    expect(stub.matching(GRAPH_SESSION)).toHaveLength(0);
  });

  it('still uses a single PUT at EXACTLY 4 MiB — the boundary is inclusive', async () => {
    await uploadOneDriveFile('tok', source(4 * MIB), 'a/b.pdf', false);
    expect(stub.matching(GRAPH_PUT)).toHaveLength(1);
    expect(stub.matching(GRAPH_SESSION)).toHaveLength(0);
  });

  it('switches to an upload session one byte over the boundary', async () => {
    await uploadOneDriveFile('tok', source(4 * MIB + 1), 'a/b.pdf', false);
    expect(stub.matching(GRAPH_SESSION)).toHaveLength(1);
    expect(stub.matching(GRAPH_PUT)).toHaveLength(0);
  });

  it('never reads a session-sized file into memory', async () => {
    /* The whole point of the native transfer. `bytes()` is the webview path; a file that needs a
       session must go from disk to socket without ever being one object in this process. */
    const src = { ...source(12 * MIB), bytes: vi.fn(async () => bytes(12 * MIB)) };
    await uploadOneDriveFile('tok', src, 'a/b.pdf', false);

    expect(src.bytes).not.toHaveBeenCalled();
    expect(streamedUploads()).toHaveLength(2);
  });

  it('asks the session to REPLACE on conflict, so a re-export overwrites rather than duplicating', async () => {
    await uploadOneDriveFile('tok', source(5 * MIB), 'a/b.pdf', false);
    expect(stub.one(GRAPH_SESSION).json()).toEqual({
      item: { '@microsoft.graph.conflictBehavior': 'replace' },
    });
  });

  it('sends contiguous, correctly-labelled chunks covering the whole file', async () => {
    const total = 12 * MIB;                       // → 10 MiB + 2 MiB
    await uploadOneDriveFile('tok', source(total, '/local/big.mov'), 'a/b.pdf', false);

    const chunks = streamedUploads();
    expect(chunks).toHaveLength(2);
    expect(chunks.map(c => streamedHeaders(c)['Content-Range'])).toEqual([
      `bytes 0-${10 * MIB - 1}/${total}`,
      `bytes ${10 * MIB}-${total - 1}/${total}`,
    ]);
    // The bytes read off disk must be exactly the ones the range header claims, or Graph stalls the
    // session waiting for a byte that is never coming. Every chunk reads from the ONE source file.
    expect(chunks.map(c => [c.offset, c.length])).toEqual([[0, 10 * MIB], [10 * MIB, 2 * MIB]]);
    expect(chunks.every(c => c.filePath === '/local/big.mov')).toBe(true);
    expect(chunks.every(c => c.url === CHUNK_URL)).toBe(true);
    // Content-Length is set natively from the range; passing one from here could disagree with it.
    expect(chunks.every(c => !('Content-Length' in streamedHeaders(c)))).toBe(true);
  });

  it('accepts 200 and 201 on the final chunk, not only 202', async () => {
    invokeStub.replies.set('cloud_upload_stream', (args: Record<string, unknown>) =>
      (args.offset as number) === 10 * MIB ? { status: 201, body: '' } : { status: 202, body: '' });
    await expect(uploadOneDriveFile('tok', source(12 * MIB), 'a/b.pdf', false)).resolves.toBeNull();
  });

  it('throws on an unexpected chunk status rather than reporting success', async () => {
    invokeStub.replies.set('cloud_upload_stream', { status: 500, body: 'boom' });
    await expect(uploadOneDriveFile('tok', source(5 * MIB), 'a/b.pdf', false))
      .rejects.toThrow(/chunk upload failed \(500\).*boom/s);
  });

  it('throws when the session cannot be created', async () => {
    stub.route(GRAPH_SESSION, { status: 403, text: 'quota' });
    await expect(uploadOneDriveFile('tok', source(5 * MIB), 'a/b.pdf', false))
      .rejects.toThrow(/upload session failed \(403\).*quota/s);
  });

  it('throws on a failed simple upload', async () => {
    stub.route(GRAPH_PUT, { status: 507, text: 'insufficient storage' });
    await expect(uploadOneDriveFile('tok', source(10), 'a/b.pdf', false))
      .rejects.toThrow(/upload failed \(507\).*insufficient storage/s);
  });
});

describe('uploadOneDriveFile — targeting and links', () => {
  beforeEach(() => {
    stub.route(GRAPH_PUT, { json: { id: 'item1' } });
    stub.route(GRAPH_LINK, { json: { link: { webUrl: 'https://share/x' } } });
  });

  it('routes into the configured SharePoint drive, not the personal one', async () => {
    await uploadOneDriveFile('tok', source(10), 'a/b.pdf', false, 'b!drive');
    expect(stub.calls[0].url).toContain('/drives/b!drive/root:/');
    expect(stub.calls[0].url).not.toContain('/me/drive');
  });

  it('encodes each path SEGMENT but keeps the separators', async () => {
    /* "Client Assets/ESS 2026/a+b.pdf" must stay three folders deep with the spaces and + escaped —
       encoding the whole string would turn the slashes into %2F and create one long filename.
       The first segment deliberately CONTAINS A SPACE: that is what this test proves, and it used to
       be the product name until the Sotto rename replaced it with a single word, which quietly
       removed the space from the fixture while the encoded expectation still read `DC%20Hub`. */
    await uploadOneDriveFile('tok', source(10), 'Client Assets/ESS 2026/a+b.pdf', false);
    expect(stub.calls[0].url).toContain('root:/Client%20Assets/ESS%202026/a%2Bb.pdf:/content');
  });

  it('returns null and requests no link when getLink is false', async () => {
    await expect(uploadOneDriveFile('tok', source(10), 'a/b.pdf', false)).resolves.toBeNull();
    expect(stub.matching(GRAPH_LINK)).toHaveLength(0);
  });

  it('creates and returns a share link when asked', async () => {
    await expect(uploadOneDriveFile('tok', source(10), 'a/b.pdf', true)).resolves.toBe('https://share/x');
    expect(stub.matching(GRAPH_LINK)).toHaveLength(1);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   OneDrive — what is already up there
   ════════════════════════════════════════════════════════════════════════════ */

/** The item GET is the only thing standing between a cold cache and re-uploading the library, and
 *  every failure mode of it must send the caller to the upload path rather than to a skip. */
describe('oneDriveRemoteItem', () => {
  const ITEM = /graph\.microsoft\.com\/[^?]*root:\/[^:]*$/;

  it('reports the size and the QuickXorHash the skip decision compares against', async () => {
    stub.route(ITEM, { json: {
      size: 2048, webUrl: 'https://sp/deck', file: { hashes: { quickXorHash: 'QX==' } },
    } });

    await expect(oneDriveRemoteItem('tok', 'Client Assets/deck.pdf', 'b!drive')).resolves.toEqual({
      size: 2048, quickXorHash: 'QX==', webUrl: 'https://sp/deck',
    });
    // Same per-segment encoding as the upload, or the probe and the PUT address different items.
    expect(stub.calls[0].url).toContain('/drives/b!drive/root:/Client%20Assets/deck.pdf');
  });

  it('reports no hash for a personal drive, which publishes SHA-1/SHA-256 instead', async () => {
    stub.route(ITEM, { json: { size: 10, file: { hashes: { sha256Hash: 'AB' } } } });
    await expect(oneDriveRemoteItem('tok', 'deck.pdf')).resolves
      .toEqual({ size: 10, quickXorHash: undefined, webUrl: undefined });
  });

  it('reads a 404 as "nothing there", which is the ordinary first-export answer', async () => {
    stub.route(ITEM, { status: 404, text: 'itemNotFound' });
    await expect(oneDriveRemoteItem('tok', 'deck.pdf')).resolves.toBeNull();
  });

  it('reads an auth or server failure as "nothing there" too — never as a skip', async () => {
    stub.route(ITEM, { status: 401, text: 'InvalidAuthenticationToken' });
    await expect(oneDriveRemoteItem('tok', 'deck.pdf')).resolves.toBeNull();
    stub.route(ITEM, { status: 503, text: 'serviceNotAvailable' });
    await expect(oneDriveRemoteItem('tok', 'deck.pdf')).resolves.toBeNull();
  });

  it('reads a folder, or anything without a size, as nothing to compare against', async () => {
    stub.route(ITEM, { json: { folder: { childCount: 3 } } });
    await expect(oneDriveRemoteItem('tok', 'Client Assets')).resolves.toBeNull();
  });
});

describe('oneDriveShareLink', () => {
  it('creates a link for a file this run did not upload', async () => {
    // A skipped upload still owes the portal its URL; dropping it would blank the client's link.
    stub.route(GRAPH_LINK, { json: { link: { webUrl: 'https://share/skipped' } } });
    await expect(oneDriveShareLink('tok', 'Client Assets/deck.pdf', 'b!drive'))
      .resolves.toBe('https://share/skipped');
    expect(stub.one(GRAPH_LINK).url).toContain('/drives/b!drive/root:/Client%20Assets/deck.pdf:/createLink');
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
function routeDrive(opts: {
  existing?: { id: string; size: string; md5Checksum?: string; webViewLink?: string } | null;
} = {}) {
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

const LOCAL_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';

const upload = (over: Partial<{
  size: number; name: string; folder: string; getLink: boolean; driveId: string; md5: string;
  preListed: Map<string, Map<string, { id: string; size?: string; md5Checksum?: string; webViewLink?: string }>>;
}> = {}) => uploadGDriveFile(
  'tok',
  over.size ?? 1024,
  source(over.size ?? 1024),
  async () => over.md5 ?? LOCAL_MD5,
  'application/pdf',
  over.name ?? 'deck.pdf',
  over.folder ?? 'Sotto/ESS',
  over.getLink ?? false,
  over.driveId ?? '',
  '',
  over.preListed ?? null,
);

describe('pickCanonicalGDriveFolder', () => {
  it('is oldest-wins, so the uploader and the dedupe tool agree on one folder', () => {
    expect(pickCanonicalGDriveFolder([
      { id: 'b', createdTime: '2026-03-02T00:00:00Z' },
      { id: 'a', createdTime: '2026-01-09T00:00:00Z' },
    ])?.id).toBe('a');
  });

  it('falls back to the id so the pick is stable when timestamps tie or are missing', () => {
    const tied = [{ id: 'z', createdTime: 'T' }, { id: 'a', createdTime: 'T' }];
    expect(pickCanonicalGDriveFolder(tied)?.id).toBe('a');
    expect(pickCanonicalGDriveFolder([{ id: 'y' }, { id: 'x' }])?.id).toBe('x');
  });

  it('prefers a folder of KNOWN age over one of unknown age', () => {
    expect(pickCanonicalGDriveFolder([{ id: 'unknown' }, { id: 'dated', createdTime: '2026-05-05T00:00:00Z' }])?.id)
      .toBe('dated');
  });

  it('returns null for an empty set rather than throwing at the call site', () => {
    expect(pickCanonicalGDriveFolder([])).toBeNull();
  });
});

describe('uploadGDriveFile — the same-size skip', () => {
  it('SKIPS the upload when a same-name file has the same size and MD5', async () => {
    routeDrive({ existing: {
      id: 'old', size: '1024', md5Checksum: LOCAL_MD5, webViewLink: 'https://drive/old',
    } });
    const r = await upload({ size: 1024, folder: 'skip/same' });

    expect(r).toEqual({ url: null, skipped: true });
    expect(stub.matching(DRIVE_MULTIPART)).toHaveLength(0);
    expect(stub.matching(DRIVE_MEDIA)).toHaveLength(0);
  });

  it('returns the EXISTING link when a skipped file is asked for one', async () => {
    routeDrive({ existing: {
      id: 'old', size: '1024', md5Checksum: LOCAL_MD5, webViewLink: 'https://drive/old',
    } });
    await expect(upload({ size: 1024, getLink: true, folder: 'skip/link' }))
      .resolves.toEqual({ url: 'https://drive/old', skipped: true });
  });

  it('never reads the file bytes when it skips', async () => {
    // The checksum streams natively, but the webview never loads the full file or transfers it.
    routeDrive({ existing: { id: 'old', size: '1024', md5Checksum: LOCAL_MD5 } });
    const src = { ...source(1024), bytes: vi.fn(async () => bytes(1024)) };
    const getMd5 = vi.fn(async () => LOCAL_MD5);
    await uploadGDriveFile(
      'tok', 1024, src, getMd5, 'application/pdf', 'deck.pdf', 'skip/noread', false,
    );
    expect(src.bytes).not.toHaveBeenCalled();
    expect(getMd5).toHaveBeenCalledOnce();
  });

  it('UPDATES IN PLACE when equal-size content has a different MD5', async () => {
    routeDrive({ existing: { id: 'old', size: '1024', md5Checksum: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
    const r = await upload({ size: 1024, folder: 'update/equal-size' });

    expect(r.skipped).toBe(false);
    expect(stub.one(DRIVE_MEDIA).url).toContain('/files/old?');
    expect(stub.matching(DRIVE_MULTIPART)).toHaveLength(0);
  });

  it('updates when Drive has no MD5 instead of trusting size alone', async () => {
    routeDrive({ existing: { id: 'old', size: '1024' } });
    const r = await upload({ size: 1024, folder: 'update/no-md5' });

    expect(r.skipped).toBe(false);
    expect(stub.one(DRIVE_MEDIA).url).toContain('/files/old?');
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

describe('sweepGDriveFolderFiles', () => {
  const file = (id: string, name: string, over: Record<string, unknown> = {}) =>
    ({ id, name, mimeType: 'application/pdf', size: '10', ...over });

  it('returns one name→file map per folder, folders excluded', async () => {
    stub.route(DRIVE_LIST, c => {
      const parent = new URL(c.url).searchParams.get('q')?.match(/'([^']*)' in parents/)?.[1];
      return { json: { files: [
        file(`${parent}-a`, 'deck.pdf', { md5Checksum: 'aa', webViewLink: 'https://drive/a' }),
        { id: `${parent}-sub`, name: 'nested', mimeType: 'application/vnd.google-apps.folder' },
      ] } };
    });

    const swept = await sweepGDriveFolderFiles('tok', ['f1', 'f2'], '');

    expect([...swept!.keys()].sort()).toEqual(['f1', 'f2']);
    expect([...swept!.get('f1')!.keys()]).toEqual(['deck.pdf']);   // the folder is not a candidate
    expect(swept!.get('f2')!.get('deck.pdf')).toMatchObject({ id: 'f2-a', webViewLink: 'https://drive/a' });
  });

  it('keeps the OLDEST of same-named files, the rule the folder resolver already uses', async () => {
    // Drive allows two files of one name in a folder. Two runs picking differently would update
    // different copies, and the client opens whichever one their sync happened to show.
    stub.route(DRIVE_LIST, { json: { files: [
      file('oldest', 'deck.pdf'), file('newer', 'deck.pdf'),
    ] } });
    const swept = await sweepGDriveFolderFiles('tok', ['f1'], '');

    expect(swept!.get('f1')!.get('deck.pdf')!.id).toBe('oldest');
    // Asked of Drive in that order as well as taken in it — the listing may be paged.
    expect(new URL(stub.calls[0].url).searchParams.get('orderBy')).toBe('createdTime');
  });

  it('returns null when ANY folder fails, so the caller falls back per file', async () => {
    // A sweep believed complete when it is not reads as "this file is not there yet" and puts a
    // second copy beside the client's. Partial is never an answer; null is.
    stub.route(DRIVE_LIST, c =>
      new URL(c.url).searchParams.get('q')?.includes('broken')
        ? { status: 403, text: 'insufficientPermissions' }
        : { json: { files: [file('a', 'deck.pdf')] } });

    await expect(sweepGDriveFolderFiles('tok', ['fine', 'broken'], '')).resolves.toBeNull();
  });

  it('is a no-op with no folders, rather than a failed sweep', async () => {
    await expect(sweepGDriveFolderFiles('tok', [], '')).resolves.toEqual(new Map());
    expect(stub.calls).toHaveLength(0);
  });
});

/* One listing per folder replaces one lookup per file. The listing is taken before the batch starts
   (`sweepGDriveFolderFiles`), which is what makes a cold upload cache affordable — 300 assets in 12
   folders used to cost 300 round trips to learn what 12 would have said. */
describe('uploadGDriveFile — the pre-listed folder sweep', () => {
  /** `files.list` calls that asked about a FILE rather than resolving a folder. */
  const fileLookups = () => stub.matching(DRIVE_LIST)
    .filter(c => !FOLDER_Q.test(new URL(c.url).searchParams.get('q') ?? ''));

  it('decides the skip from the pre-listed children, without asking Drive about the file', async () => {
    routeDrive();
    const preListed = new Map([['folder-listedskip', new Map([
      ['deck.pdf', { id: 'known', size: '1024', md5Checksum: LOCAL_MD5, webViewLink: 'https://drive/known' }],
    ])]]);

    const r = await upload({ size: 1024, folder: 'prelist/listedskip', preListed });

    expect(r).toEqual({ url: null, skipped: true });
    expect(fileLookups()).toHaveLength(0);
  });

  it('treats a folder present in the sweep but missing the name as "not there yet"', async () => {
    routeDrive();
    const preListed = new Map([['folder-empty', new Map()]]);

    await upload({ folder: 'prelist/empty', preListed });

    expect(fileLookups()).toHaveLength(0);
    expect(stub.matching(DRIVE_MULTIPART)).toHaveLength(1);
  });

  it('folds a file it just created back into the sweep, so a same-name sibling updates in place', async () => {
    /* The one case the per-file lookup handled and a snapshot cannot: two jobs writing the same name
       into one folder — a flattened export where two galleries each hold an `01.jpg`. The second one
       used to find the first one's file and update it. Against a listing taken before either ran it
       would create a SECOND copy, which is the duplicate-in-Drive shape the folder work removed. */
    routeDrive();
    const preListed = new Map([['folder-writeback', new Map()]]);

    await upload({ folder: 'prelist/writeback', name: 'clash.jpg', preListed });
    await upload({ folder: 'prelist/writeback', name: 'clash.jpg', preListed });

    expect(stub.matching(DRIVE_MULTIPART)).toHaveLength(1);          // created once
    expect(stub.one(DRIVE_MEDIA).url).toContain('/files/new-file?'); // then updated in place
    expect(fileLookups()).toHaveLength(0);
  });

  it('still asks per file for a folder the sweep does not cover', async () => {
    // A failed sweep passes `null`; a partial one is not a state it can be in, but an unknown folder
    // id must fall back rather than be read as empty.
    routeDrive({ existing: { id: 'old', size: '1024', md5Checksum: LOCAL_MD5 } });
    const preListed = new Map([['some-other-folder', new Map()]]);

    const r = await upload({ size: 1024, folder: 'prelist/uncovered', preListed });

    expect(fileLookups()).toHaveLength(1);
    expect(r.skipped).toBe(true);
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

  it('streams a resumable body from disk without reading it into memory', async () => {
    /* The session is negotiated over `fetch` — it is a small JSON call — and only the BYTES go
       native. A 500 MB deliverable used to cross the IPC bridge into the webview and be posted from
       there, so it was copied twice and resident for the whole transfer. */
    routeDrive();
    const src = { ...source(50 * MIB, '/local/big.mov'), bytes: vi.fn(async () => bytes(50 * MIB)) };
    await uploadGDriveFile(
      'tok', 50 * MIB, src, async () => LOCAL_MD5,
      'video/quicktime', 'big.mov', 'new/streamed', false,
    );

    expect(src.bytes).not.toHaveBeenCalled();
    const [put] = streamedUploads();
    expect(put).toMatchObject({ url: RESUMABLE_URL, method: 'PUT', filePath: '/local/big.mov' });
    // The whole file: no range, and the length the session was told to expect comes from the stat.
    expect(put.offset).toBeNull();
    expect(put.length).toBeNull();
    expect(stub.one(DRIVE_RESUMABLE).headers['X-Upload-Content-Length']).toBe(String(50 * MIB));
  });

  it('reports a failed streamed upload with the provider body', async () => {
    routeDrive();
    invokeStub.replies.set('cloud_upload_stream', { status: 403, body: 'storageQuotaExceeded' });
    await expect(upload({ size: 6 * MIB, folder: 'new/streamfail' }))
      .rejects.toThrow(/resumable upload failed \(403\).*storageQuotaExceeded/s);
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

  it('deduplicates concurrent creates for the same missing folder path', async () => {
    stub.route(DRIVE_LIST, { json: { files: [] } });
    let nextFolder = 0;
    stub.route(DRIVE_CREATE, c => c.method === 'POST'
      ? { json: { id: `made-${++nextFolder}` } }
      : { json: { files: [] } });
    stub.route(DRIVE_MULTIPART, { json: { id: 'f' } });

    await Promise.all([
      upload({ folder: 'race/same-folder', name: 'a.pdf' }),
      upload({ folder: 'race/same-folder', name: 'b.pdf' }),
    ]);

    const creates = stub.matching(DRIVE_CREATE).filter(c => c.method === 'POST');
    expect(creates.map(c => (c.json() as { name: string }).name)).toEqual(['race', 'same-folder']);
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

  it('issues ONE create per segment when a whole batch starts on a missing folder', async () => {
    /* The duplicate-folder bug in one test. `cloudExport` uploads 8-wide, and Drive — unlike a
       filesystem — accepts eight folders of the same name in the same parent. Without the in-flight
       memo every member of the batch lists empty and creates its own, and Google Drive for Desktop
       then mirrors them locally as " (1)", " (2)"… with the files scattered between them. */
    stub.route(DRIVE_LIST, { json: { files: [] } });
    let nextFolder = 0;
    stub.route(DRIVE_CREATE, c => c.method === 'POST'
      ? { json: { id: `made-${++nextFolder}` } }
      : { json: { files: [] } });
    stub.route(DRIVE_MULTIPART, { json: { id: 'f' } });

    await Promise.all(Array.from({ length: 8 }, (_, i) =>
      upload({ folder: 'batch8/Deliverables', name: `file-${i}.pdf` })));

    const created = stub.matching(DRIVE_CREATE)
      .filter(c => c.method === 'POST')
      .map(c => (c.json() as { name: string }).name);
    expect(created).toEqual(['batch8', 'Deliverables']);   // one each, not eight
  });

  it('picks the OLDEST of same-named folders, so every run converges on one', async () => {
    // Drive returns duplicates in no guaranteed order; files[0] scatters a client's deliverables
    // across whichever copy came back first. Oldest-wins is the same rule the dedupe tool merges by.
    stub.route(DRIVE_LIST, c => {
      const q = new URL(c.url).searchParams.get('q') ?? '';
      if (!FOLDER_Q.test(q)) return { json: { files: [] } };
      return { json: { files: [
        { id: 'newer', name: 'dupes', createdTime: '2026-08-01T10:00:00.000Z' },
        { id: 'oldest', name: 'dupes', createdTime: '2026-07-04T09:00:00.000Z' },
      ] } };
    });
    stub.route(DRIVE_MULTIPART, { json: { id: 'f' } });
    drainGDriveDuplicateFolders();

    await upload({ folder: 'dupes', name: 'deck.pdf' });

    const body = new TextDecoder().decode(stub.one(DRIVE_MULTIPART).body as Uint8Array);
    expect(body).toContain('"parents":["oldest"]');
    // Asked of Drive as well as sorted locally — the list may be paged.
    expect(new URL(stub.matching(DRIVE_LIST)[0].url).searchParams.get('orderBy')).toBe('createdTime');
    expect(drainGDriveDuplicateFolders()).toEqual([{ path: 'dupes', count: 2, chosenId: 'oldest' }]);
  });

  it('does not poison the folder id when a resolve fails transiently', async () => {
    let attempt = 0;
    stub.route(DRIVE_LIST, c => {
      if (!FOLDER_Q.test(new URL(c.url).searchParams.get('q') ?? '')) return { json: { files: [] } };
      return ++attempt === 1
        ? { status: 503, text: 'backendError' }
        : { json: { files: [{ id: 'recovered', createdTime: '2026-01-01T00:00:00.000Z' }] } };
    });
    stub.route(DRIVE_MULTIPART, { json: { id: 'f' } });

    await expect(upload({ folder: 'transient', name: 'a.pdf' })).rejects.toThrow(/folder list failed \(503\)/);
    await upload({ folder: 'transient', name: 'b.pdf' });

    const body = new TextDecoder().decode(stub.one(DRIVE_MULTIPART).body as Uint8Array);
    expect(body).toContain('"parents":["recovered"]');
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
