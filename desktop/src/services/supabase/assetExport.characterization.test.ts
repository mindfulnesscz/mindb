/* Characterization tests — ASSET EXPORT (exportAssetsToSupabase), the pipeline's Supabase sync.
 *
 * This decides, for every asset on disk, whether a row is created, updated, or soft-disconnected —
 * and how variants, galleries and version history relate. Getting it wrong either duplicates a
 * client's assets in the portal or disconnects live ones, taking their ratings and comments with
 * them.
 *
 * Until now its only coverage needed a live local Postgres, so CI proved nothing about it. These
 * tests are hermetic: the manifest lives in the virtual filesystem, and the REST layer is a
 * recording stub, so the assertions are on the rows this code WOULD write.
 *
 * Written before splitting the 489-line function (2c-1) — the same prove-then-move order that made
 * the pipelineService split a non-event.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', async () => (await import('../../test/vfs')).vfs.fsApi());
vi.mock('@tauri-apps/api/path', async () => (await import('../../test/vfs')).vfs.pathApi());
vi.mock('./rest', async () => (await import('../../test/restStub')).restStub.api());
// readme.md generation and stats are separate concerns with their own paths; stub them so a
// failure there cannot look like a sync failure here.
const readmeStubs = vi.hoisted(() => ({
  writeReadme: vi.fn(),
  fetchAssetStats: vi.fn(async () => new Map<string, never>()),
}));
vi.mock('../readmeService', () => ({ writeReadme: readmeStubs.writeReadme }));
vi.mock('./assetQueries', () => ({ fetchAssetStats: readmeStubs.fetchAssetStats }));

const { vfs } = await import('../../test/vfs');
const { restStub } = await import('../../test/restStub');
const { exportAssetsToSupabase } = await import('./assetExport');
const { groupAssets } = await import('@sotto/domain');
import type { VocabularyData, VocabTag } from '@sotto/domain';

const SRC = '/src';
const CLIENT = 'client-1';
const config = { url: 'https://test.supabase.co', anonKey: 'anon' };

const tag = (shortcode: string, slot: VocabTag['slot'], label: string): VocabTag =>
  ({ shortcode, slot, parentGroup: null, label, key: label.toLowerCase(), icon: '' });

const VOCAB: VocabularyData = {
  _schema_version: '4.0.0', _comment: 'test',
  tags: [
    tag('PRD', 'entity', 'Product'),
    tag('ACQ', 'entity', 'Acquisition'),
    tag('OVR', 'angle', 'Overview'),
    tag('SlD', 'format', 'Slides'),
    tag('Pdf', 'format', 'PDF'),
    tag('Gll', 'format', 'Gallery'),
  ],
};

/** Drive the sync from real file paths, through the real grouping logic. */
async function sync(paths: string[], opts: {
  cdnUrls?: Map<string, string>;
  pageCounts?: Map<string, { total: number; rendered: number }>;
  originalUrls?: Map<string, string>;
  dryRun?: boolean;
  sourceFresh?: boolean;
  allowLargeDeletions?: boolean;
} = {}) {
  const { singles, galleries } = groupAssets(paths, 'OUT');
  const logs: Array<{ type: string; msg: string }> = [];
  const result = await exportAssetsToSupabase(
    singles, CLIENT, VOCAB, config,
    (type, msg) => { logs.push({ type, msg }); },
    opts.cdnUrls, undefined, galleries, opts.originalUrls, opts.allowLargeDeletions,
    opts.pageCounts, opts.dryRun,
    undefined, opts.sourceFresh,
  );
  return { result, logs, logged: (n: string) => logs.some(l => l.msg.includes(n)) };
}

beforeEach(() => {
  vfs.reset();
  restStub.reset();
  readmeStubs.writeReadme.mockReset().mockResolvedValue(undefined);
  readmeStubs.fetchAssetStats.mockReset().mockResolvedValue(new Map());
});

