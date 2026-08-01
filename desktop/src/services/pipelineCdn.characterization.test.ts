/* Characterization tests — CDN KEY GENERATION (runThumbnails → runCdnUpload / runOriginalUpload).
 *
 * An R2 object key is a permanent public address: the portal stores it in the database and
 * browsers cache it. If key construction changes, every already-published asset is orphaned
 * — the object stays in the bucket, unreferenced, and the portal shows a broken image.
 *
 * The key is `{level}/{client_id}/thumbnails|originals/{stable_id}/{child_id}` for gated assets,
 * and `{client_id}/…` — no level segment — for public ones, which stay in the public bucket. The
 * identity halves come from folder identity, deliberately NOT from the filename, so that renaming
 * a file or bumping its version keeps the same address. These tests prove that property end to end
 * — through the real `.dchub.json` manifest on the virtual filesystem — rather than trusting the
 * comment.
 *
 * The LEVEL segment is not decoration: the cdn-gate Worker authorizes a request by reading it back
 * out of the key, without a database lookup. A key written at the wrong level is a 403 on a file
 * the portal is offering, or bytes served to someone who should not have them. A run with no
 * known levels writes everything at the create-time default of `client`, which is what these
 * fixtures exercise — see `assetLevels` in RunContext for the promoted case.
 *
 * Each test uses its own stable id: the module-level R2 upload cache (`r2CacheMemo`) is not
 * resettable from outside, so distinct keys are what keeps tests independent.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', async () => (await import('../test/vfs')).vfs.fsApi());
vi.mock('@tauri-apps/api/path', async () => (await import('../test/vfs')).vfs.pathApi());
vi.mock('@tauri-apps/api/core', async () => ({
  invoke: (await import('../test/invokeStub')).invokeStub.invoke,
}));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: async () => {} }));

const { vfs } = await import('../test/vfs');
const { invokeStub } = await import('../test/invokeStub');
const { runPipeline } = await import('./pipelineService');
const { makeSettings, makeCtx, SRC, R2 } = await import('../test/pipelineHarness');
import type { AppSettings } from '../store/settingsStore';

/** Run the thumbnail + CDN stages. `r2` defaults to the fixture; pass null to omit it. */
async function cdn(
  over: Partial<AppSettings> = {},
  ctxOver: Record<string, unknown> = {},
) {
  const settings = makeSettings({ doThumbnails: true, doCdnOriginals: true, ...over });
  const run = makeCtx(settings, { r2: R2, ...ctxOver });
  const stats = await runPipeline(run.ctx as never);
  return { ...run, stats };
}

beforeEach(() => {
  vfs.reset();
  invokeStub.reset();
});

