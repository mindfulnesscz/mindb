/* readme.md — the Obsidian-facing mirror of the DB.
 *
 * Two properties matter more than the markdown itself, and both exist for the same reason: these
 * files sit in the client's SYNCED Dropbox source tree, one per package folder.
 *
 *   the content must be DETERMINISTIC — it used to carry a `_Last synced: <now>_` line, so every
 *   run produced different bytes for identical data and rewrote every readme in the tree;
 *
 *   an unchanged readme must not be WRITTEN — otherwise the deterministic content buys nothing and
 *   Dropbox still re-uploads hundreds of tiny files after every run.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { VocabTag } from '@sotto/domain';

const files = new Map<string, string>();
const writeSpy = vi.fn(async (p: string, c: string) => { files.set(p, c); });
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: async (p: string) => {
    const found = files.get(p);
    if (found === undefined) throw new Error(`no such file or directory (os error 2): ${p}`);
    return found;
  },
  writeTextFile: (p: string, c: string) => writeSpy(p, c),
}));

const { buildReadme, writeReadme, README_FILENAME } = await import('./readmeService');
type ReadmeInput = Parameters<typeof buildReadme>[0];

const DIR  = '/src/Asset __a1000001';
const PATH = `${DIR}/${README_FILENAME}`;

const tag = (label: string): VocabTag =>
  ({ shortcode: label.slice(0, 3), slot: 'entity', parentGroup: null, label, key: label.toLowerCase(), icon: '' });

const input = (over: Partial<ReadmeInput> = {}): ReadmeInput => ({
  name: 'Deck', stableId: 'a1000001', status: 'published', version: '1-0-0', perm: 'client',
  tags: [tag('Product')],
  stats: { downloads: 3, views: 12, avgRating: 4.5, ratingCount: 2, commentCount: 1 },
  ...over,
});

beforeEach(() => {
  files.clear();
  writeSpy.mockClear();
});

describe('buildReadme', () => {
  it('is a pure function of its input — no wall clock in the output', () => {
    const first = buildReadme(input());
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2031-04-05T06:07:08.000Z'));
    const second = buildReadme(input());
    vi.useRealTimers();

    expect(second).toBe(first);
    expect(first).not.toMatch(/Last synced/);
    // Nothing that could carry a date, in any format — an ISO stamp is only the way it happened
    // to leak last time.
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('still reports the row it was given', () => {
    const md = buildReadme(input());
    expect(md).toContain('# Deck');
    expect(md).toContain('**Status:** published · **Version:** 1-0-0 · **Permission:** client');
    expect(md).toContain('`a1000001`');
    expect(md).toContain('- Views: 12');
    expect(md).toContain('- Rating: 4.5 (2 ratings)');
  });
});

describe('writeReadme', () => {
  it('writes when the file is missing', async () => {
    expect(await writeReadme(DIR, input())).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(files.get(PATH)).toBe(buildReadme(input()));
  });

  it('writes nothing on a second pass over unchanged data', async () => {
    await writeReadme(DIR, input());
    writeSpy.mockClear();

    expect(await writeReadme(DIR, input())).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('writes when a stat changes, and only then', async () => {
    await writeReadme(DIR, input());
    writeSpy.mockClear();

    expect(await writeReadme(DIR, input({
      stats: { downloads: 3, views: 13, avgRating: 4.5, ratingCount: 2, commentCount: 1 },
    }))).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(files.get(PATH)).toContain('- Views: 13');

    // ...and the new contents are themselves now the skip baseline.
    writeSpy.mockClear();
    expect(await writeReadme(DIR, input({
      stats: { downloads: 3, views: 13, avgRating: 4.5, ratingCount: 2, commentCount: 1 },
    }))).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('heals a file a teammate edited or emptied — disk is the truth, not a cache', async () => {
    await writeReadme(DIR, input());
    files.set(PATH, 'someone typed here');
    writeSpy.mockClear();

    expect(await writeReadme(DIR, input())).toBe(true);
    expect(files.get(PATH)).toBe(buildReadme(input()));

    files.delete(PATH);
    expect(await writeReadme(DIR, input())).toBe(true);
  });
});