describe('assetExport — a fresh package folder', () => {
  it('dry-runs the complete export without rows, manifests, or readmes being mutated', async () => {
    const path = `${SRC}/Asset __a1000000/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(path, 'pdf');
    restStub.existingRows = [{
      id: 'stale-row', stable_id: 'deadbeef', child_id: 'c1',
      thumbnail_url: null, download_key: 'client/client-1/originals/deadbeef/c1.pdf',
      parent_id: null, variant_of: null,
    }];

    const { result, logged } = await sync([path], { dryRun: true });

    expect(result.created).toBe(1);
    expect(result.disconnected).toBe(1);
    expect(restStub.byMethod('POST')).toEqual([]);
    expect(restStub.byMethod('PATCH')).toEqual([]);
    expect(vfs.hasFile(`${SRC}/Asset __a1000000/.dchub.json`)).toBe(false);
    expect(vfs.ops).toEqual([]);
    expect(logged('[DRY] would create 1')).toBe(true);
    expect(logged('[DRY] would mark 1 stable record(s) disconnected')).toBe(true);
  });

  it('creates one row, keyed by stable_id + child_id rather than by shortcode', async () => {
    vfs.put(`${SRC}/Asset __a1000001/OUT/(PRD)(SlD) Deck.pdf`, 'pdf');
    const { result } = await sync([`${SRC}/Asset __a1000001/OUT/(PRD)(SlD) Deck.pdf`]);

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(restStub.inserted()).toHaveLength(1);
    expect(restStub.inserted()[0]).toMatchObject({
      client_id: CLIENT, stable_id: 'a1000001', child_id: 'c1',
      shortcode: '(PRD)(SlD) Deck', name: 'Product Slides — Deck',
      status: 'published', perm: 'client',
      parent_id: null, variant_of: null,
    });
  });

  it('persists the manifest so the next run resolves the same child_id', async () => {
    const p = `${SRC}/Asset __a1000002/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'pdf');
    await sync([p]);

    const manifest = JSON.parse(vfs.text(`${SRC}/Asset __a1000002/.dchub.json`));
    expect(manifest.stable_id).toBe('a1000002');
    expect(manifest.children['(PRD)(SlD) Deck.pdf'].child_id).toBe('c1');
  });

  it('UPDATES rather than duplicates when the row already exists', async () => {
    const p = `${SRC}/Asset __a1000003/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'pdf');
    restStub.existingRows = [{ id: 'row-existing', stable_id: 'a1000003', child_id: 'c1' }];

    const { result } = await sync([p]);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(restStub.byMethod('PATCH')[0].url).toContain('id=eq.row-existing');
  });

  it('attaches readme stats to the planner primary when its child id is not c1', async () => {
    const packageDir = `${SRC}/Asset __a1000004`;
    const p = `${packageDir}/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'pdf');
    vfs.put(`${packageDir}/.dchub.json`, JSON.stringify({
      stable_id: 'a1000004',
      children: {
        '(PRD)(SlD) Deck.pdf': { child_id: 'c7', sha256: 'known' },
      },
      updated_at: '',
    }));
    restStub.existingRows = [{
      id: 'row-seven', stable_id: 'a1000004', child_id: 'c7',
      parent_id: null, variant_of: null, perm: 'client', status: 'published',
    }];

    await sync([p]);

    expect(readmeStubs.fetchAssetStats).toHaveBeenCalledWith(['row-seven'], config);
    expect(readmeStubs.writeReadme).toHaveBeenCalledWith(
      packageDir,
      expect.objectContaining({ stableId: 'a1000004', stats: null }),
    );
  });

  it('refuses to sync a folder with no identity, and reports it', async () => {
    // No " __<hash>" suffix means no permanent key. Guessing one would orphan the row on the
    // first rename, so the asset is reported instead.
    const p = `${SRC}/Unhashed Folder/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'pdf');
    const { result, logged } = await sync([p]);

    expect(restStub.inserted()).toEqual([]);
    expect(result.errors).toBe(1);
    expect(logged('no " __<hash>" suffix')).toBe(true);
  });
});

describe('assetExport — access level', () => {
  /* Until 2026-07-31 every export path hardcoded `perm: 'public'`, overriding the column's own
     `client` default, so the entire library was discoverable by anonymous portal visitors. These
     are the tests that would have caught it — and that stop it coming back through any of the
     four shapes the planner writes (single, variant, gallery parent, gallery child). */

  const EVERY_SHAPE = [
    `${SRC}/Single __a7000001/OUT/(PRD)(SlD) Deck.pdf`,
    `${SRC}/Variants __a7000002/OUT/(PRD)(SlD) Deck.pdf`,
    `${SRC}/Variants __a7000002/OUT/(ACQ)(Pdf) Deck.pdf`,
    `${SRC}/Shoot __a7000003/OUT/(PRD)(Gll) Studios/01.jpg`,
    `${SRC}/Shoot __a7000003/OUT/(PRD)(Gll) Studios/02.jpg`,
  ];

  it('never writes perm: public from ANY export path', async () => {
    EVERY_SHAPE.forEach(p => vfs.put(p, p));
    await sync(EVERY_SHAPE);

    const rows = restStub.inserted();
    expect(rows.length).toBeGreaterThan(4);          // all four shapes actually exercised
    expect(rows.filter(r => r.perm === 'public')).toEqual([]);
    for (const row of rows) expect(row.perm).toBe('client');
  });

  it('leaves perm alone on an UPDATE, so a portal promotion survives the next run', async () => {
    // perm is an editor's decision. Sending the pipeline default on every PATCH would quietly
    // undo it — and once the level is encoded in the R2 object key, move the bytes back with it.
    const p = `${SRC}/Asset __a7000004/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'pdf');
    restStub.existingRows = [{ id: 'row-promoted', stable_id: 'a7000004', child_id: 'c1' }];

    await sync([p]);

    const body = restStub.patched()[0];
    expect('perm' in body).toBe(false);
  });

  it('inserts a NEW variant at the level its existing set already has', async () => {
    // Adding a print rendition to an asset staff had promoted to `public` must not insert it at
    // the create-time default: a set whose members disagree shows up as a variant picker that
    // half-works, which is the same class of fault as the gallery-with-hidden-children bug.
    const primary = `${SRC}/Asset __a7000006/OUT/(PRD)(SlD) Deck.pdf`;
    const fresh   = `${SRC}/Asset __a7000006/OUT/(ACQ)(Pdf) Deck.pdf`;
    [primary, fresh].forEach(p => vfs.put(p, p));
    restStub.existingRows = [
      { id: 'row-promoted', stable_id: 'a7000006', child_id: 'c1',
        thumbnail_url: null, parent_id: null, variant_of: null, perm: 'public', status: 'published' },
    ];

    await sync([primary, fresh]);

    // The one INSERT is the new variant; it takes the set's level, not PIPELINE_DEFAULT_PERM.
    expect(restStub.inserted()).toHaveLength(1);
    expect(restStub.inserted()[0].perm).toBe('public');
    // …and the existing primary is still not re-stamped, because perm is insert-only.
    expect('perm' in restStub.patched()[0]).toBe(false);
  });

  it('falls back to the default level when the set is brand new', async () => {
    const a = `${SRC}/Asset __a7000007/OUT/(PRD)(SlD) Deck.pdf`;
    const b = `${SRC}/Asset __a7000007/OUT/(ACQ)(Pdf) Deck.pdf`;
    [a, b].forEach(p => vfs.put(p, p));

    await sync([a, b]);

    for (const row of restStub.inserted()) expect(row.perm).toBe('client');
  });

  it('still sends status on an UPDATE, so a returning file is un-disconnected', async () => {
    // The counterpart to the test above: status is NOT portal-owned on the write path, because
    // re-appearing on disk is how a `disconnected` row comes back.
    const p = `${SRC}/Asset __a7000005/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'pdf');
    restStub.existingRows = [{ id: 'row-back', stable_id: 'a7000005', child_id: 'c1' }];

    await sync([p]);

    expect(restStub.patched()[0].status).toBe('published');
  });
});

describe('assetExport — version history collapses to one row', () => {
  it('syncs only the highest version of a deliverable', async () => {
    // v1 and v2 of one asset are version HISTORY, not two assets. Older versions are tracked by
    // syncVersionHistory instead.
    const paths = [
      `${SRC}/Asset __a2000001/OUT/(PRD)(SlD) Deck v1.pdf`,
      `${SRC}/Asset __a2000001/OUT/(PRD)(SlD) Deck v2.pdf`,
    ];
    paths.forEach(p => vfs.put(p, p));
    const { result } = await sync(paths);

    expect(result.created).toBe(1);
    expect(restStub.inserted()[0].shortcode).toBe('(PRD)(SlD) Deck');
    expect(restStub.inserted()[0].version).toBe('v2');
  });

  it('keeps the same child_id across a version bump, so the row survives', async () => {
    // The row carries the ratings and comments — a new child_id would strand them.
    const v1 = `${SRC}/Asset __a2000002/OUT/(PRD)(SlD) Deck v1.pdf`;
    vfs.put(v1, 'v1');
    await sync([v1]);
    const firstChildId = restStub.inserted()[0].child_id;

    restStub.reset();
    const v2 = `${SRC}/Asset __a2000002/OUT/(PRD)(SlD) Deck v2.pdf`;
    vfs.put(v2, 'v2');
    await sync([v2]);

    expect(restStub.inserted()[0].child_id).toBe(firstChildId);
  });
});

describe('assetExport — variants (several renditions in one OUT)', () => {
  it('makes the first a primary and links the rest with variant_of, not parent_id', async () => {
    // Variants are the same deliverable in different renditions — the portal shows a picker.
    const paths = [
      `${SRC}/Asset __a3000001/OUT/(PRD)(SlD) Deck.pdf`,
      `${SRC}/Asset __a3000001/OUT/(PRD)(Pdf) Deck Print.pdf`,
    ];
    paths.forEach(p => vfs.put(p, p));
    const { result } = await sync(paths);

    expect(result.created).toBe(2);
    const rows = restStub.inserted();
    const primary = rows.find(r => r.variant_of === null && r.parent_id === null);
    const variant = rows.find(r => r.variant_of !== null && r.variant_of !== undefined);
    expect(primary).toBeDefined();
    expect(variant).toBeDefined();
    expect(variant!.parent_id).toBeNull();     // never both relations at once
  });

  it('renames the primary to the tags every variant SHARES', async () => {
    // Otherwise the group card is named after whichever variant happened to be primary, which
    // reads as noise ("... — Print").
    const paths = [
      `${SRC}/Asset __a3000002/OUT/(PRD)(SlD) Deck.pdf`,
      `${SRC}/Asset __a3000002/OUT/(PRD)(Pdf) Deck.pdf`,
    ];
    paths.forEach(p => vfs.put(p, p));
    await sync(paths);

    const primary = restStub.inserted().find(r => r.variant_of === null)!;
    expect(primary.name).toBe('Product');        // the one tag both variants share
  });

  it('rolls every variant tag UP onto the primary, so filters still surface the group', async () => {
    const paths = [
      `${SRC}/Asset __a3000003/OUT/(PRD)(SlD) Deck.pdf`,
      `${SRC}/Asset __a3000003/OUT/(ACQ)(Pdf) Deck.pdf`,
    ];
    paths.forEach(p => vfs.put(p, p));
    await sync(paths);

    const primary = restStub.inserted().find(r => r.variant_of === null)!;
    expect(new Set(primary.tags as string[])).toEqual(
      new Set(['Product', 'Slides', 'Acquisition', 'PDF']),
    );
    expect(new Set(primary.entities as string[])).toEqual(new Set(['Product', 'Acquisition']));
    expect(new Set(primary.formats as string[])).toEqual(new Set(['Slides', 'PDF']));
  });

  it('leaves a single-file package named after its own file', async () => {
    const p = `${SRC}/Asset __a3000004/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'x');
    await sync([p]);

    expect(restStub.inserted()[0].name).toBe('Product Slides — Deck');
  });

  it('does not treat extension pairs of one stem as two variants', async () => {
    // groupAssets emits one entry per FILE, so foo.pdf + foo.png repeat a stem. Resolving the
    // stem twice used to stamp variant_of onto the primary's own row, hiding the group.
    const paths = [
      `${SRC}/Asset __a3000005/OUT/(PRD)(SlD) Deck.pdf`,
      `${SRC}/Asset __a3000005/OUT/(PRD)(SlD) Deck.png`,
    ];
    paths.forEach(p => vfs.put(p, p));
    const { result } = await sync(paths);

    expect(result.created).toBe(1);
    expect(restStub.inserted()[0].variant_of).toBeNull();
  });
});