describe('CDN — object key construction', () => {
  it('keys a thumbnail by folder identity, under the client key prefix', async () => {
    vfs.tree(SRC, { 'Asset __a1000001/[03] OUT/(PRD)(SlD) Deck.pdf': '' });
    await cdn({ doCdnOriginals: false });

    expect(invokeStub.uploadedKeys()).toEqual(['client/client-abc/thumbnails/a1000001/c1.webp']);
  });

  it('keys an original by the same identity, keeping the real extension', async () => {
    vfs.tree(SRC, { 'Asset __a1000002/[03] OUT/(PRD)(SlD) Deck.pdf': '' });
    await cdn({ doThumbnails: false });

    expect(invokeStub.uploadedKeys()).toEqual(['client/client-abc/originals/a1000002/c1.pdf']);
  });

  it('uploads a thumbnail and an original under sibling namespaces', async () => {
    vfs.tree(SRC, { 'Asset __a1000003/[03] OUT/(PRD)(SlD) Deck.pdf': '' });
    await cdn();

    expect(invokeStub.uploadedKeys()).toEqual([
      'client/client-abc/originals/a1000003/c1.pdf',
      'client/client-abc/thumbnails/a1000003/c1.webp',
    ]);
  });

  it('routes a PUBLIC asset to the public bucket, with no level segment in the key', async () => {
    // Public keys are deliberately unchanged from what the pipeline has always written, so an
    // asset that is legitimately public keeps the address it already had and never has to move.
    vfs.tree(SRC, { 'Asset __a1000004/[03] OUT/(PRD)(SlD) Deck.pdf': '' });
    await cdn({ doCdnOriginals: false }, { assetLevels: new Map([['a1000004:c1', 'public']]) });

    expect(invokeStub.uploadedKeys()).toEqual(['client-abc/thumbnails/a1000004/c1.webp']);
    expect(invokeStub.argsFor('upload_to_r2')[0].bucket).toBe('dchub-test');
  });

  it('never double-applies a prefix that a key already carries', async () => {
    // storageKey() is idempotent; a prefix without its trailing slash must behave the same.
    vfs.tree(SRC, { 'Asset __a1000005/[03] OUT/(PRD)(SlD) Deck.pdf': '' });
    await cdn({ doCdnOriginals: false }, { r2: { ...R2, keyPrefix: 'client-abc' } });

    expect(invokeStub.uploadedKeys()).toEqual(['client/client-abc/thumbnails/a1000005/c1.webp']);
  });

  it('sends the right content type for each namespace', async () => {
    vfs.tree(SRC, { 'Asset __a1000006/[03] OUT/(PRD)(SlD) Deck.pdf': '' });
    await cdn();

    const byKey = new Map(invokeStub.argsFor('upload_to_r2').map(a => [a.objectKey, a.contentType]));
    expect(byKey.get('client/client-abc/thumbnails/a1000006/c1.webp')).toBe('image/webp');
    expect(byKey.get('client/client-abc/originals/a1000006/c1.pdf')).toBe('application/pdf');
  });

  it('gives each asset in a package its own child id', async () => {
    vfs.tree(SRC, {
      'Asset __a1000007/[03] OUT/(PRD)(SlD) One.pdf': 'one',
      'Asset __a1000007/[03] OUT/(ACQ)(Gll) Two.jpg': 'two',
    });
    await cdn({ doThumbnails: false });

    expect(invokeStub.uploadedKeys()).toEqual([
      'client/client-abc/originals/a1000007/c1.pdf',
      'client/client-abc/originals/a1000007/c2.jpg',
    ]);
  });

  it('gives extension variants of one stem distinct child ids', async () => {
    // foo.pdf and foo.png share a stem. If they shared a child id they would overwrite
    // each other under one key — the reason identity is resolved per FILE, not per stem.
    vfs.tree(SRC, {
      'Asset __a1000008/[03] OUT/(PRD)(SlD) Deck.pdf': 'pdf bytes',
      'Asset __a1000008/[03] OUT/(PRD)(SlD) Deck.png': 'png bytes',
    });
    await cdn({ doThumbnails: false });

    const keys = invokeStub.uploadedKeys();
    expect(keys).toHaveLength(2);
    expect(new Set(keys.map(k => k.split('/').pop()!.split('.')[0])).size).toBe(2);
  });
});

