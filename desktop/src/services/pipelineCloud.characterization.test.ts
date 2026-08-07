import { beforeEach, describe, expect, it, vi } from 'vitest';

const uploadDropboxFile = vi.fn();
const uploadOneDriveFile = vi.fn();
const uploadGDriveFile = vi.fn();
const ensureGDriveFolderPaths = vi.fn();
const drainGDriveDuplicateFolders = vi.fn(() => [] as Array<{ path: string; count: number; chosenId: string }>);

vi.mock('@tauri-apps/plugin-fs', async () => (await import('../test/vfs')).vfs.fsApi());
vi.mock('@tauri-apps/api/path', async () => (await import('../test/vfs')).vfs.pathApi());
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => ({}) }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: async () => {} }));
vi.mock('./cloudService', () => ({
  uploadDropboxFile: (...args: unknown[]) => uploadDropboxFile(...args),
  uploadOneDriveFile: (...args: unknown[]) => uploadOneDriveFile(...args),
  uploadGDriveFile: (...args: unknown[]) => uploadGDriveFile(...args),
  ensureGDriveFolderPaths: (...args: unknown[]) => ensureGDriveFolderPaths(...args),
  drainGDriveDuplicateFolders: () => drainGDriveDuplicateFolders(),
}));

const { vfs } = await import('../test/vfs');
const { runPipeline } = await import('./pipelineService');
const { makeCtx, makeSettings, SRC } = await import('../test/pipelineHarness');

beforeEach(() => {
  vfs.reset();
  uploadDropboxFile.mockReset();
  uploadOneDriveFile.mockReset();
  uploadGDriveFile.mockReset();
  ensureGDriveFolderPaths.mockReset();
  drainGDriveDuplicateFolders.mockReset();
  drainGDriveDuplicateFolders.mockReturnValue([]);
});

function gdriveDest(over: Record<string, unknown> = {}) {
  return {
    id: 'gdrive-1', name: 'Client Drive', role: 'client', minRole: 'member',
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

describe('cloud export destructive safety', () => {
  it('dry-run plans cloud files without uploading or writing the local upload cache', async () => {
    vfs.tree(SRC, { 'Asset __a1b2c3d4/[03] OUT/(PRD)(SlD) Deck.pdf': 'pdf' });
    const settings = makeSettings({ doFlatExport: true, dryRun: true });
    const run = makeCtx(settings, {
      cloudDestinations: [{
        id: 'dropbox-1', name: 'Client Dropbox', role: 'client', minRole: 'member',
        exportLayout: 'folders', includePackages: false, generateLink: true,
        showInPortal: true, allowRevealLocal: false, enabled: true,
        config: {
          type: 'dropbox', clientId: 'client', remotePath: '/deliverables',
          token: {
            accessToken: 'token', refreshToken: '', expiresAt: Number.MAX_SAFE_INTEGER,
            email: '', displayName: '',
          },
        },
      }],
    });

    const stats = await runPipeline(run.ctx as never);

    expect(uploadDropboxFile).not.toHaveBeenCalled();
    expect(uploadOneDriveFile).not.toHaveBeenCalled();
    expect(uploadGDriveFile).not.toHaveBeenCalled();
    expect(vfs.ops).toEqual([]);
    expect(stats.published).toBe(1);
    expect(run.logged('[DRY] would upload 1 file(s)')).toBe(true);
  });

  it('keys links by stable_id + child_id when separate assets share a file stem', async () => {
    const first = `${SRC}/Alpha __a1111111/[03] OUT/Set A/01.jpg`;
    const second = `${SRC}/Beta __b2222222/[03] OUT/Set B/01.jpg`;
    vfs.put(first, 'alpha');
    vfs.put(second, 'beta');
    uploadDropboxFile.mockImplementation(async (_token, srcPath: string) => ({
      url: srcPath === first ? 'https://dropbox/alpha' : 'https://dropbox/beta',
      skipped: false,
    }));
    const cloudUrls = new Map<string, unknown>();
    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudUrls,
      cloudDestinations: [{
        id: 'dropbox-collision', name: 'Client Dropbox', role: 'client', minRole: 'member',
        exportLayout: 'folders', includePackages: false, generateLink: true,
        showInPortal: true, allowRevealLocal: false, enabled: true,
        config: {
          type: 'dropbox', clientId: 'client', remotePath: '/deliverables',
          token: {
            accessToken: 'token', refreshToken: '', expiresAt: Number.MAX_SAFE_INTEGER,
            email: '', displayName: '',
          },
        },
      }],
    });

    await runPipeline(run.ctx as never);

    expect(cloudUrls).toEqual(new Map([
      ['a1111111:c1', [{
        destId: 'dropbox-collision', provider: 'dropbox', name: 'Client Dropbox',
        url: 'https://dropbox/alpha',
      }]],
      ['b2222222:c1', [{
        destId: 'dropbox-collision', provider: 'dropbox', name: 'Client Dropbox',
        url: 'https://dropbox/beta',
      }]],
    ]));
    expect(cloudUrls.has('01')).toBe(false);
    expect(vfs.hasFile(`${SRC}/Alpha __a1111111/.dchub.json`)).toBe(true);
    expect(vfs.hasFile(`${SRC}/Beta __b2222222/.dchub.json`)).toBe(true);
  });
});

