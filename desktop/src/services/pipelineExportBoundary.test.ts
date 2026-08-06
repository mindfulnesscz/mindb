/* THE EXPORT BOUNDARY — a destination receives assets, and nothing else.
 *
 * Render artifacts belong beside the source (as the cache) and on R2 (as what the portal serves).
 * A client destination gets assets: never a thumbnail, never a previews folder, never a render
 * cache. That rule used to be spelled `name.includes('-thumb')` in about eight places, which is
 * exactly how one path ends up missing it — `cloudExport` had no test of its own at all and was
 * clean only because its input arrived pre-filtered.
 *
 * So this suite asserts at the BOUNDARY rather than per call site: seed one OUT tree holding every
 * artifact shape, run each destination writer over it, and demand the destination contain exactly
 * the assets. Deliberately NOT written as an assertion about `-thumb` naming — the artifacts moved
 * into `thumbnails/` and the naming may yet change again; what must not change is that a client
 * never sees one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const uploadDropboxFile = vi.fn();

vi.mock('@tauri-apps/plugin-fs', async () => (await import('../test/vfs')).vfs.fsApi());
vi.mock('@tauri-apps/api/path', async () => (await import('../test/vfs')).vfs.pathApi());
vi.mock('@tauri-apps/api/core', async () => ({
  invoke: (await import('../test/invokeStub')).invokeStub.invoke,
}));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: async () => {} }));
vi.mock('./cloudService', () => ({
  uploadDropboxFile: (...args: unknown[]) => uploadDropboxFile(...args),
  uploadOneDriveFile: vi.fn(),
  uploadGDriveFile: vi.fn(),
}));

const { vfs } = await import('../test/vfs');
const { invokeStub } = await import('../test/invokeStub');
const { runPipeline } = await import('./pipelineService');
const { makeCtx, makeSettings, SRC, DST } = await import('../test/pipelineHarness');
import type { AppSettings } from '../store/settingsStore';

const PKG = `${SRC}/Campaign/[00] 📦 Handoff`;
const OUT = `${SRC}/Campaign/Chair __a1b2c3d4/[03] OUT`;

/** The two files a client is entitled to, by their delivered names. */
const ASSETS = ['Chair-front-v1.jpg', 'Deck-v2.pdf'];

/**
 * One OUT tree carrying EVERY artifact shape at once:
 *   - the current layout, `thumbnails/` beside the assets, at both OUT and gallery level
 *   - a document's page previews, whose own filenames (`001.webp`) carry no marker
 *   - the hidden render caches
 *   - the pre-3.2.2 loose sidecars, which an unmigrated library still has on disk
 */
function seedEveryArtifact() {
  vfs.tree(SRC, {
    'Campaign/[00] 📦 Handoff/': null,
    [`Campaign/Chair __a1b2c3d4/[03] OUT/${ASSETS[0]}`]: 'jpeg bytes',
    [`Campaign/Chair __a1b2c3d4/[03] OUT/${ASSETS[1]}`]: 'pdf bytes',

    // Current layout — the artifacts folder beside the files it serves.
    'Campaign/Chair __a1b2c3d4/[03] OUT/thumbnails/Chair-front-v1-thumb.webp': 'webp',
    'Campaign/Chair __a1b2c3d4/[03] OUT/thumbnails/.Chair-front-v1-thumb.webp.json': '{}',
    'Campaign/Chair __a1b2c3d4/[03] OUT/thumbnails/Deck-v2-thumb.webp': 'webp',
    'Campaign/Chair __a1b2c3d4/[03] OUT/thumbnails/.Deck-v2-thumb.webp.json': '{}',
    'Campaign/Chair __a1b2c3d4/[03] OUT/thumbnails/Deck-v2/001.webp': 'page 1',
    'Campaign/Chair __a1b2c3d4/[03] OUT/thumbnails/Deck-v2/002.webp': 'page 2',
    'Campaign/Chair __a1b2c3d4/[03] OUT/thumbnails/Deck-v2/.pages.json': '{"rendered":2,"total":2}',

    // Pre-3.2.2 leftovers, loose beside the assets.
    'Campaign/Chair __a1b2c3d4/[03] OUT/Chair-front-v1-thumb.webp': 'legacy webp',
    'Campaign/Chair __a1b2c3d4/[03] OUT/Deck-v2-thumb.webp.json': '{}',
    'Campaign/Chair __a1b2c3d4/[03] OUT/Deck-v2-thumb/001.webp': 'legacy page',
    'Campaign/Chair __a1b2c3d4/[03] OUT/Deck-v2-thumb/pages.json': '{"rendered":1,"total":1}',
  });
}