describe('CDN — identity is rename- and version-proof', () => {
  it('keeps the same key after the file is renamed', async () => {
    // THE property the whole identity design exists for. Content is unchanged, so the
    // manifest's stored sha256 re-matches the entry and the child id is reused.
    vfs.tree(SRC, { 'Asset __a2000001/[03] OUT/(PRD)(SlD) Deck.pdf': 'stable content' });
    await cdn({ doThumbnails: false });
    const before = invokeStub.uploadedKeys();

    invokeStub.reset();
    await vfs.fsApi().rename(
      `${SRC}/Asset __a2000001/[03] OUT/(PRD)(SlD) Deck.pdf`,
      `${SRC}/Asset __a2000001/[03] OUT/(ACQ)(Gll) Completely Different.pdf`,
    );
    await cdn({ doThumbnails: false });

    expect(invokeStub.uploadedKeys()).toEqual(before);
  });

  it('keeps the same key across a version bump', async () => {
    // Version lineage: same base + extension as a manifest entry, so v2 inherits v1's
    // child id and overwrites its object instead of stranding it.
    vfs.tree(SRC, { 'Asset __a2000002/[03] OUT/(PRD)(SlD) Deck v1.pdf': 'v1' });
    await cdn({ doThumbnails: false });
    expect(invokeStub.uploadedKeys()).toEqual(['client/client-abc/originals/a2000002/c1.pdf']);

    invokeStub.reset();
    await vfs.fsApi().remove(`${SRC}/Asset __a2000002/[03] OUT/(PRD)(SlD) Deck v1.pdf`);
    vfs.put(`${SRC}/Asset __a2000002/[03] OUT/(PRD)(SlD) Deck v2.pdf`, 'v2');
    await cdn({ doThumbnails: false });

    expect(invokeStub.uploadedKeys()).toEqual(['client/client-abc/originals/a2000002/c1.pdf']);
  });

  it('keeps the same key after the package folder is retitled', async () => {
    // The folder's title changes; its " __hash" identity does not.
    vfs.tree(SRC, { 'Old Title __a2000003/[03] OUT/(PRD)(SlD) Deck.pdf': 'content' });
    await cdn({ doThumbnails: false });
    const before = invokeStub.uploadedKeys();

    invokeStub.reset();
    await vfs.fsApi().rename(`${SRC}/Old Title __a2000003`, `${SRC}/Brand New Title __a2000003`);
    await cdn({ doThumbnails: false });

    expect(invokeStub.uploadedKeys()).toEqual(before);
  });

  it('persists the identity to .dchub.json so the next run agrees', async () => {
    vfs.tree(SRC, { 'Asset __a2000004/[03] OUT/(PRD)(SlD) Deck.pdf': '' });
    await cdn({ doThumbnails: false });

    const manifest = JSON.parse(vfs.text(`${SRC}/Asset __a2000004/.dchub.json`));
    expect(manifest.stable_id).toBe('a2000004');
    expect(manifest.children['(PRD)(SlD) Deck.pdf'].child_id).toBe('c1');
    // The content hash is what makes rename detection possible on a later run.
    expect(manifest.children['(PRD)(SlD) Deck.pdf'].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reuses child ids recorded by a previous run rather than reallocating', async () => {
    vfs.tree(SRC, {
      'Asset __a2000005/[03] OUT/(PRD)(SlD) One.pdf': 'one',
      'Asset __a2000005/[03] OUT/(ACQ)(Gll) Two.jpg': 'two',
    });
    await cdn({ doThumbnails: false });
    const first = invokeStub.uploadedKeys();

    invokeStub.reset();
    await cdn({ doThumbnails: false });

    expect(invokeStub.uploadedKeys()).toEqual(first);
  });
});

describe('CDN — assets with no folder identity', () => {
  it('refuses to upload a file outside a hashed package folder, and counts an error', async () => {
    // Uploading under a filename-derived key would strand the object on the first rename,
    // so the asset is reported instead. Never invent a key.
    vfs.tree(SRC, { 'Unhashed Folder/[03] OUT/(PRD)(SlD) Deck.pdf': '' });
    const run = await cdn();

    expect(invokeStub.argsFor('upload_to_r2')).toEqual([]);
    expect(run.stats.errors).toBeGreaterThan(0);
    expect(run.logsOfType('error').join('\n')).toContain('no folder identity');
  });

  it('still uploads the identified assets alongside an unidentified one', async () => {
    vfs.tree(SRC, {
      'Good __a3000001/[03] OUT/(PRD)(SlD) Fine.pdf': 'fine',
      'Unhashed/[03] OUT/(PRD)(SlD) Orphan.pdf': 'orphan',
    });
    const run = await cdn({ doThumbnails: false });

    expect(invokeStub.uploadedKeys()).toEqual(['client/client-abc/originals/a3000001/c1.pdf']);
    expect(run.stats.errors).toBe(1);
  });
});

describe('CDN — version filtering', () => {
  it('uploads only the highest version present in a directory', async () => {
    // Feeding several versions through one version-stable key would make them overwrite
    // each other forever.
    vfs.tree(SRC, {
      'Asset __a4000001/[03] OUT/(PRD)(SlD) Deck v1.pdf': 'v1',
      'Asset __a4000001/[03] OUT/(PRD)(SlD) Deck v2.pdf': 'v2',
    });
    const run = await cdn({ doThumbnails: false });

    expect(invokeStub.uploadedKeys()).toEqual(['client/client-abc/originals/a4000001/c1.pdf']);
    expect(run.logsOfType('skip').join('\n')).toContain('older version file(s) excluded from CDN');
  });

  it('keeps version filtering per directory, so both packages survive the filter', async () => {
    vfs.tree(SRC, {
      'A __a4000002/[03] OUT/(PRD)(SlD) Deck v1.pdf': 'a',
      'B __a4000003/[03] OUT/(PRD)(SlD) Deck v1.pdf': 'b',
    });
    await cdn({ doThumbnails: false });

    // Neither file is dropped as an "older version" of the other — that part is correct.
    expect(invokeStub.uploadedKeys()).toHaveLength(2);
  });

  it('F-5: same-named files in two packages upload under their OWN keys', async () => {
    // Regression test for F-5. `resolveCdnIdentity` used to key its map by FILENAME, so two
    // packages holding an identically-named deliverable collided: the second entry
    // overwrote the first and BOTH files then resolved to the second's identity, uploading
    // over each other. One asset's original silently replaced the other's on the CDN and one
    // portal download link served the wrong file.
    //
    // The shape is known-real: assetGrouping.test.ts documents "two 'Deda Energie' packages,
    // each holding plyn.pdf". The map is now keyed by absolute path.
    vfs.tree(SRC, {
      'A __a4000004/[03] OUT/(PRD)(SlD) Deck.pdf': 'content of A',
      'B __a4000005/[03] OUT/(PRD)(SlD) Deck.pdf': 'content of B',
    });
    const run = await cdn({ doThumbnails: false });

    expect(invokeStub.uploadedKeys()).toEqual([
      'client/client-abc/originals/a4000004/c1.pdf',
      'client/client-abc/originals/a4000005/c1.pdf',
    ]);
    // Each file uploaded its own bytes, under its own package's identity.
    const byKey = new Map(invokeStub.argsFor('upload_to_r2').map(a => [a.objectKey, a.filePath]));
    expect(byKey.get('client/client-abc/originals/a4000004/c1.pdf'))
      .toBe(`${SRC}/A __a4000004/[03] OUT/(PRD)(SlD) Deck.pdf`);
    expect(byKey.get('client/client-abc/originals/a4000005/c1.pdf'))
      .toBe(`${SRC}/B __a4000005/[03] OUT/(PRD)(SlD) Deck.pdf`);

    // And each file's row gets its own download URL — the second half of F-5, which would
    // otherwise put one package's URL on the other package's asset.
    const originalUrls = run.ctx.originalUrls as Map<string, string>;
    expect(originalUrls.get(`${SRC}/A __a4000004/[03] OUT/(PRD)(SlD) Deck.pdf`))
      .toContain('originals/a4000004/c1.pdf');
    expect(originalUrls.get(`${SRC}/B __a4000005/[03] OUT/(PRD)(SlD) Deck.pdf`))
      .toContain('originals/a4000005/c1.pdf');
  });

  it('F-5: same-named files in two packages get their own thumbnail keys too', async () => {
    vfs.tree(SRC, {
      'A __a4000006/[03] OUT/(PRD)(SlD) Deck.pdf': 'content of A',
      'B __a4000007/[03] OUT/(PRD)(SlD) Deck.pdf': 'content of B',
    });
    await cdn({ doCdnOriginals: false });

    expect(invokeStub.uploadedKeys()).toEqual([
      'client/client-abc/thumbnails/a4000006/c1.webp',
      'client/client-abc/thumbnails/a4000007/c1.webp',
    ]);
  });

  it('still shares ONE thumbnail key across extension variants of a stem', async () => {
    // The flip side of the F-5 fix: the thumbnail key is scoped to the directory + stem, not
    // the full path, so foo.pdf and foo.png keep pointing at the single foo-thumb.webp
    // rather than uploading it twice under two different child ids.
    vfs.tree(SRC, {
      'Asset __a4000008/[03] OUT/(PRD)(SlD) Deck.pdf': 'pdf bytes',
      'Asset __a4000008/[03] OUT/(PRD)(SlD) Deck.png': 'png bytes',
    });
    await cdn({ doCdnOriginals: false });

    expect(new Set(invokeStub.uploadedKeys()).size).toBe(1);
    expect(invokeStub.uploadedKeys()[0]).toMatch(/^client\/client-abc\/thumbnails\/a4000008\/c\d\.webp$/);
  });
});

describe('CDN — URLs handed to the portal', () => {
  it('records a cache-busted URL on the tier the asset actually landed in', async () => {
    const src = `${SRC}/Asset __a5000001/[03] OUT/(PRD)(SlD) Deck.pdf`;
    vfs.tree(SRC, { 'Asset __a5000001/[03] OUT/(PRD)(SlD) Deck.pdf': '' });
    const run = await cdn();

    const cdnUrls = run.ctx.cdnUrls as Map<string, string>;
    const originalUrls = run.ctx.originalUrls as Map<string, string>;
    // Default level is `client`, so both land behind the gate — and the URL the portal stores
    // has to be the gated hostname, or the row would point at a public address holding nothing.
    // `?v=` rides on both tiers: it is what busts caches when a version bump overwrites a key.
    expect(cdnUrls.get(src)).toBe(
      'https://files.example.com/client/client-abc/thumbnails/a5000001/c1.webp?v=a1b2c3d4e5f6',
    );
    expect(originalUrls.get(src)).toBe(
      'https://files.example.com/client/client-abc/originals/a5000001/c1.pdf?v=a1b2c3d4e5f6',
    );
  });

  it('keys the URL maps by ABSOLUTE PATH, which the Supabase sync looks up per file', async () => {
    // Part of the F-5 fix. A stem key put one package's URL on another package's row when
    // both held the same filename; `exportAssetsToSupabase` now looks these up by absPath.
    vfs.tree(SRC, { 'Asset __a5000002/[03] OUT/(PRD)(SlD) Deck.pdf': '' });
    const run = await cdn({ doThumbnails: false });

    const originalUrls = run.ctx.originalUrls as Map<string, string>;
    expect([...originalUrls.keys()]).toEqual([
      `${SRC}/Asset __a5000002/[03] OUT/(PRD)(SlD) Deck.pdf`,
    ]);
  });
});

describe('CDN — guard rails', () => {
  it('skips the whole stage when the R2 config is incomplete', async () => {
    vfs.tree(SRC, { 'Asset __a6000001/[03] OUT/(PRD)(SlD) Deck.pdf': '' });
    const run = await cdn({}, { r2: { ...R2, secretKey: '' } });

    expect(invokeStub.argsFor('upload_to_r2')).toEqual([]);
    expect(run.logsOfType('error').join('\n')).toContain('CDN config incomplete');
  });

  it('does not resolve identity or upload at all without an R2 config', async () => {
    vfs.tree(SRC, { 'Asset __a6000002/[03] OUT/(PRD)(SlD) Deck.pdf': '' });
    const run = await cdn({}, { r2: undefined });

    expect(invokeStub.argsFor('upload_to_r2')).toEqual([]);
    // No manifest is written either — identity resolution is gated on the CDN being on.
    expect(vfs.hasFile(`${SRC}/Asset __a6000002/.dchub.json`)).toBe(false);
    expect(run.stats.errors).toBe(0);
  });

  it('skips a thumbnail upload when generation failed and left no file', async () => {
    invokeStub.thumbnailFails = true;
    vfs.tree(SRC, { 'Asset __a6000003/[03] OUT/(PRD)(SlD) Deck.pdf': '' });
    const run = await cdn({ doCdnOriginals: false });

    expect(invokeStub.argsFor('upload_to_r2')).toEqual([]);
    // The generation failure is the reported error; the missing thumb is merely skipped.
    expect(run.stats.errors).toBe(1);
  });

  it('survives a failed R2 inventory listing and still uploads', async () => {
    invokeStub.listFails = true;
    vfs.tree(SRC, { 'Asset __a6000004/[03] OUT/(PRD)(SlD) Deck.pdf': '' });
    const run = await cdn({ doThumbnails: false });

    expect(invokeStub.uploadedKeys()).toEqual(['client/client-abc/originals/a6000004/c1.pdf']);
    expect(run.logged('falling back to per-file checks')).toBe(true);
  });

  it('passes remoteExists to Rust so it can skip a byte transfer', async () => {
    vfs.tree(SRC, { 'Asset __a6000005/[03] OUT/(PRD)(SlD) Deck.pdf': '' });
    invokeStub.remoteKeys.add('client/client-abc/originals/a6000005/c1.pdf');
    await cdn({ doThumbnails: false });

    expect(invokeStub.argsFor('upload_to_r2')[0].remoteExists).toBe(true);
  });

  it('ignores files whose extension cannot be thumbnailed', async () => {
    vfs.tree(SRC, { 'Asset __a6000006/[03] OUT/(PRD)(SlD) Archive.zip': '' });
    const run = await cdn({ doCdnOriginals: false });

    expect(invokeStub.argsFor('generate_thumbnail')).toEqual([]);
    expect(run.logged('No thumbnable files found')).toBe(true);
  });
});
