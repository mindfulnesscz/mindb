/* OUT folder hygiene — where render artifacts land, and how a pre-3.2.2 library gets there.
 *
 * Two things are under test and they are different claims.
 *
 * THE LAYOUT. One `thumbnails/` folder beside the files it serves, at OUT level for singles and
 * inside the gallery folder for gallery children, with the document's title thumbnail alongside
 * every other thumbnail rather than in a folder of its own. Asserted as whole file trees, because
 * what a client sees when they open a delivered folder is the entire point.
 *
 * THE MIGRATION. Moving an existing library there must cost nothing: no re-render (the manifests
 * travel, so the caches still match) and no CDN traffic (R2 keys come from folder identity, never
 * from a local path). Both are asserted directly — the moves are renames, nothing is removed, and
 * the object keys are identical to a library that was never in the old layout.
 *
 * Note on the fake: `invokeStub` writes the thumbnail and the page files, but only Rust writes the
 * per-thumbnail `.<name>-thumb.webp.json` cache — so it does not appear in these trees. Its
 * location is pinned in render.rs (`the_render_manifests_are_hidden_beside_what_they_describe`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', async () => (await import('../test/vfs')).vfs.fsApi());
vi.mock('@tauri-apps/api/path', async () => (await import('../test/vfs')).vfs.pathApi());
vi.mock('@tauri-apps/api/core', async () => ({
  invoke: (await import('../test/invokeStub')).invokeStub.invoke,
}));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: async () => {} }));

const { vfs } = await import('../test/vfs');
const { invokeStub } = await import('../test/invokeStub');
const { runPipeline } = await import('./pipelineService');
const { runArtifactMigration } = await import('./pipeline/artifactMigration');
const { makeCtx, makeSettings, SRC, R2 } = await import('../test/pipelineHarness');
import type { AppSettings } from '../store/settingsStore';

const OUT = `${SRC}/Chair __a1b2c3d4/[03] OUT`;

/** A full run with rendering on — what actually produces (and migrates) the layout. */
async function render(over: Partial<AppSettings> = {}, ctxOver: Record<string, unknown> = {}) {
  const settings = makeSettings({ doThumbnails: true, ...over });
  const captured = makeCtx(settings, { r2: R2, ...ctxOver });
  const stats = await runPipeline(captured.ctx as never);
  return { ...captured, stats };
}

/** The migration stage alone, so the render that follows cannot overwrite what it moved. */
async function migrateOnly(assets: string[], over: Partial<AppSettings> = {}) {
  const captured = makeCtx(makeSettings(over), { collectedAssets: assets });
  const stats = { errors: 0 } as never;
  await runArtifactMigration(captured.ctx as never, stats);
  return captured;
}

beforeEach(() => {
  vfs.reset();
  invokeStub.reset();
});

describe('the layout', () => {
  it('gives a single asset its own thumbnails/ folder — no special case', async () => {
    // It saves only one visible entry here. A rule with exceptions is what made the previous
    // convention impossible to change across its call sites.
    vfs.tree(SRC, { 'Chair __a1b2c3d4/[03] OUT/Chair-front-v1.jpg': 'jpeg' });

    await render();

    expect(vfs.relPaths(OUT)).toEqual([
      'Chair-front-v1.jpg',
      'thumbnails/Chair-front-v1-thumb.webp',
    ]);
  });

  it('collects a multi-asset OUT folder into ONE thumbnails/ folder', async () => {
    vfs.tree(SRC, {
      'Chair __a1b2c3d4/[03] OUT/Chair-front-v1.jpg': 'jpeg',
      'Chair __a1b2c3d4/[03] OUT/Chair-side-v1.jpg': 'jpeg',
      'Chair __a1b2c3d4/[03] OUT/Chair-detail-v1.jpg': 'jpeg',
    });

    await render();

    expect(vfs.relPaths(OUT)).toEqual([
      'Chair-detail-v1.jpg',
      'Chair-front-v1.jpg',
      'Chair-side-v1.jpg',
      'thumbnails/Chair-detail-v1-thumb.webp',
      'thumbnails/Chair-front-v1-thumb.webp',
      'thumbnails/Chair-side-v1-thumb.webp',
    ]);
  });

  it('puts a gallery\'s artifacts in the gallery folder, title thumbnail beside the rest', async () => {
    /* The worst case before: a deck had a title thumbnail AND a previews folder of its own, both
       loose beside the assets. The title slide is now just another thumbnail; only the page set,
       which really is a set, keeps a folder — inside `thumbnails/`. */
    invokeStub.documentPages = 2;
    vfs.tree(SRC, {
      'Chair __a1b2c3d4/[03] OUT/Selected/Deck-v2.pptx': 'deck',
      'Chair __a1b2c3d4/[03] OUT/Selected/Hero-v1.jpg': 'jpeg',
    });

    await render();

    expect(vfs.relPaths(`${OUT}/Selected`)).toEqual([
      'Deck-v2.pptx',
      'Hero-v1.jpg',
      'thumbnails/Deck-v2/.pages.json',
      'thumbnails/Deck-v2/001.webp',
      'thumbnails/Deck-v2/002.webp',
      'thumbnails/Deck-v2-thumb.webp',
      'thumbnails/Hero-v1-thumb.webp',
    ].sort());
    // OUT itself holds nothing but the gallery — a gallery's artifacts do not climb to the parent.
    expect(vfs.relPaths(OUT).every(p => p.startsWith('Selected/'))).toBe(true);
  });
});