/* Drive is the only provider that uploads into an ID, not a path: it cannot create a parent folder
   as a side effect of writing a file, and it will happily hold two folders of the same name in one
   parent. Uploading 8-wide into a tree that does not exist yet is therefore how one destination ends
   up with several copies of every folder. */
describe('cloud export — Google Drive folder resolution', () => {
  beforeEach(() => {
    uploadGDriveFile.mockResolvedValue({ url: null, skipped: false });
  });

  it('resolves the destination tree ONCE, before the concurrent upload batch starts', async () => {
    vfs.tree(SRC, {
      'Asset __a1b2c3d4/[03] OUT/Set A/01.jpg': 'a',
      'Asset __a1b2c3d4/[03] OUT/Set A/02.jpg': 'b',
      'Asset __a1b2c3d4/[03] OUT/Set B/03.jpg': 'c',
    });
    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudDestinations: [gdriveDest()],
    });

    await runPipeline(run.ctx as never);

    expect(ensureGDriveFolderPaths).toHaveBeenCalledOnce();
    const [token, paths, sharedDriveId, scope] = ensureGDriveFolderPaths.mock.calls[0] as
      [string, string[], string, string];
    expect(token).toBe('token');
    expect(sharedDriveId).toBe('sd-1');
    expect(scope).toBe('gdrive-1');            // per destination — two dests may share a path name
    // One entry per FILE; the resolver dedupes. What matters is that both folders are covered and
    // that the paths are exactly the ones the uploads will ask for.
    expect([...new Set(paths)].sort()).toEqual(['Deliverables/Set A', 'Deliverables/Set B']);
    expect(uploadGDriveFile.mock.calls.map(c => c[6]).sort())
      .toEqual(['Deliverables/Set A', 'Deliverables/Set A', 'Deliverables/Set B']);
    expect(ensureGDriveFolderPaths.mock.invocationCallOrder[0])
      .toBeLessThan(uploadGDriveFile.mock.invocationCallOrder[0]);
  });

  it('uploads anyway when the pre-resolve fails — each upload still resolves its own folder', async () => {
    vfs.tree(SRC, { 'Asset __a1b2c3d4/[03] OUT/Set A/01.jpg': 'a' });
    ensureGDriveFolderPaths.mockRejectedValue(new Error('rate limited'));
    // A fresh destination id: the local upload cache is keyed by it and outlives one test.
    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudDestinations: [gdriveDest({ id: 'gdrive-2' })],
    });

    const stats = await runPipeline(run.ctx as never);

    expect(uploadGDriveFile).toHaveBeenCalledOnce();
    expect(stats.errors).toBe(0);
    expect(run.logged('could not pre-resolve Drive folders')).toBe(true);
  });

  it('warns about same-named folders it had to choose between, and names the cleanup action', async () => {
    // Visible until the dedupe tool has merged them — otherwise the only symptom is "Client Drive"
    // showing " (1)" copies in the mirrored folder on someone's laptop.
    vfs.tree(SRC, { 'Asset __a1b2c3d4/[03] OUT/Set A/01.jpg': 'a' });
    drainGDriveDuplicateFolders.mockReturnValueOnce([
      { path: 'Deliverables/Set A', count: 3, chosenId: 'oldest-id' },
    ]);
    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudDestinations: [gdriveDest({ id: 'gdrive-3', name: 'Client Drive' })],
    });

    await runPipeline(run.ctx as never);

    expect(run.logsOfType('warn').some(m =>
      m.includes('3 folders named "Deliverables/Set A"') &&
      m.includes('oldest-id') &&
      m.includes('Clean up duplicate folders'))).toBe(true);
  });
});
