/* CLOUD EXPORT with a COLD upload cache — the run this stage was never written for.
 *
 * With a warm `cloud-upload-cache.json` the export is already fast: mtime+size match, no network,
 * no reads. Every cache MISS was the expensive path, and the whole library misses on a first run, a
 * reconnected destination, a cleared app data folder, or a Dropbox sync that touched every mtime.
 * Three things made that miss cost far more than it had to, and each one is pinned here:
 *
 *   1. a content hash re-computed per destination and per run — and hashing means READING, which on
 *      an online-only source file means DOWNLOADING it;
 *   2. one Drive `files.list` per file, where one listing per folder answers the same question;
 *   3. OneDrive having no skip at all — it read every file and PUT it, every time.
 *
 * The suite drives the real `runPipeline`, so what it characterizes is the stage as it runs; the
 * providers are stubbed at the `cloudService` boundary, which is where the round trips would be.
 *
 * Destination ids and source paths are DISTINCT PER TEST on purpose: the upload cache is memoized
 * for the process lifetime, so a shared id or path would let one test's run be served from another's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const uploadDropboxFile      = vi.fn();
const uploadOneDriveFile     = vi.fn();
const uploadGDriveFile       = vi.fn();
const ensureGDriveFolderPaths = vi.fn();
const sweepGDriveFolderFiles = vi.fn();
const oneDriveRemoteItem     = vi.fn();
const oneDriveShareLink      = vi.fn();
const drainGDriveDuplicateFolders = vi.fn(() => [] as Array<{ path: string; count: number; chosenId: string }>);

vi.mock('@tauri-apps/plugin-fs', async () => (await import('../test/vfs')).vfs.fsApi());
vi.mock('@tauri-apps/api/path', async () => (await import('../test/vfs')).vfs.pathApi());
vi.mock('@tauri-apps/api/core', async () => ({
  invoke: (await import('../test/invokeStub')).invokeStub.invoke,
}));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: async () => {} }));
vi.mock('./cloudService', () => ({
  uploadDropboxFile:  (...args: unknown[]) => uploadDropboxFile(...args),
  uploadOneDriveFile: (...args: unknown[]) => uploadOneDriveFile(...args),
  uploadGDriveFile:   (...args: unknown[]) => uploadGDriveFile(...args),
  ensureGDriveFolderPaths: (...args: unknown[]) => ensureGDriveFolderPaths(...args),
  sweepGDriveFolderFiles:  (...args: unknown[]) => sweepGDriveFolderFiles(...args),
  oneDriveRemoteItem: (...args: unknown[]) => oneDriveRemoteItem(...args),
  oneDriveShareLink:  (...args: unknown[]) => oneDriveShareLink(...args),
  drainGDriveDuplicateFolders: () => drainGDriveDuplicateFolders(),
}));

const { vfs } = await import('../test/vfs');
const { invokeStub } = await import('../test/invokeStub');
const { runPipeline } = await import('./pipelineService');
const { makeCtx, makeSettings, SRC } = await import('../test/pipelineHarness');

const LOCAL_MD5      = 'd41d8cd98f00b204e9800998ecf8427e';
const LOCAL_QUICKXOR = 'zqmDtLPfR7Ck6Jm1XmxDDJ8AAAA=';
/** Nine bytes, so a size comparison in a test is a real one and not `0 === 0`. */
const PDF_BYTES = 'pdf-bytes';

beforeEach(() => {
  vfs.reset();
  invokeStub.reset();
  invokeStub.replies.set('file_md5', LOCAL_MD5);
  invokeStub.replies.set('file_quick_xor_hash', LOCAL_QUICKXOR);
  for (const m of [uploadDropboxFile, uploadOneDriveFile, uploadGDriveFile,
                   ensureGDriveFolderPaths, sweepGDriveFolderFiles,
                   oneDriveRemoteItem, oneDriveShareLink, drainGDriveDuplicateFolders]) {
    m.mockReset();
  }
  drainGDriveDuplicateFolders.mockReturnValue([]);
  ensureGDriveFolderPaths.mockResolvedValue(new Map());
  sweepGDriveFolderFiles.mockResolvedValue(new Map());
  oneDriveRemoteItem.mockResolvedValue(null);
  uploadOneDriveFile.mockResolvedValue(null);
  uploadGDriveFile.mockResolvedValue({ url: null, skipped: false });
});

