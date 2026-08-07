/* Every section-DONE line carries a duration — proven against a real run, not a mock.
 *
 * The formatter and the timeline are unit-tested in pipeline/timing.test.ts. What that cannot
 * catch is a stage whose banner was missed, or one whose timer never resolves because the
 * function returned down a path that skips `done()`. This drives `runPipeline` over the virtual
 * filesystem with every local stage on and asserts on the log it actually produced.
 *
 * It deliberately matches the SHAPE (` in <duration>`), never a number: durations are real
 * wall-clock and a test that pinned one would be flaky by construction.
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
const { makeSettings, makeCtx, SRC } = await import('../test/pipelineHarness');
const { beginRunTimeline, endRunTimeline, runTimelineSummary } = await import('./pipeline/timing');

/** `12.4s`, `640ms`, `3m 12s` — anything the formatter can emit, and nothing else. */
const DURATION = /\bin (\d+ms|\d+\.\d+s|\d+m \d+s)$/;

beforeEach(() => {
  vfs.reset();
  invokeStub.reset();
  beginRunTimeline();
});

function seed() {
  vfs.tree(SRC, {
    'Campaign/[00] 📦 Handoff/': null,
    'Campaign/Asset One __a1b2c3d4/[03] OUT/(PRD)(SlD) Deck v1.pdf': 'x',
    'Campaign/Asset Two __b2c3d4e5/[03] OUT/(ACQ)(Gll) Photo.jpg': 'y',
  });
}

describe('run timing — the log a pipeline actually produces', () => {
  it('puts a duration on every section-DONE banner', async () => {
    seed();
    const run = makeCtx(makeSettings({ doDistribute: true, doPublish: true }));
    await runPipeline(run.ctx as never);
    endRunTimeline();

    const done = run.logs.filter(l => l.type === 'section' && / DONE — /.test(l.msg));
    expect(done.length).toBeGreaterThan(0);
    for (const line of done) expect(line.msg).toMatch(DURATION);
  });

  it('reports the source scan, which has no banner of its own', async () => {
    seed();
    const run = makeCtx(makeSettings());
    await runPipeline(run.ctx as never);
    endRunTimeline();

    const scan = run.logs.find(l => l.msg.includes('Scanned'));
    expect(scan?.msg).toMatch(/^ {2}Scanned 2 asset file\(s\) in /);
    expect(scan!.msg).toMatch(DURATION);
  });

  it('leaves the banners a stopped run prints alone, and still ranks what ran', async () => {
    seed();
    const run = makeCtx(makeSettings({ doDistribute: true, doPublish: true }));
    await runPipeline(run.ctx as never);

    const summary = runTimelineSummary()!;
    endRunTimeline();
    // SOURCE SCAN plus the two enabled stages, none of them a sub-step of another.
    expect(summary.slowest.map(p => p.label)).toContain('SOURCE SCAN');
    expect(summary.slowest.map(p => p.label)).toContain('DISTRIBUTE');
    expect(summary.slowest.map(p => p.label)).toContain('PUBLISH');
    expect(summary.measuredMs).toBeLessThanOrEqual(summary.totalMs);
  });

  it('does not disturb the banner text the characterization suites assert on', async () => {
    seed();
    const run = makeCtx(makeSettings({ doDistribute: true }));
    await runPipeline(run.ctx as never);
    endRunTimeline();

    // The prefix is what other suites pin; the duration is appended after the closing rule.
    expect(run.logged('COLLECT DONE')).toBe(true);
    const banner = run.logs.find(l => l.msg.includes('COLLECT DONE'))!.msg;
    expect(banner.startsWith('━━━ COLLECT DONE — ')).toBe(true);
    expect(banner).toContain('━━━ in ');
  });
});