describe('assetExport — galleries (a folder of related files)', () => {
  it('creates a parent for the folder and links children with parent_id, not variant_of', async () => {
    // A gallery is many related-but-distinct files — the portal shows a grid, not a picker.
    const paths = [
      `${SRC}/Shoot __a4000001/OUT/(PRD)(Gll) Studios/01.jpg`,
      `${SRC}/Shoot __a4000001/OUT/(PRD)(Gll) Studios/02.jpg`,
    ];
    paths.forEach(p => vfs.put(p, p));
    const { result } = await sync(paths);

    expect(result.created).toBe(3);              // 1 parent + 2 children
    const rows = restStub.inserted();
    const children = rows.filter(r => r.parent_id !== null && r.parent_id !== undefined);
    expect(children).toHaveLength(2);
    for (const c of children) expect(c.variant_of).toBeNull();
  });

  it('keeps same-named galleries in different packages apart', async () => {
    // Two packages each holding an "Old/" gallery is a real client shape; a shared key would let
    // the second overwrite the first.
    const paths = [
      `${SRC}/A __a4000002/OUT/Old/a.jpg`,
      `${SRC}/B __a4000003/OUT/Old/b.jpg`,
    ];
    paths.forEach(p => vfs.put(p, p));
    await sync(paths);

    const stableIds = new Set(restStub.inserted().map(r => r.stable_id));
    expect(stableIds).toEqual(new Set(['a4000002', 'a4000003']));
  });
});