function gdriveDest(id: string, over: Record<string, unknown> = {}) {
  return {
    id, name: `Drive ${id}`, role: 'client', minRole: 'member',
    exportLayout: 'folders', includePackages: false, generateLink: false,
    showInPortal: true, allowRevealLocal: false, enabled: true,
    config: {
      type: 'gdrive', clientId: 'client', clientSecret: 'secret', sharedDriveId: 'sd-1',
      remotePath: 'Deliverables/',
      token: {
        accessToken: 'token', refreshToken: '', expiresAt: Number.MAX_SAFE_INTEGER,
        email: '', displayName: '',
      },
    },
    ...over,
  };
}

function onedriveDest(id: string, over: Record<string, unknown> = {}) {
  return {
    id, name: `OneDrive ${id}`, role: 'client', minRole: 'member',
    exportLayout: 'folders', includePackages: false, generateLink: false,
    showInPortal: true, allowRevealLocal: false, enabled: true,
    config: {
      type: 'onedrive', clientId: 'client', driveId: 'b!drive', remotePath: 'Deliverables/',
      token: {
        accessToken: 'token', refreshToken: '', expiresAt: Number.MAX_SAFE_INTEGER,
        email: '', displayName: '',
      },
    },
    ...over,
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   E1 — a file's content is hashed at most once, ever
   ════════════════════════════════════════════════════════════════════════════ */

describe('content hashes are memoized per source file', () => {
  it('hashes an unchanged file ONCE however many destinations ask for it', async () => {
    /* `file_md5` reads the whole local file. On a Dropbox or iCloud source tree that means macOS
       materializes an online-only file just to answer "has this changed" — the same bug class as
       the byte-compare removed from `isUnchanged`. Two Drive destinations used to pay it twice for
       the same bytes, and a re-connected destination paid it again on every later run. */
    vfs.tree(SRC, { 'Memo __a1b2c3d4/[03] OUT/Deck.pdf': PDF_BYTES });
    // Stand in for the provider actually needing the checksum (same-size remote).
    uploadGDriveFile.mockImplementation(async (...args: unknown[]) => {
      await (args[3] as () => Promise<string>)();
      return { url: null, skipped: true };
    });

    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudDestinations: [gdriveDest('memo-a'), gdriveDest('memo-b')],
    });
    await runPipeline(run.ctx as never);

    expect(uploadGDriveFile).toHaveBeenCalledTimes(2);   // both destinations asked
    expect(invokeStub.argsFor('file_md5')).toHaveLength(1);   // one hash between them
  });

  it('keeps the memo in the upload cache, so the next run does not re-hash either', async () => {
    vfs.tree(SRC, { 'Persist __b2c3d4e5/[03] OUT/Deck.pdf': PDF_BYTES });
    uploadGDriveFile.mockImplementation(async (...args: unknown[]) => {
      await (args[3] as () => Promise<string>)();
      return { url: null, skipped: true };
    });

    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudDestinations: [gdriveDest('persist-a')],
    });
    await runPipeline(run.ctx as never);

    // Written to disk beside the per-destination records rather than held only in memory: the point
    // is the run AFTER this one, in a new process.
    const cache = JSON.parse(vfs.text('/appdata/cloud-upload-cache.json')) as {
      uploads: Record<string, unknown>; hashes: Record<string, { md5?: string }>;
    };
    expect(cache.hashes[`${SRC}/Persist __b2c3d4e5/[03] OUT/Deck.pdf`]?.md5).toBe(LOCAL_MD5);
    // Only this test's destination — the cache file is shared process state, as it is in the app.
    expect(Object.keys(cache.uploads).filter(k => k.startsWith('persist-a::')))
      .toEqual(['persist-a::Deck.pdf']);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   E2 — one folder listing per destination, not one lookup per file
   ════════════════════════════════════════════════════════════════════════════ */

describe('Google Drive folder sweep', () => {
  it('lists each resolved folder once and hands the result to every upload', async () => {
    vfs.tree(SRC, {
      'Sweep __c3d4e5f6/[03] OUT/Set A/01.jpg': 'a',
      'Sweep __c3d4e5f6/[03] OUT/Set A/02.jpg': 'b',
      'Sweep __c3d4e5f6/[03] OUT/Set B/03.jpg': 'c',
    });
    const folderIds = new Map([
      ['Deliverables/Set A', 'folder-a'],
      ['Deliverables/Set B', 'folder-b'],
    ]);
    const children = new Map([['folder-a', new Map()], ['folder-b', new Map()]]);
    ensureGDriveFolderPaths.mockResolvedValue(folderIds);
    sweepGDriveFolderFiles.mockResolvedValue(children);

    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudDestinations: [gdriveDest('sweep-ok')],
    });
    await runPipeline(run.ctx as never);

    // Exactly the folders the pre-resolve produced — swept once, not once per file.
    expect(sweepGDriveFolderFiles).toHaveBeenCalledOnce();
    const [token, ids, sharedDriveId] = sweepGDriveFolderFiles.mock.calls[0] as
      [string, Iterable<string>, string];
    expect(token).toBe('token');
    expect(sharedDriveId).toBe('sd-1');
    expect([...ids].sort()).toEqual(['folder-a', 'folder-b']);

    // Three files, one listing, and every upload told what is already there.
    expect(uploadGDriveFile).toHaveBeenCalledTimes(3);
    for (const call of uploadGDriveFile.mock.calls) expect(call[10]).toBe(children);
    expect(sweepGDriveFolderFiles.mock.invocationCallOrder[0])
      .toBeLessThan(uploadGDriveFile.mock.invocationCallOrder[0]);
  });

  it('falls back to a per-file lookup when the sweep fails, and says so', async () => {
    /* A partial or failed listing must never read as "this file is not there yet" — that is how a
       second copy lands beside the client's existing file. `null` is the same "no manifest"
       convention the CDN key sweep uses, and it means every upload asks Drive for itself. */
    vfs.tree(SRC, { 'Fallback __d4e5f6a7/[03] OUT/Set A/01.jpg': 'a' });
    ensureGDriveFolderPaths.mockResolvedValue(new Map([['Deliverables/Set A', 'folder-a']]));
    sweepGDriveFolderFiles.mockResolvedValue(null);

    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudDestinations: [gdriveDest('sweep-null')],
    });
    const stats = await runPipeline(run.ctx as never);

    expect(uploadGDriveFile).toHaveBeenCalledOnce();
    expect(uploadGDriveFile.mock.calls[0][10]).toBeNull();
    expect(stats.errors).toBe(0);
    expect(run.logged('folder sweep failed')).toBe(true);
  });

  it('skips the sweep entirely when the pre-resolve failed — no ids to list', async () => {
    vfs.tree(SRC, { 'NoResolve __e5f6a7b8/[03] OUT/Set A/01.jpg': 'a' });
    ensureGDriveFolderPaths.mockRejectedValue(new Error('rate limited'));

    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudDestinations: [gdriveDest('sweep-noresolve')],
    });
    const stats = await runPipeline(run.ctx as never);

    expect(sweepGDriveFolderFiles).not.toHaveBeenCalled();
    expect(uploadGDriveFile.mock.calls[0][10]).toBeNull();
    expect(stats.errors).toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   E3 — OneDrive learns to skip
   ════════════════════════════════════════════════════════════════════════════ */

