/* The early version-history walk.
 *
 * `scanVersionMap` is a second full pass over the source tree — it reads the `versions/` subtrees the
 * main scan deliberately skips — and it used to run AFTER every network sync had finished, with the
 * run waiting on it while nothing else happened. It now starts right after the source scan and is
 * awaited where its result is consumed.
 *
 * Three things have to hold for that to be safe, and each has a test here:
 *   - the walk is DISPATCHED before the stages that are supposed to pay for it;
 *   - a run with no portal never starts it (it would be a whole extra walk, thrown away);
 *   - a failure is CARRIED to the consumer, not left on a promise nobody is awaiting yet — the
 *     consumer is minutes away, and an unhandled rejection would replace the one log line the
 *     failure is meant to produce.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', async () => (await import('../test/vfs')).vfs.fsApi());
vi.mock('@tauri-apps/api/path', async () => (await import('../test/vfs')).vfs.pathApi());
vi.mock('@tauri-apps/api/core', async () => ({
  invoke: (await import('../test/invokeStub')).invokeStub.invoke,
}));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: async () => {} }));

/* Every read the walk makes goes through `listDir`, which swallows IO errors by design, so a
   rejection cannot be provoked through the filesystem — only by a bug inside the walk itself. This
   flag stands in for that bug, because the handling is what matters: a rejection nobody is awaiting
   yet must not escape as an unhandled rejection. */
let failVersionScan = false;
vi.mock('./pipeline/scan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pipeline/scan')>();
  return {
    ...actual,
    scanVersionMap: (...args: Parameters<typeof actual.scanVersionMap>) =>
      failVersionScan
        ? Promise.reject(new Error('version walk blew up'))
        : actual.scanVersionMap(...args),
  };
});

const { vfs } = await import('../test/vfs');
const { invokeStub } = await import('../test/invokeStub');
const { runPipeline, scanVersionMap } = await import('./pipelineService');
const { makeSettings, makeCtx, VOCAB, SRC } = await import('../test/pipelineHarness');
import type { VersionScanResult } from './pipeline/types';

/** One asset with a current deliverable and one superseded copy filed under versions/. */
function seedWithHistory() {
  vfs.tree(SRC, {
    'Asset One __a1b2c3d4/[03] OUT/(PRD)(SlD) Deck v2.pdf': '',
    'Asset One __a1b2c3d4/[03] OUT/versions/(PRD)(SlD) Deck v1.pdf': '',
  });
}

beforeEach(() => {
  vfs.reset();
  invokeStub.reset();
  failVersionScan = false;
});

describe('the early version-history walk', () => {
  it('produces exactly what walking it at the end produced', async () => {
    seedWithHistory();
    const settings = makeSettings();
    const run = makeCtx(settings, { earlyVersionScan: true });

    await runPipeline(run.ctx as never);
    const scanned = (await (run.ctx.versionScan as Promise<VersionScanResult>)) as
      Extract<VersionScanResult, { map: unknown }>;
    const directly = await scanVersionMap(SRC, VOCAB, settings);

    expect([...scanned.map.keys()]).toEqual([...directly.keys()]);
    // Keyed by folder identity, never by name — and the versions/ subtree is what it is here for.
    const [key] = [...directly.keys()];
    expect(key).toBe('a1b2c3d4:(PRD)(SlD) Deck');
    expect(scanned.map.get(key)?.current?.version).toBe('v2');
    expect(scanned.map.get(key)?.history.map(h => h.version)).toEqual(['v1']);
    // The walk's own duration travels with it, so the consumer can report it next to its ~0ms wait.
    expect(scanned.took).toMatch(/\d/);
  });

  it('is already in flight before the stages that are meant to pay for it', async () => {
    // The whole point: the walk overlaps the publish/CDN stages rather than following them.
    seedWithHistory();
    const settings = makeSettings({ doPublish: true });
    const run = makeCtx(settings, { earlyVersionScan: true });
    let scanAtPublish: unknown = 'never published';
    const capture = run.ctx.appendLog as (type: string, message: string) => void;
    run.ctx.appendLog = (type: string, message: string) => {
      capture(type, message);
      if (message.includes('PUBLISHING')) scanAtPublish = run.ctx.versionScan;
    };

    await runPipeline(run.ctx as never);

    expect(scanAtPublish).toBeInstanceOf(Promise);
  });

  it('never starts for a run whose portal sync will not read it', async () => {
    seedWithHistory();
    const run = makeCtx(makeSettings());

    await runPipeline(run.ctx as never);

    expect(run.ctx.versionScan).toBeUndefined();
  });

  it('carries a failed walk to its consumer instead of rejecting into nowhere', async () => {
    seedWithHistory();
    failVersionScan = true;
    const run = makeCtx(makeSettings(), { earlyVersionScan: true });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await runPipeline(run.ctx as never);
      // The consumer is minutes of network sync away; nothing must have complained in between.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();

      const settled = await (run.ctx.versionScan as Promise<VersionScanResult>);
      expect('error' in settled).toBe(true);
      expect(String((settled as { error: unknown }).error)).toContain('version walk blew up');
      // The pipeline itself is unaffected — the failure belongs to the portal sync that reads it.
      expect(run.stats?.errors ?? 0).toBe(0);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
