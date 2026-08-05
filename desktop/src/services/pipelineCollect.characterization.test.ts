/* Characterization tests — COLLECT (runDistribute).
 *
 * Collect fills a `📦` package anchor from the OUT folders around it, then HARD-DELETES
 * everything in that anchor that is not part of the current deliverable set. That purge is
 * the single most destructive operation in the product: it removes files from a folder the
 * client picks up from, with no undo. Git history shows it churning repeatedly —
 * "fix: package OUT mirror cleanup", "wipe target mirrors", "restore package collect on
 * migrated clients", "apply highest-version filter to package export".
 *
 * These tests lock in what it does TODAY, against a real (virtual) filesystem, so Phase 2's
 * decomposition is a refactor rather than a rewrite. They assert on the resulting file tree
 * and on the recorded delete/copy operations — not on log strings, which are cosmetic.
 *
 * Where a behaviour looks surprising it is called out in a comment. Locking a surprise is
 * the point: it turns an accident into a decision.
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
const { makeSettings, makeCtx, SRC, DST } = await import('../test/pipelineHarness');
import type { AppSettings } from '../store/settingsStore';

const PKG = `${SRC}/Campaign/[00] 📦 Handoff`;

/** Two identity folders with OUT deliverables, plus an empty package anchor beside them. */
function seedCampaign() {
  vfs.tree(SRC, {
    'Campaign/[00] 📦 Handoff/': null,
    'Campaign/Asset One __a1b2c3d4/[03] OUT/(PRD)(SlD) Deck v1.pdf': '',
    'Campaign/Asset One __a1b2c3d4/[03] OUT/(PRD)(SlD) Deck v2.pdf': '',
    'Campaign/Asset Two __b2c3d4e5/[03] OUT/(ACQ)(Gll) Photo.jpg': '',
  });
}

async function collect(over: Partial<AppSettings> = {}) {
  const settings = makeSettings({ doDistribute: true, ...over });
  const run = makeCtx(settings);
  const stats = await runPipeline(run.ctx as never);
  return { ...run, stats };
}

beforeEach(() => {
  vfs.reset();
  invokeStub.reset();
});