describe('assetExport — disconnecting what is gone', () => {
  it('refuses disconnects when the source scan was incomplete', async () => {
    const p = `${SRC}/Asset __a5000000/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'pdf');
    restStub.existingRows = [
      { id: 'row-live', stable_id: 'a5000000', child_id: 'c1' },
      { id: 'row-unseen', stable_id: 'b5000000', child_id: 'c1' },
    ];

    const { result, logged } = await sync([p], { sourceFresh: false });

    expect(result.disconnected).toBe(0);
    expect(restStub.disconnectedIds()).toEqual([]);
    expect(logged('source asset scan was not freshly synchronized')).toBe(true);
  });

  it('soft-marks a row whose file left the disk, never deletes it', async () => {
    // Deleting would take the asset's ratings, comments and events with it. A transient disk
    // change must never do that.
    const p = `${SRC}/Asset __a5000001/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'pdf');
    restStub.existingRows = [
      { id: 'row-live', stable_id: 'a5000001', child_id: 'c1' },
      { id: 'row-gone', stable_id: 'a5000001', child_id: 'c9' },
    ];

    const { result } = await sync([p]);

    expect(result.disconnected).toBe(1);
    expect(restStub.disconnectedIds()).toEqual(['row-gone']);
    expect(restStub.byMethod('DELETE')).toEqual([]);
  });

  it('reports the stale CDN keys for a separate, explicit cleanup', async () => {
    const p = `${SRC}/Asset __a5000002/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'pdf');
    restStub.existingRows = [
      { id: 'row-live', stable_id: 'a5000002', child_id: 'c1' },
      {
        id: 'row-gone', stable_id: 'a5000002', child_id: 'c9',
        status: 'published', perm: 'public',
        thumbnail_url: 'https://public.example/client-1/thumbnails/a5000002/c9.webp?v=abc',
        download_url: 'https://public.example/client-1/originals/a5000002/c9.pdf?v=abc',
        preview_page_count: 2,
      },
    ];

    const { result } = await sync([p]);

    expect(result.staleObjectKeys).toEqual([
      'client-1/thumbnails/a5000002/c9.webp',
      'client-1/originals/a5000002/c9.pdf',
      'client-1/pages/a5000002/c9/001.webp',
      'client-1/pages/a5000002/c9/002.webp',
    ]);
  });

  it('derives gated cleanup keys from stable identity and the row access level', async () => {
    const p = `${SRC}/Asset __a5000004/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'pdf');
    restStub.existingRows = [
      { id: 'row-live', stable_id: 'a5000004', child_id: 'c1' },
      {
        id: 'row-gone', stable_id: 'a5000004', child_id: 'c9',
        status: 'published', perm: 'client',
        thumbnail_url: 'https://gated.example/client/client-1/thumbnails/a5000004/c9.webp?v=abc',
        download_key: 'client/client-1/originals/a5000004/c9.png',
        download_url: 'https://gated.example/client/client-1/originals/a5000004/c9.png?v=abc',
        preview_page_count: 1,
      },
    ];

    const { result } = await sync([p]);

    expect(result.staleObjectKeys).toEqual([
      'client/client-1/thumbnails/a5000004/c9.webp',
      'client/client-1/originals/a5000004/c9.png',
      'client/client-1/pages/a5000004/c9/001.webp',
    ]);
  });

  it('disconnects nothing when every row is still on disk', async () => {
    const p = `${SRC}/Asset __a5000003/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'pdf');
    restStub.existingRows = [{ id: 'row-live', stable_id: 'a5000003', child_id: 'c1' }];

    const { result } = await sync([p]);

    expect(result.disconnected).toBe(0);
    expect(restStub.disconnectedIds()).toEqual([]);
  });
});

describe('assetExport — guards', () => {
  it('skips a hash claimed by two folders rather than syncing either', async () => {
    // Same hash in two places means a duplicated folder or a moved asset. Writing either would
    // corrupt the other's row, so the run reports and skips.
    const paths = [
      `${SRC}/One __a6000001/OUT/(PRD)(SlD) A.pdf`,
      `${SRC}/Two __a6000001/OUT/(PRD)(SlD) B.pdf`,
    ];
    paths.forEach(p => vfs.put(p, p));
    const { logged } = await sync(paths);

    expect(restStub.inserted()).toEqual([]);
    expect(logged('claimed by multiple folders')).toBe(true);
  });

  it('omits absent URL fields from a PATCH so a cached run cannot wipe stored URLs', async () => {
    // PATCH leaves omitted fields untouched in Postgres. Sending thumbnail_url: null when the
    // upload phase was skipped would blank the portal's image.
    const p = `${SRC}/Asset __a6000002/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'pdf');
    restStub.existingRows = [{ id: 'row-x', stable_id: 'a6000002', child_id: 'c1' }];

    await sync([p]);

    const body = restStub.patched()[0];
    expect('thumbnail_url' in body).toBe(false);
    expect('download_url' in body).toBe(false);
  });

  it('DOES send a URL field when the run actually produced one', async () => {
    const p = `${SRC}/Asset __a6000003/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'pdf');
    restStub.existingRows = [{ id: 'row-y', stable_id: 'a6000003', child_id: 'c1' }];

    await sync([p], { cdnUrls: new Map([[p, 'https://cdn/x.webp']]) });

    expect(restStub.patched()[0].thumbnail_url).toBe('https://cdn/x.webp');
  });

  it('writes the exact identity-derived original key alongside its URL', async () => {
    const p = `${SRC}/Asset __a6000007/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'pdf');

    await sync([p], {
      originalUrls: new Map([[p, 'https://gated.example/client/client-1/originals/a6000007/c1.pdf?v=abc']]),
    });

    expect(restStub.inserted()[0].download_key)
      .toBe('client/client-1/originals/a6000007/c1.pdf');
  });

  it('always clears both relation fields on a primary', async () => {
    // A row synced by an earlier build may carry a stale parent_id or variant_of; an omitted
    // field would leave it in place.
    const p = `${SRC}/Asset __a6000004/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'pdf');
    await sync([p]);

    expect(restStub.inserted()[0]).toMatchObject({ parent_id: null, variant_of: null });
  });

  it('counts an error and keeps going when a write fails', async () => {
    restStub.failUrlMatching = /\/assets$/;      // fail inserts only
    const p = `${SRC}/Asset __a6000005/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'pdf');
    const { result, logged } = await sync([p]);

    expect(result.created).toBe(0);
    expect(result.errors).toBe(1);
    expect(logged('Stable insert failed')).toBe(true);
  });

  it('does not disconnect anything when the existing-rows read fails', async () => {
    // If the read failed, "no row for this key" is unknown rather than false. Treating the empty
    // result as truth would mark every asset disconnected.
    restStub.fetchAllThrows = true;
    const p = `${SRC}/Asset __a6000006/OUT/(PRD)(SlD) Deck.pdf`;
    vfs.put(p, 'pdf');
    const { result, logged } = await sync([p]);

    expect(restStub.byMethod('POST')).toEqual([]);
    expect(restStub.byMethod('PATCH')).toEqual([]);
    expect(vfs.hasFile(`${SRC}/Asset __a6000006/.dchub.json`)).toBe(false);
    expect(result.disconnected).toBe(0);
    expect(result.errors).toBe(1);
    expect(logged('Could not fetch existing stable-identity records')).toBe(true);
    expect(logged('export aborted before planning or writes')).toBe(true);
  });

  it('does nothing at all when there is nothing on disk', async () => {
    const { result } = await sync([]);

    expect(restStub.calls).toEqual([]);
    expect(result).toMatchObject({ created: 0, updated: 0, disconnected: 0, errors: 0 });
  });
});

