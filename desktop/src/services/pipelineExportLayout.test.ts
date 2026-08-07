/* The three export layouts, and the one that has to AGREE with another stage.
 *
 * `source` exists because "keep the folders" meant two different trees: the publish stage mirrored
 * the source tree while the cloud export kept only the part below OUT, so a deliverable with no
 * gallery reached a client at the destination root with its package folder gone. The last test here
 * is the real guard — it runs both stages over one tree and compares the relative paths they
 * produce. A future change to either walk that reintroduces the divergence fails it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const uploadDropboxFile = vi.fn();
const uploadOneDriveFile = vi.fn();
const uploadGDriveFile = vi.fn();
const ensureGDriveFolderPaths = vi.fn();
const sweepGDriveFolderFiles = vi.fn();
const oneDriveRemoteItem = vi.fn();
const oneDriveShareLink = vi.fn();
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
  sweepGDriveFolderFiles: (...args: unknown[]) => sweepGDriveFolderFiles(...args),
  oneDriveRemoteItem: (...args: unknown[]) => oneDriveRemoteItem(...args),
  oneDriveShareLink: (...args: unknown[]) => oneDriveShareLink(...args),
  drainGDriveDuplicateFolders: () => drainGDriveDuplicateFolders(),
}));

const { vfs } = await import('../test/vfs');
const { runPipeline } = await import('./pipelineService');
const { makeCtx, makeSettings, SRC, DST } = await import('../test/pipelineHarness');

/* One library, three shapes in it: a deliverable with no gallery (the case the two layouts
   disagree about), a gallery, and a second category so the tree has more than one branch. */
const LIBRARY = {
  '01 Works/01 Graphics/Batch I __a1111111/[03] OUT/(PRD)(SlD) Deck.pdf': 'deck',
  '01 Works/02 Sculptures/Ascension __b2222222/[03] OUT/(Gll) Studio/01.jpg': 'one',
  '01 Works/02 Sculptures/Ascension __b2222222/[03] OUT/(Gll) Studio/02.jpg': 'two',
  '02 Studio/M5 __c3333333/[03] OUT/Notes.pdf': 'notes',
};

function dest(layout: string, over: Record<string, unknown> = {}) {
  return {
    id: `dbx-${layout}`, name: `Client ${layout}`, role: 'client', minRole: 'member',
    exportLayout: layout, includePackages: false, generateLink: false,
    showInPortal: true, allowRevealLocal: false, enabled: true,
    config: {
      type: 'dropbox', clientId: 'client', remotePath: '/deliverables',
      token: {
        accessToken: 'token', refreshToken: '', expiresAt: Number.MAX_SAFE_INTEGER,
        email: '', displayName: '',
      },
    },
    ...over,
  };
}

/** Remote paths the Dropbox uploader was asked for, minus the destination root. */
function uploadedRels(): string[] {
  return uploadDropboxFile.mock.calls
    .map(c => String(c[2]).replace(/^\/deliverables\//, ''))
    .sort();
}

beforeEach(() => {
  vfs.reset();
  uploadDropboxFile.mockReset();
  uploadDropboxFile.mockResolvedValue({ url: null, skipped: false });
  uploadOneDriveFile.mockReset();
  uploadGDriveFile.mockReset();
  ensureGDriveFolderPaths.mockReset();
  ensureGDriveFolderPaths.mockResolvedValue(new Map());
  sweepGDriveFolderFiles.mockReset();
  sweepGDriveFolderFiles.mockResolvedValue(new Map());
  oneDriveRemoteItem.mockReset();
  oneDriveRemoteItem.mockResolvedValue(null);
  oneDriveShareLink.mockReset();
  drainGDriveDuplicateFolders.mockReset();
  drainGDriveDuplicateFolders.mockReturnValue([]);
});

describe('cloud export layouts', () => {
  it('source — mirrors the source tree, OUT dropped and identity suffixes stripped', async () => {
    vfs.tree(SRC, LIBRARY);
    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudDestinations: [dest('source')],
    });

    await runPipeline(run.ctx as never);

    expect(uploadedRels()).toEqual([
      '01 Works/01 Graphics/Batch I/Product Slides — Deck.pdf',
      '01 Works/02 Sculptures/Ascension/(Gll) Studio/01.jpg',
      '01 Works/02 Sculptures/Ascension/(Gll) Studio/02.jpg',
      '02 Studio/M5/Notes.pdf',
    ]);
    expect(run.logged('source tree (same folders a local export delivers)')).toBe(true);
  });

  it('folders — keeps only the OUT subtree, which is what stored destinations still mean', async () => {
    vfs.tree(SRC, LIBRARY);
    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudDestinations: [dest('folders')],
    });

    await runPipeline(run.ctx as never);

    // The two files with no gallery land at the destination root — the reported behaviour, kept
    // deliberately so an existing destination does not restructure itself on the next run.
    expect(uploadedRels()).toEqual([
      '(Gll) Studio/01.jpg',
      '(Gll) Studio/02.jpg',
      'Notes.pdf',
      'Product Slides — Deck.pdf',
    ]);
  });

  it('flat — everything at the destination root', async () => {
    vfs.tree(SRC, LIBRARY);
    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudDestinations: [dest('flat')],
    });

    await runPipeline(run.ctx as never);

    expect(uploadedRels()).toEqual([
      '01.jpg', '02.jpg', 'Notes.pdf', 'Product Slides — Deck.pdf',
    ]);
  });

  it('an unknown or missing layout resolves to folders, never to source', async () => {
    vfs.tree(SRC, LIBRARY);
    const run = makeCtx(makeSettings({ doFlatExport: true }), {
      cloudDestinations: [dest('folders', { id: 'dbx-unknown', exportLayout: 'legacy-value' })],
    });

    await runPipeline(run.ctx as never);

    expect(uploadedRels()).toEqual([
      '(Gll) Studio/01.jpg',
      '(Gll) Studio/02.jpg',
      'Notes.pdf',
      'Product Slides — Deck.pdf',
    ]);
  });

  /* THE AGREEMENT TEST. Both stages run over the same library in the same run; every relative path
     one produces must be a path the other produces. Comparing outputs rather than implementations
     is the point — either walk can be rewritten, they just cannot drift apart again. */
  it('source lands each file in the same folder the local publish does', async () => {
    vfs.tree(SRC, LIBRARY);
    // A destination id of its own: the upload cache is keyed by it, is a module-level memo, and
    // outlives one test — reusing an id here would skip every upload and compare two empty lists.
    const run = makeCtx(makeSettings({ doFlatExport: true, doPublish: true }), {
      cloudDestinations: [dest('source', { id: 'dbx-agreement' })],
      localExportLayout: 'source',
    });

    await runPipeline(run.ctx as never);

    const published = vfs.paths()
      .filter(p => p.startsWith(`${DST}/`))
      .map(p => p.slice(DST.length + 1))
      .sort();

    expect(published.length).toBeGreaterThan(0);
    expect(uploadedRels()).toEqual(published);
  });
});