describe('OneDrive skip-if-unchanged', () => {
  it('skips a remote copy of the same size and hash without reading the file', async () => {
    vfs.tree(SRC, { 'Odskip __f6a7b8c9/[03] OUT/Deck.pdf': PDF_BYTES });
    oneDriveRemoteItem.mockResolvedValue({
      size: PDF_BYTES.length, quickXorHash: LOCAL_QUICKXOR, webUrl: 'https://sp/deck',
    });

    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudDestinations: [onedriveDest('od-skip')],
    });
    const stats = await runPipeline(run.ctx as never);

    expect(oneDriveRemoteItem).toHaveBeenCalledWith('token', 'Deliverables/Deck.pdf', 'b!drive');
    expect(uploadOneDriveFile).not.toHaveBeenCalled();
    expect(stats.published).toBe(0);
    expect(run.logged('1 remote-skip')).toBe(true);
  });

  it('uploads when the remote hash differs, even at an identical size', async () => {
    // The whole reason size alone is not the test: an edit that preserves the byte count would
    // otherwise leave the client on the old file forever.
    vfs.tree(SRC, { 'Odchange __a7b8c9d0/[03] OUT/Deck.pdf': PDF_BYTES });
    oneDriveRemoteItem.mockResolvedValue({ size: PDF_BYTES.length, quickXorHash: 'someOtherHash=' });

    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudDestinations: [onedriveDest('od-change')],
    });
    const stats = await runPipeline(run.ctx as never);

    expect(uploadOneDriveFile).toHaveBeenCalledOnce();
    expect(stats.published).toBe(1);
  });

  it('uploads when the item publishes no quickXorHash — personal OneDrive does not', async () => {
    vfs.tree(SRC, { 'Odnohash __b8c9d0e1/[03] OUT/Deck.pdf': PDF_BYTES });
    oneDriveRemoteItem.mockResolvedValue({ size: PDF_BYTES.length });

    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudDestinations: [onedriveDest('od-nohash')],
    });
    await runPipeline(run.ctx as never);

    expect(invokeStub.argsFor('file_quick_xor_hash')).toHaveLength(0);   // nothing to compare to
    expect(uploadOneDriveFile).toHaveBeenCalledOnce();
  });

  it('does not hash at all when the remote size already differs', async () => {
    vfs.tree(SRC, { 'Odsize __c9d0e1f2/[03] OUT/Deck.pdf': PDF_BYTES });
    oneDriveRemoteItem.mockResolvedValue({ size: PDF_BYTES.length + 1, quickXorHash: LOCAL_QUICKXOR });

    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudDestinations: [onedriveDest('od-size')],
    });
    await runPipeline(run.ctx as never);

    expect(invokeStub.argsFor('file_quick_xor_hash')).toHaveLength(0);
    expect(uploadOneDriveFile).toHaveBeenCalledOnce();
  });

  it('still collects a sharing link for a file it skipped', async () => {
    // The link goes to the portal. A skipped upload that dropped it would blank the client's link.
    vfs.tree(SRC, { 'Odlink __d0e1f2a3/[03] OUT/Deck.pdf': PDF_BYTES });
    oneDriveRemoteItem.mockResolvedValue({ size: PDF_BYTES.length, quickXorHash: LOCAL_QUICKXOR });
    oneDriveShareLink.mockResolvedValue('https://sp/shared/deck');
    const cloudUrls = new Map<string, unknown>();

    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudUrls,
      cloudDestinations: [onedriveDest('od-link', { generateLink: true })],
    });
    await runPipeline(run.ctx as never);

    expect(uploadOneDriveFile).not.toHaveBeenCalled();
    expect(cloudUrls.get('d0e1f2a3:c1')).toEqual([{
      destId: 'od-link', provider: 'onedrive', name: 'OneDrive od-link',
      url: 'https://sp/shared/deck',
    }]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   A stopped run keeps what it learned
   ════════════════════════════════════════════════════════════════════════════ */

describe('stopping mid-export', () => {
  it('writes the upload cache on the way out instead of discarding the run', async () => {
    /* Stopping a long export is a normal thing to do. The cache used to be written only after the
       LAST destination, so a stop threw away every record of what had already been sent — and the
       next run started cold against a destination that was half up to date. */
    vfs.tree(SRC, {
      'Stop __e1f2a3b4/[03] OUT/01.jpg': 'a',
      'Stop __e1f2a3b4/[03] OUT/02.jpg': 'b',
    });
    let stopping = false;
    uploadGDriveFile.mockImplementation(async () => {
      stopping = true;                        // the first upload is the last one dispatched
      return { url: null, skipped: false };
    });

    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      isStopping: () => stopping,
      cloudDestinations: [gdriveDest('stopped')],
    });
    await runPipeline(run.ctx as never);

    // Without the flush on the stop path this file does not exist at all for this destination.
    const cache = JSON.parse(vfs.text('/appdata/cloud-upload-cache.json')) as {
      uploads: Record<string, unknown>;
    };
    const recorded = Object.keys(cache.uploads).filter(k => k.startsWith('stopped::'));
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded).toHaveLength(uploadGDriveFile.mock.calls.length);
    expect(run.logged('DONE —')).toBe(false);     // it really did stop, rather than finishing
  });
});
