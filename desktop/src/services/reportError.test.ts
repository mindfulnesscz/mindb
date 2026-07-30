/* The reporting seam.
 *
 * Two properties are worth more than the logging itself:
 *
 *   the trail must be BOUNDED — it is appended to on every stage heading of every run, for the life of
 *   the process, so an unbounded array is a slow leak in a long-lived desktop app;
 *
 *   reporting must never throw — nearly every caller is a `.catch()` on a fire-and-forget write, so a
 *   failure here would replace the error being reported with a less useful one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/* The sink is mocked at the plugin boundary rather than skipped. It swallows its own failures by
   design, so without these tests a packaged build could silently never write the log — and a log you
   believe in but that does not exist is worse than no log at all. */
const files = new Map<string, string>();
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/app-data',
  join: async (...parts: string[]) => parts.join('/'),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists:        async (p: string) => files.has(p),
  readTextFile:  async (p: string) => files.get(p) ?? '',
  writeTextFile: async (p: string, c: string) => { files.set(p, c); },
}));

const { addBreadcrumb, recentBreadcrumbs, clearBreadcrumbs, formatEntry, reportError, toMessage } =
  await import('./reportError');

const LOG = '/app-data/errors.log';
const log = () => files.get(LOG) ?? '';

// Held as a spy handle rather than asserted through `console.error`: the no-console gate is what keeps
// raw console calls out of the codebase, and a test should not need it relaxed.
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearBreadcrumbs();
  files.clear();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('breadcrumbs', () => {
  it('keeps the trail in order, oldest first', () => {
    addBreadcrumb('COLLECTING');
    addBreadcrumb('THUMBNAILS');
    expect(recentBreadcrumbs()).toEqual(['COLLECTING', 'THUMBNAILS']);
  });

  it('strips the log’s box-drawing decoration', () => {
    // Stage headings arrive as "━━━ CDN UPLOAD ━━━"; the rules are for the UI, not for a log line.
    addBreadcrumb('━━━ CDN UPLOAD ━━━');
    expect(recentBreadcrumbs()).toEqual(['CDN UPLOAD']);
  });

  it('collapses whitespace so a wrapped heading stays one crumb', () => {
    addBreadcrumb('  SUPABASE   EXPORT  ');
    expect(recentBreadcrumbs()).toEqual(['SUPABASE EXPORT']);
  });

  it('ignores a note with nothing in it', () => {
    addBreadcrumb('━━━');
    addBreadcrumb('   ');
    expect(recentBreadcrumbs()).toEqual([]);
  });

  it('is BOUNDED — an all-day session cannot grow it without limit', () => {
    for (let i = 0; i < 500; i++) addBreadcrumb(`stage ${i}`);
    const trail = recentBreadcrumbs();
    expect(trail.length).toBeLessThanOrEqual(12);
    // And it keeps the RECENT end: the stage that was running is the one that matters.
    expect(trail.at(-1)).toBe('stage 499');
  });

  it('hands back a copy, so a caller cannot mutate the trail', () => {
    addBreadcrumb('COLLECTING');
    recentBreadcrumbs().push('forged');
    expect(recentBreadcrumbs()).toEqual(['COLLECTING']);
  });
});

describe('formatEntry', () => {
  const at = new Date('2026-07-30T10:20:30.000Z');

  it('leads with a sortable timestamp and the context', () => {
    expect(formatEntry('pipeline.cdn', 'Storage grant refused', at))
      .toBe('2026-07-30T10:20:30.000Z [pipeline.cdn] Storage grant refused\n');
  });

  it('attaches the trail, which is what makes the message diagnosable', () => {
    addBreadcrumb('COLLECTING');
    addBreadcrumb('CDN UPLOAD');
    expect(formatEntry('pipeline.cdn', 'Storage grant refused', at))
      .toContain('| after: COLLECTING → CDN UPLOAD');
  });

  it('omits the trail section entirely when there is none', () => {
    expect(formatEntry('startup', 'boom', at)).not.toContain('after:');
  });

  it('ends with exactly one newline, so the log stays one entry per line', () => {
    addBreadcrumb('COLLECTING');
    const entry = formatEntry('x', 'y', at);
    expect(entry.endsWith('\n')).toBe(true);
    expect(entry.trimEnd()).not.toContain('\n');
  });
});

describe('reportError', () => {
  it('does not throw when the file sink is unavailable', () => {
    // This is the case in every test and in a browser preview: the Tauri plugins reject. A caller in a
    // `.catch()` must not receive a second, less useful error.
    expect(() => reportError('ctx', new Error('original failure'))).not.toThrow();
  });

  it('returns synchronously — callers never await it', () => {
    expect(reportError('ctx', new Error('x'))).toBeUndefined();
  });

  it('logs the normalised message together with the raw error', () => {
    const err = new Error('original failure');
    reportError('pipeline.cdn', err);
    expect(errorSpy).toHaveBeenCalledWith('[pipeline.cdn] original failure', err);
  });
});

describe('the log file', () => {
  it('writes the entry to errors.log in the app data directory', async () => {
    reportError('pipeline.cdn', new Error('Storage grant refused'));

    await vi.waitFor(() => expect(log()).toContain('Storage grant refused'));
    expect(log()).toContain('[pipeline.cdn]');
    expect(log().endsWith('\n')).toBe(true);
  });

  it('APPENDS rather than replacing — the previous errors are the context', async () => {
    reportError('first', new Error('one'));
    await vi.waitFor(() => expect(log()).toContain('one'));
    reportError('second', new Error('two'));
    await vi.waitFor(() => expect(log()).toContain('two'));

    expect(log().trimEnd().split('\n')).toHaveLength(2);
    expect(log()).toContain('one');
  });

  it('carries the breadcrumb trail into the file, not just the console', async () => {
    addBreadcrumb('━━━ CDN UPLOAD ━━━');
    reportError('pipeline.cdn', new Error('boom'));

    await vi.waitFor(() => expect(log()).toContain('after: CDN UPLOAD'));
  });

  it('TRUNCATES instead of growing without bound', async () => {
    // A machine that runs the pipeline daily would otherwise accumulate a file nobody can open.
    files.set(LOG, `${'x'.repeat(300_000)}\nkeep-me\n`);
    reportError('ctx', new Error('newest'));

    await vi.waitFor(() => expect(log()).toContain('newest'));
    expect(log().length).toBeLessThan(200_000);
  });

  it('leaves the truncated file starting at a whole entry', async () => {
    // Half a line at the top would make the log unparseable by anything that reads it line by line.
    files.set(LOG, `${'x'.repeat(300_000)}\nsecond-line\nthird-line\n`);
    reportError('ctx', new Error('newest'));

    await vi.waitFor(() => expect(log()).toContain('newest'));
    expect(log().startsWith('x')).toBe(false);
  });
});

describe('toMessage', () => {
  it('reads a real Error', () => {
    expect(toMessage(new Error('boom'))).toBe('boom');
  });

  it('reads a Supabase REST error, which String() would render "[object Object]"', () => {
    expect(toMessage({ message: 'permission denied for table assets' }))
      .toBe('permission denied for table assets');
  });

  it('falls back to String for anything else', () => {
    expect(toMessage('plain string')).toBe('plain string');
    expect(toMessage(404)).toBe('404');
    expect(toMessage(null)).toBe('null');
    expect(toMessage(undefined)).toBe('undefined');
  });

  it('does not mistake a non-string message for one', () => {
    expect(toMessage({ message: { nested: true } })).toBe('[object Object]');
  });
});