describe('page-preview counts against an environment that lacks the columns', () => {
  /* PostgREST rejects the WHOLE write when one column is unknown (PGRST204). Sending page counts to
     a database without the migration failed the PARENT row, and every child then skipped for want of
     a parent_id — one additive metadata column stopped a package syncing. Observed on staging. */
  const PATHS = ['/src/Deck __a9000001/OUT/(PRD)(SlD) Deck.pdf'];
  const counts = () => new Map([['/src/Deck __a9000001/OUT/(PRD)(SlD) Deck.pdf',
                                 { total: 40, rendered: 5 }]]);

  it('writes the counts when the columns exist', async () => {
    const { result } = await sync(PATHS, { pageCounts: counts() });
    expect(result.errors).toBe(0);
    const write = restStub.calls.find(c => c.body && 'preview_page_count' in c.body);
    expect(write?.body).toMatchObject({ preview_page_count: 5, preview_page_total: 40 });
  });

  it('still syncs everything else when the columns are missing', async () => {
    // The probe asks for the column and gets a 400 — exactly what an un-migrated database answers.
    restStub.failUrlMatching = /select=preview_page_count/;

    const { result, logged } = await sync(PATHS, { pageCounts: counts() });

    expect(result.errors).toBe(0);
    expect(result.created + result.updated).toBeGreaterThan(0);
    // The fields are withheld, not sent as null — a null would still name the column.
    for (const c of restStub.calls) {
      if (c.body) {
        expect(c.body).not.toHaveProperty('preview_page_count');
        expect(c.body).not.toHaveProperty('preview_page_total');
      }
    }
    expect(logged('no page-preview columns yet')).toBe(true);
  });

  it('does not probe at all when there are no counts to write', async () => {
    await sync(PATHS);
    expect(restStub.calls.some(c => c.url.includes('select=preview_page_count'))).toBe(false);
  });
});