describe('collect — filling a package anchor', () => {
  it('copies the highest version of each OUT deliverable in, under its translated name', async () => {
    seedCampaign();
    const run = await collect();

    // The vocabulary translation is applied on the way in: shortcodes become labels.
    expect(vfs.relPaths(PKG)).toEqual([
      'Acquisition Gallery — Photo.jpg',
      'Product Slides — Deck v2.pdf',
    ]);
    expect(run.stats.packages).toBe(1);
    expect(run.stats.copied).toBe(2);
    expect(run.stats.errors).toBe(0);
  });

  it('leaves the OUT sources untouched — collect is a copy, never a move', async () => {
    seedCampaign();
    await collect();

    expect(vfs.hasFile(`${SRC}/Campaign/Asset One __a1b2c3d4/[03] OUT/(PRD)(SlD) Deck v2.pdf`)).toBe(true);
    expect(vfs.hasFile(`${SRC}/Campaign/Asset Two __b2c3d4e5/[03] OUT/(ACQ)(Gll) Photo.jpg`)).toBe(true);
    // The superseded v1 stays in OUT as history; only the package mirror is curated.
    expect(vfs.hasFile(`${SRC}/Campaign/Asset One __a1b2c3d4/[03] OUT/(PRD)(SlD) Deck v1.pdf`)).toBe(true);
  });

  it('is idempotent — a second run copies nothing and deletes nothing', async () => {
    seedCampaign();
    await collect();
    const before = vfs.relPaths(PKG);

    vfs.ops = [];
    const second = await collect();

    expect(vfs.relPaths(PKG)).toEqual(before);
    expect(second.stats.copied).toBe(0);
    expect(second.stats.skipped).toBe(2);
    expect(vfs.copied()).toEqual([]);
    expect(vfs.removed()).toEqual([]);
  });

  it('re-copies when the OUT source is newer than the packaged copy', async () => {
    seedCampaign();
    await collect();

    // Touch the source so its mtime beats the packaged copy's.
    vfs.put(`${SRC}/Campaign/Asset One __a1b2c3d4/[03] OUT/(PRD)(SlD) Deck v2.pdf`, 'revised');
    const second = await collect();

    expect(second.stats.copied).toBe(1);
    expect(second.stats.skipped).toBe(1);
    expect(vfs.text(`${PKG}/Product Slides — Deck v2.pdf`)).toBe('revised');
  });

  it('re-copies changed content restored with an older mtime', async () => {
    seedCampaign();
    await collect();

    const source = `${SRC}/Campaign/Asset One __a1b2c3d4/[03] OUT/(PRD)(SlD) Deck v2.pdf`;
    const sameSizeReplacement = vfs.text(source).replace('Deck', 'Dusk');
    vfs.put(source, sameSizeReplacement, 500);
    const second = await collect();

    expect(second.stats.copied).toBe(1);
    expect(vfs.text(`${PKG}/Product Slides — Deck v2.pdf`))
      .toBe(sameSizeReplacement);
  });

  it('harvests OUT from siblings AND from nested identity folders, but never through another package', async () => {
    vfs.tree(SRC, {
      'Campaign/[00] 📦 Handoff/': null,
      'Campaign/[03] OUT/(PRD)(SlD) Sibling.pdf': '',            // OUT beside the anchor
      'Campaign/Deep/Asset __aaaa1111/[03] OUT/(PRD)(SlD) Nested.pdf': '',
      'Campaign/[00] 📦 Other/[03] OUT/(PRD)(SlD) Foreign.pdf': '', // inside a rival anchor
    });
    await collect();

    const names = vfs.relPaths(PKG);
    expect(names).toContain('Product Slides — Sibling.pdf');
    expect(names).toContain('Product Slides — Nested.pdf');
    // A deliverable belonging to another package must never be harvested into this one.
    expect(names).not.toContain('Product Slides — Foreign.pdf');
  });

  it('reports nothing to do when the prefix matches no folder', async () => {
    vfs.tree(SRC, { 'Campaign/Asset __aaaa1111/[03] OUT/(PRD)(SlD) Deck.pdf': '' });
    const run = await collect();

    expect(run.stats.packages).toBe(0);
    expect(run.logged('No package folders found')).toBe(true);
  });

  it('does not treat a stable-id asset folder as a package anchor', async () => {
    // The regression behind "restore package collect on migrated clients": identity
    // folders are sources to harvest FROM, never anchors to fill.
    vfs.tree(SRC, { 'Asset __aaaa1111/[03] OUT/(PRD)(SlD) Deck.pdf': '' });
    const run = await collect();

    expect(run.stats.packages).toBe(0);
    expect(vfs.copied()).toEqual([]);
  });
});

describe('collect — version filtering', () => {
  it('packages only the highest version and says so', async () => {
    seedCampaign();
    const run = await collect();

    expect(vfs.relPaths(PKG)).not.toContain('Product Slides — Deck v1.pdf');
    expect(run.logsOfType('skip').join('\n')).toContain('OUT older versions not packaged');
  });

  it('compares numerically — v10 beats v9', async () => {
    vfs.tree(SRC, {
      '[00] 📦 Handoff/': null,
      'Asset __aaaa1111/[03] OUT/(PRD)(SlD) Deck v9.pdf': '',
      'Asset __aaaa1111/[03] OUT/(PRD)(SlD) Deck v10.pdf': '',
    });
    await collect();

    expect(vfs.relPaths(`${SRC}/[00] 📦 Handoff`)).toEqual(['Product Slides — Deck v10.pdf']);
  });

  it('filters across the whole harvest, not per source folder', async () => {
    // v1 and v2 of one deliverable living in two different identity folders: only the
    // newer may reach the package, or the client sees the same document twice.
    vfs.tree(SRC, {
      '[00] 📦 Handoff/': null,
      'Old __aaaa1111/[03] OUT/(PRD)(SlD) Deck v1.pdf': '',
      'New __bbbb2222/[03] OUT/(PRD)(SlD) Deck v2.pdf': '',
    });
    await collect();

    expect(vfs.relPaths(`${SRC}/[00] 📦 Handoff`)).toEqual(['Product Slides — Deck v2.pdf']);
  });

  it('keeps unversioned files alongside versioned ones', async () => {
    vfs.tree(SRC, {
      '[00] 📦 Handoff/': null,
      'Asset __aaaa1111/[03] OUT/(PRD)(SlD) Deck v2.pdf': '',
      'Asset __aaaa1111/[03] OUT/README.md': '',
    });
    await collect();

    // README.md has no bracket tags, so translation falls back to the original name.
    expect(vfs.relPaths(`${SRC}/[00] 📦 Handoff`)).toEqual([
      'Product Slides — Deck v2.pdf', 'README.md',
    ].sort());
  });
});

