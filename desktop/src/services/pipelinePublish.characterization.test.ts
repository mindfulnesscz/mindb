/* Characterization tests — PUBLISH (runPublish) and disconnect handling.
 *
 * Publish mirrors the OUT tree into a client-visible target folder, then reconciles that
 * target: anything no longer in source is renamed with a 🚫 prefix, or — inside a 📦
 * package mirror — hard-deleted. Both halves are destructive against a folder the client
 * reads, and "wipe target mirrors" appears verbatim in the git history.
 *
 * Locked here: the two layouts, stable-id stripping on the way out, per-directory version
 * filtering, the sibling-OUT rule that keeps working folders unpublished, and the
 * disconnect/delete split.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', async () => (await import('../test/vfs')).vfs.fsApi());
vi.mock('@tauri-apps/api/path', async () => (await import('../test/vfs')).vfs.pathApi());
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => ({}) }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: async () => {} }));

const { vfs } = await import('../test/vfs');
const { runPipeline } = await import('./pipelineService');
const { makeSettings, makeCtx, SRC, DST } = await import('../test/pipelineHarness');
import type { AppSettings } from '../store/settingsStore';

function seedCampaign() {
  vfs.tree(SRC, {
    'Campaign/[00] 📦 Handoff/': null,
    'Campaign/Asset One __a1b2c3d4/[03] OUT/(PRD)(SlD) Deck v1.pdf': '',
    'Campaign/Asset One __a1b2c3d4/[03] OUT/(PRD)(SlD) Deck v2.pdf': '',
    'Campaign/Asset Two __b2c3d4e5/[03] OUT/(ACQ)(Gll) Photo.jpg': '',
  });
}

async function publish(
  over: Partial<AppSettings> = {},
  ctxOver: Record<string, unknown> = {},
) {
  const settings = makeSettings({ doPublish: true, ...over });
  const run = makeCtx(settings, { localExportLayout: 'folders', ...ctxOver });
  const stats = await runPipeline(run.ctx as never);
  return { ...run, stats };
}

beforeEach(() => vfs.reset());

describe('publish — folders layout', () => {
  it('mirrors the OUT tree, stripping stable ids from folder names', async () => {
    seedCampaign();
    await publish();

    // The " __hash" suffix is an internal identity marker — it must never reach a client.
    expect(vfs.relPaths(DST)).toEqual([
      'Campaign/Asset One/Product Slides — Deck v2.pdf',
      'Campaign/Asset Two/Acquisition Gallery — Photo.jpg',
    ]);
  });

  it('does not reproduce the OUT folder itself in the target', async () => {
    seedCampaign();
    await publish();

    expect(vfs.hasDir(`${DST}/Campaign/Asset One/[03] OUT`)).toBe(false);
  });

  it('applies version filtering per directory', async () => {
    seedCampaign();
    const run = await publish();

    expect(vfs.relPaths(DST).some(p => p.includes('Deck v1'))).toBe(false);
    expect(run.logsOfType('skip').join('\n')).toContain('dropped');
  });

  it('publishes same-named deliverables from different assets side by side', async () => {
    // The counterpart to collect's collision: with the folder tree preserved, two assets
    // may legitimately each own a "Deck", and both must survive.
    vfs.tree(SRC, {
      'A __aaaa1111/[03] OUT/(PRD)(SlD) Deck.pdf': 'from A',
      'B __bbbb2222/[03] OUT/(PRD)(SlD) Deck.pdf': 'from B',
    });
    await publish();

    expect(vfs.relPaths(DST)).toEqual([
      'A/Product Slides — Deck.pdf',
      'B/Product Slides — Deck.pdf',
    ]);
    expect(vfs.text(`${DST}/A/Product Slides — Deck.pdf`)).toBe('from A');
    expect(vfs.text(`${DST}/B/Product Slides — Deck.pdf`)).toBe('from B');
  });

  it('preserves a gallery subfolder inside OUT', async () => {
    vfs.tree(SRC, {
      'Shoot __aaaa1111/[03] OUT/(PRD)(Gll) Studios/01.jpg': '',
      'Shoot __aaaa1111/[03] OUT/(PRD)(Gll) Studios/02.jpg': '',
    });
    await publish();

    expect(vfs.relPaths(DST)).toEqual([
      'Shoot/(PRD)(Gll) Studios/01.jpg',
      'Shoot/(PRD)(Gll) Studios/02.jpg',
    ]);
  });

  it('ignores sibling folders once an OUT exists — working files stay internal', async () => {
    // `hasSiblingOut`: when a folder contains OUT, its other subfolders are NOT walked.
    // This is what keeps 01 WORKING / 02 REVIEW trees out of the client's view.
    vfs.tree(SRC, {
      'Asset __aaaa1111/[03] OUT/(PRD)(SlD) Final.pdf': '',
      'Asset __aaaa1111/01 WORKING/draft.psd': '',
      'Asset __aaaa1111/02 REVIEW/notes.docx': '',
    });
    await publish();

    expect(vfs.relPaths(DST)).toEqual(['Asset/Product Slides — Final.pdf']);
  });

  it('skips excluded files and marked folders', async () => {
    vfs.tree(SRC, {
      'Asset __aaaa1111/[03] OUT/(PRD)(SlD) Good.pdf': '',
      'Asset __aaaa1111/[03] OUT/⦰ (PRD)(SlD) Draft.pdf': '',
      '⦰ Rejected __bbbb2222/[03] OUT/(PRD)(SlD) Hidden.pdf': '',
    });
    await publish();

    expect(vfs.relPaths(DST)).toEqual(['Asset/Product Slides — Good.pdf']);
  });

  it('never publishes thumbnails', async () => {
    vfs.tree(SRC, {
      'Asset __aaaa1111/[03] OUT/(PRD)(SlD) Deck.pdf': '',
      'Asset __aaaa1111/[03] OUT/(PRD)(SlD) Deck-thumb.webp': '',
    });
    await publish();

    expect(vfs.relPaths(DST)).toEqual(['Asset/Product Slides — Deck.pdf']);
  });

  it('excludes package folders from the folder tree by default', async () => {
    seedCampaign();
    vfs.put(`${SRC}/Campaign/[00] 📦 Handoff/Something.pdf`, 'packaged');
    await publish();

    expect(vfs.relPaths(DST).some(p => p.includes('📦'))).toBe(false);
  });

  it('is idempotent — a second run publishes nothing new and disconnects nothing', async () => {
    seedCampaign();
    await publish();
    const before = vfs.relPaths(DST);

    vfs.ops = [];
    const second = await publish();

    expect(vfs.relPaths(DST)).toEqual(before);
    expect(second.stats.published).toBe(0);
    expect(second.stats.disconnected).toBe(0);
    expect(vfs.copied()).toEqual([]);
    expect(vfs.renamed()).toEqual([]);
  });

  it('refuses to run without a target folder', async () => {
    seedCampaign();
    const run = await publish({ targetFolder: '' });

    expect(run.logged('Target folder not set')).toBe(true);
    expect(vfs.copied()).toEqual([]);
  });
});

describe('publish — flat layout', () => {
  it('dumps every deliverable into the target root under its translated name', async () => {
    seedCampaign();
    await publish({}, { localExportLayout: 'flat' });

    expect(vfs.relPaths(DST)).toEqual([
      'Acquisition Gallery — Photo.jpg',
      'Product Slides — Deck v2.pdf',
    ]);
  });

  it('filters versions globally, not per folder — same name anywhere collapses', async () => {
    // In flat mode there is no folder to disambiguate, so v1 in one asset loses to v2 in
    // another. This is the layout's defining trade-off.
    vfs.tree(SRC, {
      'Old __aaaa1111/[03] OUT/(PRD)(SlD) Deck v1.pdf': '',
      'New __bbbb2222/[03] OUT/(PRD)(SlD) Deck v2.pdf': '',
    });
    await publish({}, { localExportLayout: 'flat' });

    expect(vfs.relPaths(DST)).toEqual(['Product Slides — Deck v2.pdf']);
  });

  it('F-6: reports a collision when two sources publish to the same target name', async () => {
    // In flat layout there is no folder tree left to disambiguate names, so this is where a
    // collision is most likely. The first writer wins; the loser is now an error issue
    // instead of being silently counted as skipped.
    vfs.tree(SRC, {
      'A __aaaa1111/[03] OUT/(PRD)(SlD) Deck.pdf': 'from A',
      'B __bbbb2222/[03] OUT/(PRD)(SlD) Deck.pdf': 'from B',
    });
    const run = await publish({}, { localExportLayout: 'flat' });

    expect(vfs.relPaths(DST)).toEqual(['Product Slides — Deck.pdf']);
    expect(run.stats.published).toBe(1);
    expect(run.stats.errors).toBe(1);
    expect(run.issues.some(i => i.reason.includes('publish to the same target'))).toBe(true);
  });

  it('never nests — a gallery folder is flattened away', async () => {
    vfs.tree(SRC, {
      'Shoot __aaaa1111/[03] OUT/(PRD)(Gll) Studios/01.jpg': '',
    });
    await publish({}, { localExportLayout: 'flat' });

    expect(vfs.relPaths(DST)).toEqual(['01.jpg']);
  });
});

describe('publish — nested packages', () => {
  it('mirrors the package folder at its source-relative path when enabled', async () => {
    seedCampaign();
    await publish({}, { localExportLayout: 'folders', localIncludePackages: true });

    expect(vfs.relPaths(DST)).toEqual([
      'Campaign/Asset One/Product Slides — Deck v2.pdf',
      'Campaign/Asset Two/Acquisition Gallery — Photo.jpg',
      'Campaign/[00] 📦 Handoff/Acquisition Gallery — Photo.jpg',
      'Campaign/[00] 📦 Handoff/Product Slides — Deck v2.pdf',
    ].sort());
  });

  it('hard-deletes a stale file from the target package mirror instead of flagging it', async () => {
    // Package mirrors are pickup folders: a 🚫-prefixed leftover would still be visible
    // to whoever collects the handoff, so stale entries are removed outright.
    seedCampaign();
    vfs.put(`${DST}/Campaign/[00] 📦 Handoff/Retired.pdf`, 'stale');

    const run = await publish({}, { localExportLayout: 'folders', localIncludePackages: true });

    expect(vfs.hasFile(`${DST}/Campaign/[00] 📦 Handoff/Retired.pdf`)).toBe(false);
    expect(vfs.hasFile(`${DST}/Campaign/[00] 📦 Handoff/🚫 Retired.pdf`)).toBe(false);
    expect(run.stats.disconnected).toBeGreaterThan(0);
  });

  it('does not publish package folders at all when the flag is off', async () => {
    seedCampaign();
    await publish({}, { localExportLayout: 'folders', localIncludePackages: false });

    expect(vfs.relPaths(DST).some(p => p.includes('📦'))).toBe(false);
  });

  it('is forced off by the flat layout', async () => {
    // resolveExportShape's invariant, enforced again at publish time.
    seedCampaign();
    await publish({}, { localExportLayout: 'flat', localIncludePackages: true });

    expect(vfs.relPaths(DST)).toEqual([
      'Acquisition Gallery — Photo.jpg',
      'Product Slides — Deck v2.pdf',
    ]);
  });
});

describe('publish — disconnect reconciliation', () => {
  it('renames a file that is no longer in source with a 🚫 prefix', async () => {
    seedCampaign();
    vfs.put(`${DST}/Campaign/Asset One/Retired Deliverable.pdf`, 'stale');

    const run = await publish();

    expect(vfs.hasFile(`${DST}/Campaign/Asset One/🚫 Retired Deliverable.pdf`)).toBe(true);
    expect(vfs.hasFile(`${DST}/Campaign/Asset One/Retired Deliverable.pdf`)).toBe(false);
    expect(run.stats.disconnected).toBeGreaterThan(0);
    expect(run.issues.some(i => i.category === 'disconnected')).toBe(true);
  });

  it('flags rather than deletes — the client keeps the file, just marked', async () => {
    // The deliberate asymmetry with package mirrors: outside a 📦, nothing is destroyed.
    seedCampaign();
    vfs.put(`${DST}/Campaign/Asset One/Retired.pdf`, 'precious');
    await publish();

    expect(vfs.text(`${DST}/Campaign/Asset One/🚫 Retired.pdf`)).toBe('precious');
    expect(vfs.removed()).toEqual([]);
  });

  it('does not re-flag an already-flagged file', async () => {
    seedCampaign();
    vfs.put(`${DST}/Campaign/Asset One/🚫 Retired.pdf`, 'stale');

    await publish();

    expect(vfs.hasFile(`${DST}/Campaign/Asset One/🚫 🚫 Retired.pdf`)).toBe(false);
    expect(vfs.hasFile(`${DST}/Campaign/Asset One/🚫 Retired.pdf`)).toBe(true);
  });

  it('flags a whole folder that no longer exists in source — and its contents too', async () => {
    // Files are processed before folders, so a stale file inside a stale folder is flagged
    // individually first and then carried along by the folder rename. The result is
    // double-marked: "🚫 Retired Asset/🚫 old.pdf". Cosmetic, but locked so a Phase 2
    // reorder of that loop is a visible change rather than a silent one.
    seedCampaign();
    vfs.put(`${DST}/Campaign/Retired Asset/old.pdf`, 'stale');

    await publish();

    expect(vfs.relPaths(DST)).toContain('Campaign/🚫 Retired Asset/🚫 old.pdf');
    expect(vfs.hasDir(`${DST}/Campaign/Retired Asset`)).toBe(false);
  });

  it('leaves dotfiles in the target alone', async () => {
    seedCampaign();
    vfs.put(`${DST}/.DS_Store`, 'junk');
    await publish();

    expect(vfs.hasFile(`${DST}/.DS_Store`)).toBe(true);
  });

  it('in flat layout reconciles direct children only — including whole folders', async () => {
    // inLayoutScope() keeps flat-mode reconciliation to entries with no '/' in their
    // relative path. That covers top-level FOLDERS as well as files, so a directory left
    // behind by a previous `folders`-layout run is flagged as one unit and its contents
    // ride along un-marked, rather than each nested file being flagged individually.
    seedCampaign();
    vfs.put(`${DST}/Stale At Root.pdf`, 'stale');
    vfs.put(`${DST}/Legacy Folder/nested.pdf`, 'stale');

    await publish({}, { localExportLayout: 'flat' });

    expect(vfs.hasFile(`${DST}/🚫 Stale At Root.pdf`)).toBe(true);
    // The folder moved; the file inside kept its name.
    expect(vfs.hasFile(`${DST}/🚫 Legacy Folder/nested.pdf`)).toBe(true);
    expect(vfs.hasDir(`${DST}/Legacy Folder`)).toBe(false);
  });
});

describe('publish — dry run', () => {
  it('copies nothing, and skips reconciliation entirely', async () => {
    seedCampaign();
    vfs.put(`${DST}/Campaign/Asset One/Retired.pdf`, 'stale');

    const run = await publish({ dryRun: true });

    expect(run.stats.published).toBe(2);
    expect(vfs.copied()).toEqual([]);
    expect(vfs.renamed()).toEqual([]);
    // Not even the 🚫 rename is previewed — dry run returns before flagDisconnected.
    expect(vfs.hasFile(`${DST}/Campaign/Asset One/Retired.pdf`)).toBe(true);
    expect(run.stats.disconnected).toBe(0);
  });
});
