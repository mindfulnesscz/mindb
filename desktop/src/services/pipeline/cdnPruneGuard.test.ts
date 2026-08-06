/* Regression tests for the cross-level prune guard — the data-loss bug of 2026-08-06.
 *
 * `pruneStaleObject` deletes an asset's object at every level that is no longer current. The bug
 * was in how it decided "no longer referenced": it excluded the asset's OWN row from the check, on
 * the assumption that the same run would repoint that row to the new tier. When the repoint or the
 * `cdn-reconcile` failed — which is exactly what happened, in the same run — it deleted the object
 * the portal was still serving. Observed as `pruned stale thumbnail (was public): …/48d94348/c1.webp`
 * against keys the database still pointed at.
 *
 * The fix inverts the default: ANY live row referencing the key is a reason to keep, including the
 * asset's own. A stale-tier object is pruned only once nothing owns it — a genuine orphan, whose
 * repoint landed on an earlier run.
 *
 * These tests pin the four decisions that matter, for thumbnails AND originals (one shared helper,
 * so a regression in either path is the same regression):
 *   own row still points at the old key   → KEEP
 *   nothing points at the old key         → PRUNE
 *   a different live row points at it     → KEEP
 *   dry run / references unavailable      → KEEP (fail closed)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', async () => (await import('../../test/vfs')).vfs.fsApi());
vi.mock('@tauri-apps/api/path', async () => (await import('../../test/vfs')).vfs.pathApi());
vi.mock('@tauri-apps/api/core', async () => ({
  invoke: (await import('../../test/invokeStub')).invokeStub.invoke,
}));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: async () => {} }));

const { vfs } = await import('../../test/vfs');
const { invokeStub } = await import('../../test/invokeStub');
const { runPipeline } = await import('../pipelineService');
const { makeSettings, makeCtx, SRC, R2 } = await import('../../test/pipelineHarness');
import type { AppSettings } from '../../store/settingsStore';

const owner = (stableId: string) => `${stableId}:c1`;
/** The key this asset used to live at, before it was narrowed to `internal`. */
const stalePublicThumb = (stableId: string) => `client-abc/thumbnails/${stableId}/c1.webp`;
const stalePublicOriginal = (stableId: string) => `client-abc/originals/${stableId}/c1.pdf`;

/**
 * Publish one asset at `internal` while a public-tier object for the same identity already exists,
 * so the cross-level prune has exactly one candidate to decide about.
 */
async function runWithStaleObject(
  stableId: string,
  references: Map<string, Set<string>>,
  over: Partial<AppSettings> = {},
) {
  vfs.tree(SRC, { [`Asset __${stableId}/[03] OUT/(PRD)(SlD) Deck.pdf`]: 'current' });
  invokeStub.remoteKeys.add(stalePublicThumb(stableId));
  invokeStub.remoteKeys.add(stalePublicOriginal(stableId));

  const settings = makeSettings({ doThumbnails: true, doCdnOriginals: true, ...over });
  const run = makeCtx(settings, {
    r2: R2,
    assetLevels: new Map([[owner(stableId), 'internal']]),
    cdnKeyReferences: references,
  });
  await runPipeline(run.ctx as never);
  return run;
}

beforeEach(() => {
  vfs.reset();
  invokeStub.reset();
});

describe('cross-level prune guard', () => {
  it('KEEPS the old-tier object while the asset\'s own row still points at it', async () => {
    // The repoint has not landed: the database still serves the public key. This is the exact
    // state the 2026-08-06 bug deleted through.
    const stableId = 'b1000001';
    const run = await runWithStaleObject(stableId, new Map([
      [stalePublicThumb(stableId), new Set([owner(stableId)])],
      [stalePublicOriginal(stableId), new Set([owner(stableId)])],
    ]));

    expect(invokeStub.deletedKeys()).toEqual([]);
    expect(run.logged('own live row still points here')).toBe(true);
  });

  it('PRUNES the old-tier object once nothing references it', async () => {
    // The repoint landed on an earlier run, so the public key is a genuine orphan.
    const stableId = 'b1000002';
    await runWithStaleObject(stableId, new Map());

    expect(invokeStub.deletedKeys()).toEqual([
      stalePublicOriginal(stableId),
      stalePublicThumb(stableId),
    ]);
  });

  it('KEEPS an object a DIFFERENT live row still references', async () => {
    // A gallery parent sharing its first child's media: pruning for the child breaks the parent.
    const stableId = 'b1000003';
    const run = await runWithStaleObject(stableId, new Map([
      [stalePublicThumb(stableId), new Set(['gallery-parent:c1'])],
      [stalePublicOriginal(stableId), new Set(['gallery-parent:c1'])],
    ]));

    expect(invokeStub.deletedKeys()).toEqual([]);
    expect(run.logged('kept shared stale')).toBe(true);
    expect(run.logged('gallery-parent:c1')).toBe(true);
  });

  it('prunes NOTHING on a dry run, even for a genuine orphan', async () => {
    // Same references as the PRUNE case above, so the only difference is the dry-run flag.
    //
    // The stage short-circuits before `pruneStaleObject` is ever reached and reports its intent
    // instead — the `ctx.settings.dryRun` guard inside that function is defensive, not the thing
    // doing the work here. Asserted through the stage's real behaviour rather than that guard's
    // log line, so this test keeps meaning what it says if the short-circuit moves.
    const stableId = 'b1000004';
    const run = await runWithStaleObject(stableId, new Map(), { dryRun: true });

    expect(invokeStub.deletedKeys()).toEqual([]);
    expect(run.logged('[DRY] would upload 1 thumbnail(s) and prune stale thumbnail objects')).toBe(true);
    expect(run.logged('[DRY] would upload 1 original(s)')).toBe(true);
  });

  it('fails CLOSED when the live-row references could not be read', async () => {
    // References unavailable is not evidence of an orphan. Deleting here would be deleting blind.
    const stableId = 'b1000005';
    vfs.tree(SRC, { [`Asset __${stableId}/[03] OUT/(PRD)(SlD) Deck.pdf`]: 'current' });
    invokeStub.remoteKeys.add(stalePublicThumb(stableId));
    invokeStub.remoteKeys.add(stalePublicOriginal(stableId));

    const settings = makeSettings({ doThumbnails: true, doCdnOriginals: true });
    const run = makeCtx(settings, {
      r2: R2,
      assetLevels: new Map([[owner(stableId), 'internal']]),
      cdnKeyReferences: undefined,
    });
    await runPipeline(run.ctx as never);

    expect(invokeStub.deletedKeys()).toEqual([]);
    expect(run.logged('live row references unavailable')).toBe(true);
  });
});