describe('collect — the mirror purge (destructive)', () => {
  it('deletes a stale deliverable that is no longer in OUT', async () => {
    seedCampaign();
    vfs.put(`${PKG}/Retired Deliverable.pdf`, 'stale');
    await collect();

    expect(vfs.hasFile(`${PKG}/Retired Deliverable.pdf`)).toBe(false);
    expect(vfs.removed()).toContain(`${PKG}/Retired Deliverable.pdf`);
  });

  it('deletes the previous name after a taxonomy rename, leaving exactly one copy', async () => {
    // The scenario that makes the purge necessary: a shortcode change renames the
    // translated output, and without the purge the client would see both names.
    seedCampaign();
    vfs.put(`${PKG}/Old Label — Deck v2.pdf`, 'previous translation');
    await collect();

    expect(vfs.relPaths(PKG)).toEqual([
      'Acquisition Gallery — Photo.jpg',
      'Product Slides — Deck v2.pdf',
    ]);
  });

  /* A document's per-page previews live in `<stem>-thumb/` beside it. They are web-preview only and
     must never be packaged or collected as assets.

     This is the failure mode worth guarding: the page files are named `001.webp`, which contains no
     `-thumb`, so the long-standing `name.includes('-thumb')` file filter does NOT catch them. The
     exclusion only works if it is applied to the DIRECTORY before a walker descends. Two walkers
     were missing that — `pipeline/fs.ts` (which would have collected the pages as publishable
     assets, then given each one a thumbnail of its own) and `dam/scan.ts` (which would have
     registered every previews folder as an orphan asset folder in the vault). */
  it('never collects or packages a document\'s per-page previews', async () => {
    seedCampaign();
    const previews = `${SRC}/Campaign/Asset One __a1b2c3d4/[03] OUT/(PRD)(SlD) Deck v2-thumb`;
    vfs.put(`${previews}/001.webp`, 'page 1');
    vfs.put(`${previews}/002.webp`, 'page 2');
    vfs.put(`${previews}/pages.json`, '{"version":1}');

    await collect();

    // Only the real deliverables reach the package — no page files, no previews folder.
    expect(vfs.relPaths(PKG)).toEqual([
      'Acquisition Gallery — Photo.jpg',
      'Product Slides — Deck v2.pdf',
    ]);
  });

  /* Hard-mirror semantics: a previews folder that somehow reached a package is purged as a UNIT.
     Purging its files one by one would leave the empty directory behind. */
  it('purges a previews folder that reached a package, directory included', async () => {
    seedCampaign();
    vfs.put(`${PKG}/Product Slides — Deck v2-thumb/001.webp`, 'stray page');
    await collect();

    expect(vfs.hasFile(`${PKG}/Product Slides — Deck v2-thumb/001.webp`)).toBe(false);
    expect(vfs.relPaths(PKG)).toEqual([
      'Acquisition Gallery — Photo.jpg',
      'Product Slides — Deck v2.pdf',
    ]);
  });

  it('deletes thumbnails and previously-flagged 🚫 files unconditionally', async () => {
    seedCampaign();
    vfs.put(`${PKG}/Product Slides — Deck v2-thumb.webp`, 'thumb');
    vfs.put(`${PKG}/🚫 Something Gone.pdf`, 'flagged');
    await collect();

    expect(vfs.hasFile(`${PKG}/Product Slides — Deck v2-thumb.webp`)).toBe(false);
    expect(vfs.hasFile(`${PKG}/🚫 Something Gone.pdf`)).toBe(false);
  });

  it('purges recursively into subfolders of the package', async () => {
    seedCampaign();
    vfs.put(`${PKG}/Archive/Ancient.pdf`, 'stale');
    await collect();

    expect(vfs.hasFile(`${PKG}/Archive/Ancient.pdf`)).toBe(false);
  });

  it('spares dotfiles — the .dchub.json identity manifest must survive', async () => {
    // Losing the manifest would strand every published CDN object for this package.
    seedCampaign();
    vfs.put(`${PKG}/.dchub.json`, '{"stable_id":"a1b2c3d4","children":{}}');
    await collect();

    expect(vfs.hasFile(`${PKG}/.dchub.json`)).toBe(true);
  });

  it('spares files with no extension', async () => {
    // isPublishableFile() gates the purge, so extension-less files are left alone.
    seedCampaign();
    vfs.put(`${PKG}/NOTES`, 'hand-written');
    await collect();

    expect(vfs.hasFile(`${PKG}/NOTES`)).toBe(true);
  });

  it('spares an excluded-mark file inside the package', async () => {
    // shouldSkip() runs before the purge decision, so a ⦰ file is skipped, not deleted.
    seedCampaign();
    vfs.put(`${PKG}/⦰ Keep Me.pdf`, 'excluded');
    await collect();

    expect(vfs.hasFile(`${PKG}/⦰ Keep Me.pdf`)).toBe(true);
  });

  it('purges nothing when OUT is empty — an empty harvest aborts before the delete', async () => {
    // THE most important guard here. If an unreadable or empty OUT were treated as "no
    // live files", the purge would wipe the entire client pickup folder.
    vfs.tree(SRC, {
      '[00] 📦 Handoff/Existing Deliverable.pdf': 'precious',
      'Asset __aaaa1111/[03] OUT/': null,
    });
    const run = await collect();

    expect(vfs.hasFile(`${SRC}/[00] 📦 Handoff/Existing Deliverable.pdf`)).toBe(true);
    expect(vfs.removed()).toEqual([]);
    expect(run.stats.packages).toBe(0);
    expect(run.logged('no OUT files found')).toBe(true);
  });
});

