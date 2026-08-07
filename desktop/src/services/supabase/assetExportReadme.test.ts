/* readme.md writes during the export, end to end — the real readmeService over a virtual disk.
 *
 * `assetExport.characterization.test.ts` stubs readmeService out, deliberately: a readme failure
 * should not read as a sync failure there. That leaves the property this file exists for uncovered.
 *
 * These files sit one-per-package-folder in the client's SYNCED Dropbox source tree, and the export
 * regenerates every one of them on every run. Until the content became deterministic they all
 * differed from disk every time, so every run rewrote the whole tree and Dropbox spent the minutes
 * after each run re-uploading it. What must hold now: a run over unchanged data writes NOTHING, and
 * a run where one asset's stats moved writes exactly that one file.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', async () => (await import('../../test/vfs')).vfs.fsApi());
vi.mock('@tauri-apps/api/path', async () => (await import('../../test/vfs')).vfs.pathApi());
vi.mock('./rest', async () => (await import('../../test/restStub')).restStub.api());
// Stats come from the database; the readme rendering of them is what is under test.
const statsStub = vi.hoisted(() => ({ fetchAssetStats: vi.fn() }));
vi.mock('./assetQueries', () => ({ fetchAssetStats: statsStub.fetchAssetStats }));

const { vfs } = await import('../../test/vfs');
const { restStub } = await import('../../test/restStub');
const { exportAssetsToSupabase } = await import('./assetExport');
const { groupAssets } = await import('@sotto/domain');
import type { VocabularyData, VocabTag } from '@sotto/domain';
import type { AssetStatsSnapshot } from '../readmeService';

const SRC = '/src';
const CLIENT = 'client-1';
const config = { url: 'https://test.supabase.co', anonKey: 'anon' };

const tag = (shortcode: string, slot: VocabTag['slot'], label: string): VocabTag =>
  ({ shortcode, slot, parentGroup: null, label, key: label.toLowerCase(), icon: '' });

const VOCAB: VocabularyData = {
  _schema_version: '4.0.0', _comment: 'test',
  tags: [tag('PRD', 'entity', 'Product'), tag('SlD', 'format', 'Slides')],
};

const stats = (over: Partial<AssetStatsSnapshot> = {}): AssetStatsSnapshot =>
  ({ downloads: 1, views: 2, avgRating: 4, ratingCount: 1, commentCount: 0, ...over });

/** Two packages, each with one file, each with a row already in the database. */
const PACKAGES = [
  { dir: `${SRC}/Alpha __a7000001`, stableId: 'a7000001', rowId: 'row-alpha' },
  { dir: `${SRC}/Beta __b7000002`,  stableId: 'b7000002', rowId: 'row-beta'  },
];
const paths = PACKAGES.map(p => `${p.dir}/OUT/(PRD)(SlD) Deck.pdf`);

async function sync() {
  const { singles, galleries } = groupAssets(paths, 'OUT');
  const logs: Array<{ type: string; msg: string }> = [];
  await exportAssetsToSupabase(
    singles, CLIENT, VOCAB, config,
    (type, msg) => { logs.push({ type, msg }); },
    undefined, undefined, galleries,
  );
  return logs.map(l => l.msg);
}

/** readme.md paths written since the last `vfs.reset()` / clear, in order. */
const readmeWrites = (): string[] =>
  vfs.ops.filter(o => o.kind === 'write' && o.path.endsWith('/readme.md'))
    .map(o => (o as { path: string }).path);

beforeEach(() => {
  vfs.reset();
  restStub.reset();
  paths.forEach(p => vfs.put(p, 'pdf'));
  restStub.existingRows = PACKAGES.map(p => ({
    id: p.rowId, stable_id: p.stableId, child_id: 'c1',
    parent_id: null, variant_of: null, perm: 'client', status: 'published',
  }));
  statsStub.fetchAssetStats.mockReset().mockResolvedValue(
    new Map(PACKAGES.map(p => [p.rowId, stats()])),
  );
});

describe('assetExport — readme.md churn', () => {
  it('writes each readme once on the first run, then nothing at all on an unchanged second run', async () => {
    const first = await sync();
    expect(readmeWrites().sort()).toEqual(PACKAGES.map(p => `${p.dir}/readme.md`).sort());
    expect(first.some(m => m.includes('readme.md: 2 updated · 0 unchanged'))).toBe(true);

    vfs.ops = [];
    const second = await sync();

    expect(readmeWrites()).toEqual([]);
    expect(second.some(m => m.includes('readme.md: 0 updated · 2 unchanged'))).toBe(true);
  });

  it('writes exactly the one readme whose stats moved', async () => {
    await sync();
    vfs.ops = [];

    statsStub.fetchAssetStats.mockResolvedValue(new Map([
      ['row-alpha', stats({ views: 99 })],
      ['row-beta',  stats()],
    ]));
    const logs = await sync();

    expect(readmeWrites()).toEqual([`${SRC}/Alpha __a7000001/readme.md`]);
    expect(vfs.text(`${SRC}/Alpha __a7000001/readme.md`)).toContain('- Views: 99');
    expect(logs.some(m => m.includes('readme.md: 1 updated · 1 unchanged'))).toBe(true);
  });

  it('rewrites a readme a teammate edited in the synced folder', async () => {
    await sync();
    const edited = `${SRC}/Beta __b7000002/readme.md`;
    const generated = vfs.text(edited);
    vfs.put(edited, '# Beta\n\nsomeone typed here\n');
    vfs.ops = [];

    await sync();

    expect(readmeWrites()).toEqual([edited]);
    expect(vfs.text(edited)).toBe(generated);
  });
});
