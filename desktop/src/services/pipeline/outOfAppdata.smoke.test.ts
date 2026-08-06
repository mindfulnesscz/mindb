/* Smoke test: a pipeline slice against a REAL source folder outside the app data directory.
 *
 * The 3.2.1 regression was invisible to the whole existing suite. Every other pipeline test runs on
 * the in-memory `vfs` rooted at `/src`, where one path is as good as another, so nothing noticed
 * that real client folders are absolute, deeply nested, and full of spaces, parentheses and emoji —
 * `~/Library/CloudStorage/Dropbox-…/04 PROJECTS/11 M5/M5 Photos __6801071c/OUT/…`. A run against
 * that shape failed on every asset while CI stayed green.
 *
 * This runs scan → folder identity (`.dchub.json`) → thumbnail → CDN upload against a real temp
 * directory, and asserts the two failure signatures that regression produced:
 *
 *   "forbidden path" / "not allowed on the scope"  — the fs-scope denial
 *   "no folder identity"                            — S3's amplification, where one denied
 *                                                     manifest write aborted identity for the run
 *
 * ⚠ WHAT THIS CANNOT CATCH. Tauri's capability scope and `path_policy` do not exist in vitest —
 * `@tauri-apps/plugin-fs` is mocked here, so no scope is consulted. This guards the pipeline's own
 * handling of absolute out-of-appdata paths, and would have caught the identity abort. The scope
 * declaration itself is guarded separately and declaratively by `src/app/fsCapability.test.ts`, and
 * `path_policy`'s boundary by its Rust unit tests. Three narrow guards, because the real thing
 * needs a packaged build on a clean profile.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', async () => (await import('../../test/realFs')).realFs.fsApi());
vi.mock('@tauri-apps/api/path', async () => (await import('../../test/realFs')).realFs.pathApi());
vi.mock('@tauri-apps/api/core', async () => ({
  invoke: (await import('../../test/invokeStub')).invokeStub.invoke,
}));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: async () => {} }));

const { realFs } = await import('../../test/realFs');
const { invokeStub } = await import('../../test/invokeStub');
const { runPipeline } = await import('../pipelineService');
const { makeSettings, makeCtx, R2 } = await import('../../test/pipelineHarness');

/** The awkward parts of a real client path: spaces, parentheses, an em dash, an emoji, deep nesting. */
const CLIENT_TREE = '04 PROJECTS/11 M5/M5 Photos __6801071c';
const ASSET = '(DC)(M5)(Gll) Photos from Open Studios — 13.pdf';

/** Anything that reads as a denial rather than a normal per-file error. */
const DENIAL_SIGNATURES = [
  'forbidden path',
  'not allowed on the scope',
  'outside Sotto\'s approved working directories',
  'no folder identity',
];

let source = '';

beforeEach(async () => {
  invokeStub.reset();
  // Render fakes must write to the same real tree the pipeline reads, or the CDN stage that
  // follows finds no thumbnail and reports "no thumb" instead of publishing.
  invokeStub.useFsBackend(realFs.stubBackend());
  const root = realFs.make();
  source = `${root}/Dropbox-DISRUPTCOLLECTIVE/DISRUPT COLLECTIVE`;
  await realFs.tree(source, {
    [`${CLIENT_TREE}/[03] OUT/${ASSET}`]: 'deck bytes',
  });
});

afterEach(() => realFs.cleanup());

describe('pipeline against a source folder outside appdata', () => {
  it('writes identity and publishes, with no scope or identity denial', async () => {
    const settings = makeSettings({
      sourceFolder: source,
      targetFolder: `${realFs.root}/delivery`,
      doThumbnails: true,
      doCdnOriginals: true,
    });
    const run = makeCtx(settings, { r2: R2 });
    await runPipeline(run.ctx as never);

    // 1. No denial anywhere in the log — the signature of the 3.2.1 failure.
    const denials = run.logs
      .map(l => l.msg)
      .filter(msg => DENIAL_SIGNATURES.some(sig => msg.toLowerCase().includes(sig.toLowerCase())));
    expect(denials).toEqual([]);

    // 2. The identity manifest actually landed on disk, at an absolute out-of-appdata path.
    const manifest = `${source}/${CLIENT_TREE}/.dchub.json`;
    const fsApi = realFs.fsApi();
    expect(await fsApi.exists(manifest)).toBe(true);
    const identity = JSON.parse(await fsApi.readTextFile(manifest));
    expect(identity.stable_id).toBe('6801071c');

    // 3. The asset reached the CDN under that identity — the run did real work, so an empty log
    //    cannot be mistaken for success.
    expect(invokeStub.uploadedKeys()).toContain('client/client-abc/thumbnails/6801071c/c1.webp');
    expect(run.stats?.errors ?? 0).toBe(0);
  });

  it('handles emoji and punctuation in real path segments, and still honours the exclude mark',
    async () => {
      // The characters are load-bearing: `(PRD)` is glob-significant to some matchers, and the
      // emoji/em dash have broken naming and manifest round-trips before. On the in-memory tree
      // these are just string keys; here they are bytes a real filesystem has to round-trip.
      await realFs.tree(source, {
        '03 🖼️ MARKETING/FyzioBalance __ab00cd01/[03] OUT/(PRD)(SlD) Deck — v2.pdf': 'x',
        // `⦰` is the configured exclude mark — this package must NOT be picked up.
        '01 CLIENTS ⦰/Private __ab00cd02/[03] OUT/(PRD)(SlD) Secret.pdf': 'x',
      });

      const settings = makeSettings({
        sourceFolder: source,
        targetFolder: `${realFs.root}/delivery`,
        doThumbnails: true,
      });
      const run = makeCtx(settings, { r2: R2 });
      await runPipeline(run.ctx as never);

      const fsApi = realFs.fsApi();
      expect(run.logsOfType('error')).toEqual([]);
      expect(await fsApi.exists(`${source}/03 🖼️ MARKETING/FyzioBalance __ab00cd01/.dchub.json`))
        .toBe(true);
      // Excluded folders are not merely unpublished — nothing is written into them at all.
      expect(await fsApi.exists(`${source}/01 CLIENTS ⦰/Private __ab00cd02/.dchub.json`))
        .toBe(false);
      expect(invokeStub.uploadedKeys().some(k => k.includes('ab00cd02'))).toBe(false);
    });
});