describe('collect — dry run', () => {
  it('reports what it would do and touches nothing', async () => {
    seedCampaign();
    vfs.put(`${PKG}/Retired.pdf`, 'stale');

    const run = await collect({ dryRun: true });

    // Counted as if it had run...
    expect(run.stats.copied).toBe(2);
    // ...but the filesystem is untouched.
    expect(vfs.copied()).toEqual([]);
    expect(vfs.removed()).toEqual([]);
    expect(vfs.hasFile(`${PKG}/Retired.pdf`)).toBe(true);
    expect(vfs.hasFile(`${PKG}/Product Slides — Deck v2.pdf`)).toBe(false);
    expect(run.logged('[DRY]')).toBe(true);
  });
});

describe('pipeline stop checkpoints', () => {
  it('halts before the next stage after Stop is requested', async () => {
    seedCampaign();
    const settings = makeSettings({ doDistribute: true, doPublish: true });
    const run = makeCtx(settings);
    let stopping = false;
    const capture = run.ctx.appendLog as (type: string, message: string) => void;
    run.ctx.appendLog = (type: string, message: string) => {
      capture(type, message);
      if (message.includes('COLLECT DONE')) stopping = true;
    };
    run.ctx.isStopping = () => stopping;

    await runPipeline(run.ctx as never);

    expect(vfs.relPaths(PKG)).toHaveLength(2);
    expect(vfs.relPaths(DST)).toEqual([]);
    expect(run.logged('halted before local publish')).toBe(true);
  });
});