/** One package in the pre-3.2.2 shape: every artifact loose beside its source. */
function seedOldLayout() {
  vfs.tree(SRC, {
    'Chair __a1b2c3d4/[03] OUT/Chair-front-v1.jpg': 'jpeg',
    'Chair __a1b2c3d4/[03] OUT/Chair-front-v1-thumb.webp': 'rendered webp',
    'Chair __a1b2c3d4/[03] OUT/Chair-front-v1-thumb.webp.json': '{"version":1}',
    'Chair __a1b2c3d4/[03] OUT/Deck-v2.pdf': 'pdf',
    'Chair __a1b2c3d4/[03] OUT/Deck-v2-thumb.webp': 'rendered webp',
    'Chair __a1b2c3d4/[03] OUT/Deck-v2-thumb.webp.json': '{"version":1}',
    'Chair __a1b2c3d4/[03] OUT/Deck-v2-thumb/001.webp': 'page 1',
    'Chair __a1b2c3d4/[03] OUT/Deck-v2-thumb/pages.json': '{"version":1,"rendered":1,"total":1}',
  });
}

/** The two assets `seedOldLayout` puts in OUT — the only directories the migration may visit. */
const OLD_LAYOUT_ASSETS = [`${OUT}/Chair-front-v1.jpg`, `${OUT}/Deck-v2.pdf`];

describe('migrating a pre-3.2.2 library', () => {
  it('moves every artifact into thumbnails/, hiding the caches on the way', async () => {
    seedOldLayout();

    await render();

    expect(vfs.relPaths(OUT)).toEqual([
      'Chair-front-v1.jpg',
      'Deck-v2.pdf',
      'thumbnails/.Chair-front-v1-thumb.webp.json',
      'thumbnails/.Deck-v2-thumb.webp.json',
      'thumbnails/Chair-front-v1-thumb.webp',
      'thumbnails/Deck-v2-thumb.webp',
      'thumbnails/Deck-v2/.pages.json',
      'thumbnails/Deck-v2/001.webp',
    ].sort());
  });

  it('moves rather than re-renders — the manifests travel and nothing is destroyed', async () => {
    seedOldLayout();

    await migrateOnly(OLD_LAYOUT_ASSETS);

    // Nothing is deleted, and every artifact arrives by rename. A delete-and-regenerate would cost
    // ~6.4s per Office document across the library.
    expect(vfs.removed()).toEqual([]);
    expect(vfs.copied()).toEqual([]);
    expect(vfs.text(`${OUT}/thumbnails/Deck-v2-thumb.webp`)).toBe('rendered webp');
    expect(vfs.text(`${OUT}/thumbnails/Deck-v2/.pages.json`)).toContain('"rendered":1');
    // The cache that decides "is this thumbnail current?" is now where Rust computes it to be.
    expect(vfs.hasFile(`${OUT}/thumbnails/.Deck-v2-thumb.webp.json`)).toBe(true);
  });

  it('publishes exactly the same object keys as a library that was never in the old layout', async () => {
    // R2 keys are built from folder identity, never from a local path, so the move is free on the
    // CDN: no re-key, no orphan, no interaction with the prune guard.
    seedOldLayout();
    await render();
    const afterMigration = invokeStub.uploadedKeys();

    vfs.reset();
    invokeStub.reset();
    vfs.tree(SRC, {
      'Chair __a1b2c3d4/[03] OUT/Chair-front-v1.jpg': 'jpeg',
      'Chair __a1b2c3d4/[03] OUT/Deck-v2.pdf': 'pdf',
    });
    await render();

    expect(afterMigration).toEqual(invokeStub.uploadedKeys());
  });

  it('is idempotent — a second run moves nothing', async () => {
    seedOldLayout();
    await render();
    const settled = vfs.relPaths(OUT);

    vfs.ops = [];
    await render();

    expect(vfs.relPaths(OUT)).toEqual(settled);
    expect(vfs.renamed()).toEqual([]);
  });

  it('never moves a real asset, whatever else is in the folder', async () => {
    seedOldLayout();
    // A name that mentions thumbnails is not an artifact.
    vfs.put(`${OUT}/thumbnail-notes.md`, 'hand-written');

    await migrateOnly(OLD_LAYOUT_ASSETS);

    expect(vfs.hasFile(`${OUT}/Chair-front-v1.jpg`)).toBe(true);
    expect(vfs.hasFile(`${OUT}/Deck-v2.pdf`)).toBe(true);
    expect(vfs.hasFile(`${OUT}/thumbnail-notes.md`)).toBe(true);
  });

  it('keeps an already-migrated artifact rather than overwriting it with the stale one', async () => {
    seedOldLayout();
    vfs.put(`${OUT}/thumbnails/Deck-v2-thumb.webp`, 'current render');

    await migrateOnly(OLD_LAYOUT_ASSETS);

    expect(vfs.text(`${OUT}/thumbnails/Deck-v2-thumb.webp`)).toBe('current render');
    // The stale loose copy is left where it is — purging it belongs to the mirror purge and the
    // CDN garbage collector, not to a migration.
    expect(vfs.hasFile(`${OUT}/Deck-v2-thumb.webp`)).toBe(true);
  });

  it('previews the moves without touching the disk on a dry run', async () => {
    seedOldLayout();

    const run = await render({ dryRun: true });

    expect(vfs.ops).toEqual([]);
    expect(run.logged('would move')).toBe(true);
  });
});