/** Every file below `root`, relative and sorted — what a client would actually see. */
function delivered(root: string): string[] {
  return vfs.relPaths(root).sort();
}

async function run(over: Partial<AppSettings> = {}, ctxOver: Record<string, unknown> = {}) {
  const settings = makeSettings(over);
  const captured = makeCtx(settings, ctxOver);
  const stats = await runPipeline(captured.ctx as never);
  return { ...captured, stats };
}

beforeEach(() => {
  vfs.reset();
  invokeStub.reset();
  uploadDropboxFile.mockReset();
  uploadDropboxFile.mockResolvedValue({ url: null, skipped: false });
});

describe('local destination', () => {
  it('receives assets only, in folders layout', async () => {
    seedEveryArtifact();
    await run({ doPublish: true });

    expect(delivered(DST)).toEqual(['Campaign/Chair/Chair-front-v1.jpg', 'Campaign/Chair/Deck-v2.pdf']);
  });

  it('receives assets only, in flat layout', async () => {
    seedEveryArtifact();
    await run({ doPublish: true }, { localExportLayout: 'flat' });

    expect(delivered(DST)).toEqual(ASSETS);
  });
});

describe('package mirror', () => {
  it('receives assets only', async () => {
    seedEveryArtifact();
    await run({ doDistribute: true });

    expect(delivered(PKG)).toEqual(ASSETS);
  });
});

describe('cloud destination', () => {
  /** Remote paths handed to the provider — the cloud equivalent of a delivered file tree. */
  function uploadedRemotePaths(): string[] {
    return uploadDropboxFile.mock.calls.map(call => call[2] as string).sort();
  }

  /* A distinct id per test: the stage's upload cache is memoized for the process lifetime, so a
     shared id would let one test's uploads be served from another test's cache. */
  const dropbox = (id: string, over: Record<string, unknown> = {}) => ({
    id, name: 'Client Dropbox', role: 'client', minRole: 'member',
    exportLayout: 'folders', includePackages: false, generateLink: false,
    showInPortal: true, allowRevealLocal: false, enabled: true,
    config: {
      type: 'dropbox', clientId: 'client', remotePath: '/deliverables',
      token: {
        accessToken: 'token', refreshToken: '', expiresAt: Number.MAX_SAFE_INTEGER,
        email: '', displayName: '',
      },
    },
    ...over,
  });

  it('receives assets only, in folders layout', async () => {
    seedEveryArtifact();
    await run({ doFlatExport: true }, { cloudDestinations: [dropbox('dropbox-folders')] });

    expect(uploadedRemotePaths()).toEqual(ASSETS.map(name => `/deliverables/${name}`));
  });

  it('receives assets only when it also takes nested packages', async () => {
    seedEveryArtifact();
    await run({ doFlatExport: true }, {
      cloudDestinations: [dropbox('dropbox-packages', { includePackages: true })],
    });

    expect(uploadedRemotePaths()).toEqual([
      ...ASSETS.map(name => `/deliverables/${name}`),
      ...ASSETS.map(name => `/deliverables/Campaign/[00] 📦 Handoff/${name}`),
    ].sort());
  });

  /* The stage used to inherit a filtered list rather than filter, so a caller that handed it an
     unfiltered one would have shipped artifacts with nothing to stop it. Prove the gate is this
     stage's own by handing it exactly that. */
  it('filters what it was handed, rather than trusting its caller', async () => {
    seedEveryArtifact();
    await run({ doFlatExport: true }, {
      cloudDestinations: [dropbox('dropbox-unfiltered')],
      collectedAssets: [
        `${OUT}/${ASSETS[0]}`,
        `${OUT}/${ASSETS[1]}`,
        `${OUT}/thumbnails/Deck-v2-thumb.webp`,
        `${OUT}/thumbnails/Deck-v2/001.webp`,
        `${OUT}/Chair-front-v1-thumb.webp`,
      ],
    });

    // Deduped: the run appends its own scan to a pre-seeded list, so each asset appears twice.
    // What matters is the SET — three artifacts went in and none of them came out.
    expect([...new Set(uploadedRemotePaths())].sort())
      .toEqual(ASSETS.map(name => `/deliverables/${name}`));
  });
});