describe('collect — exclusion marks', () => {
  it('skips marked files and everything under a marked folder', async () => {
    vfs.tree(SRC, {
      '[00] 📦 Handoff/': null,
      'Asset __aaaa1111/[03] OUT/(PRD)(SlD) Good.pdf': '',
      'Asset __aaaa1111/[03] OUT/⦰ (PRD)(SlD) Draft.pdf': '',
      '⦰ Rejected __bbbb2222/[03] OUT/(PRD)(SlD) Hidden.pdf': '',
    });
    await collect();

    expect(vfs.relPaths(`${SRC}/[00] 📦 Handoff`)).toEqual(['Product Slides — Good.pdf']);
  });

  it('always skips Office lock files and [99] folders', async () => {
    vfs.tree(SRC, {
      '[00] 📦 Handoff/': null,
      'Asset __aaaa1111/[03] OUT/(PRD)(SlD) Good.pdf': '',
      'Asset __aaaa1111/[03] OUT/~$(PRD)(SlD) Locked.pptx': '',
      '[99] Archive __bbbb2222/[03] OUT/(PRD)(SlD) Archived.pdf': '',
    });
    await collect();

    expect(vfs.relPaths(`${SRC}/[00] 📦 Handoff`)).toEqual(['Product Slides — Good.pdf']);
  });

});

describe('collect — name translation on the way in', () => {
  it('falls back to the original filename when there are no bracket tags', async () => {
    vfs.tree(SRC, {
      '[00] 📦 Handoff/': null,
      'Asset __aaaa1111/[03] OUT/Plain Document.pdf': '',
    });
    await collect();

    expect(vfs.relPaths(`${SRC}/[00] 📦 Handoff`)).toEqual(['Plain Document.pdf']);
  });

  it('keeps an unknown shortcode visible in brackets rather than dropping it', async () => {
    vfs.tree(SRC, {
      '[00] 📦 Handoff/': null,
      'Asset __aaaa1111/[03] OUT/(PRD)(ZZZ) Deck.pdf': '',
    });
    await collect();

    expect(vfs.relPaths(`${SRC}/[00] 📦 Handoff`)).toEqual(['Product [ZZZ] — Deck.pdf']);
  });

  it('moves a YYMM date tag to the front of the translated name', async () => {
    vfs.tree(SRC, {
      '[00] 📦 Handoff/': null,
      'Asset __aaaa1111/[03] OUT/(2504)(PRD)(SlD) Deck.pdf': '',
    });
    await collect();

    expect(vfs.relPaths(`${SRC}/[00] 📦 Handoff`)).toEqual(['2504 Product Slides — Deck.pdf']);
  });

  it('F-6: reports a collision when two OUT files translate to the same package name', async () => {
    // Regression test for F-6. Distinct sources, identical translated destination: the first
    // was copied and the second then lost the isUnchanged() mtime comparison against that
    // fresh copy, so it was counted "unchanged" and dropped — its content never reached the
    // client and nothing was reported, making it indistinguishable from an up-to-date file.
    //
    // Now the first writer is kept and the loser is surfaced as an error issue naming both
    // files, so the operator can rename one.
    vfs.tree(SRC, {
      '[00] 📦 Handoff/': null,
      'A __aaaa1111/[03] OUT/(PRD)(SlD) Deck.pdf': 'from A',
      'B __bbbb2222/[03] OUT/(PRD)(SlD) Deck.pdf': 'from B',
    });
    const run = await collect();

    expect(vfs.relPaths(`${SRC}/[00] 📦 Handoff`)).toEqual(['Product Slides — Deck.pdf']);
    expect(run.stats.copied).toBe(1);
    expect(run.stats.errors).toBe(1);
    expect(run.issues).toHaveLength(1);
    expect(run.issues[0].category).toBe('error');
    expect(run.issues[0].reason).toContain('translate to the same package name');
    expect(run.issues[0].reason).toContain('was NOT');
  });

  it('F-6: does not cry collision when the same file is simply unchanged from a prior run', async () => {
    // The guard is per-run and keyed on the destination, so a genuine no-op second run must
    // stay silent — otherwise every idempotent re-run would report phantom collisions.
    seedCampaign();
    await collect();
    const second = await collect();

    expect(second.issues).toEqual([]);
    expect(second.stats.errors).toBe(0);
    expect(second.stats.skipped).toBe(2);
  });
});
