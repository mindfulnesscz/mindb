/* Obsidian note patching — the DAM builder's most destructive-adjacent code.
 *
 * `patchMeta` edits notes the user writes in. Two properties matter far more than formatting:
 *
 *   1. it must PRESERVE what it does not own — prose, extra sections, manual links;
 *   2. it must report `changed: false` for a no-op, or every run rewrites every note and Obsidian
 *      and git see churn on files nobody edited.
 *
 * The `<!-- dam:key:"value" -->` comments are the ownership marker: ours to rewrite, everything else
 * the user's. `damService` had no coverage at all before this.
 */

import { describe, it, expect } from 'vitest';
import { patchMeta } from './notes';
import type { ParsedFilename } from '@sotto/domain';

const parsed = (over: Partial<ParsedFilename> = {}): ParsedFilename => ({
  tags: [], unknownTags: [], description: null, version: null, yymm: null, error: null, ...over,
});

const patch = (content: string, over: {
  p?: ParsedFilename; source?: string; thumb?: string | null; outDir?: string;
  cloudUrls?: { destId?: string; provider: string; name: string; url: string }[];
} = {}) => patchMeta(
  content,
  over.p ?? parsed(),
  over.source ?? '/src/Asset/OUT/deck.pdf',
  over.thumb ?? null,
  over.outDir ?? '/src/Asset/OUT',
  over.cloudUrls,
);

describe('patchMeta — the dam: ownership comments', () => {
  it('appends the comments it owns when they are absent', () => {
    const r = patch('# Note\n');
    expect(r.changed).toBe(true);
    expect(r.content).toContain('<!-- dam:source_path:"/src/Asset/OUT/deck.pdf" -->');
    expect(r.content).toContain('<!-- dam:file_path:"/src/Asset/OUT" -->');
  });

  it('is IDEMPOTENT — a second pass reports no change', () => {
    // The property that keeps Obsidian and git quiet. Without it every run dirties every note.
    const first = patch('# Note\n');
    const second = patch(first.content);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it('updates a comment in place rather than appending a duplicate', () => {
    const withOld = patch('# Note\n', { source: '/old/path.pdf' }).content;
    const r = patch(withOld, { source: '/new/path.pdf' });

    expect(r.changed).toBe(true);
    expect(r.content).toContain('/new/path.pdf');
    expect(r.content).not.toContain('/old/path.pdf');
    expect(r.content.match(/dam:source_path/g)).toHaveLength(1);
  });

  it('writes a version comment only when the filename carries a version', () => {
    expect(patch('# Note\n').content).not.toContain('dam:version');
    expect(patch('# Note\n', { p: parsed({ version: 'v2' }) }).content)
      .toContain('<!-- dam:version:"v2" -->');
  });

  it('leaves the user’s own prose untouched', () => {
    const user = '# Note\n\nMy own notes about this asset.\n\n## Meeting 12 Mar\nDecided X.\n';
    const r = patch(user);
    expect(r.content.startsWith(user)).toBe(true);
    expect(r.content).toContain('Decided X.');
  });
});

describe('patchMeta — the thumbnail embed', () => {
  const body = '---\nfoo: bar\n---\n\n# Note\n';

  it('inserts the embed after the frontmatter', () => {
    const r = patch(body, { thumb: 'deck-thumb.webp' });
    expect(r.changed).toBe(true);
    expect(r.content).toContain('![[10 ATTACHMENTS/deck-thumb.webp]]');
    // Placed before the heading, not appended at the end.
    expect(r.content.indexOf('![[10 ATTACHMENTS/')).toBeLessThan(r.content.indexOf('# Note'));
  });

  it('REPLACES an existing embed instead of stacking a second one', () => {
    const once = patch(body, { thumb: 'old-thumb.webp' }).content;
    const r = patch(once, { thumb: 'new-thumb.webp' });

    expect(r.content).toContain('new-thumb.webp');
    expect(r.content).not.toContain('old-thumb.webp');
    expect(r.content.match(/!\[\[10 ATTACHMENTS\//g)).toHaveLength(1);
  });

  it('is idempotent for an unchanged thumbnail', () => {
    const once = patch(body, { thumb: 'deck-thumb.webp' }).content;
    expect(patch(once, { thumb: 'deck-thumb.webp' }).changed).toBe(false);
  });

  it('adds no embed when there is no thumbnail', () => {
    expect(patch(body, { thumb: null }).content).not.toContain('10 ATTACHMENTS');
  });
});

describe('patchMeta — cloud link rows', () => {
  const table = '# Note\n\n| Field | Value |\n| --- | --- |\n| Version | v1 |\n\nAfter the table.\n';
  const link = (name: string, url: string) => [{ provider: 'dropbox', name, url }];

  it('appends a row for a destination the table does not list', () => {
    const r = patch(table, { cloudUrls: link('Dropbox', 'https://db/x') });
    expect(r.changed).toBe(true);
    expect(r.content).toContain('| Dropbox | [↗ open](https://db/x) |');
  });

  it('keeps the rest of the document intact around the table', () => {
    const r = patch(table, { cloudUrls: link('Dropbox', 'https://db/x') });
    expect(r.content).toContain('| Version | v1 |');
    expect(r.content).toContain('After the table.');
  });

  it('UPDATES an existing row rather than adding a duplicate', () => {
    const once = patch(table, { cloudUrls: link('Dropbox', 'https://db/old') }).content;
    const r = patch(once, { cloudUrls: link('Dropbox', 'https://db/new') });

    expect(r.content).toContain('https://db/new');
    expect(r.content).not.toContain('https://db/old');
    expect(r.content.match(/\| Dropbox \|/g)).toHaveLength(1);
  });

  it('is idempotent for an unchanged link', () => {
    const once = patch(table, { cloudUrls: link('Dropbox', 'https://db/x') }).content;
    expect(patch(once, { cloudUrls: link('Dropbox', 'https://db/x') }).changed).toBe(false);
  });

  it('handles several destinations at once', () => {
    const r = patch(table, {
      cloudUrls: [
        { provider: 'dropbox', name: 'Dropbox', url: 'https://db/x' },
        { provider: 'gdrive', name: 'DC Google', url: 'https://gd/y' },
      ],
    });
    expect(r.content).toContain('| Dropbox |');
    expect(r.content).toContain('| DC Google |');
  });

  it('does not let a destination name with regex characters corrupt the match', () => {
    // Destination names are user-entered: "Client (final)" or "A+B" would otherwise be compiled
    // into a pattern that matches the wrong row, or throws.
    const once = patch(table, { cloudUrls: link('Client (final)', 'https://x/1') }).content;
    expect(once).toContain('| Client (final) | [↗ open](https://x/1) |');

    const r = patch(once, { cloudUrls: link('Client (final)', 'https://x/2') });
    expect(r.content).toContain('https://x/2');
    expect(r.content.match(/\| Client \(final\) \|/g)).toHaveLength(1);
  });

  it('does nothing when the note has no table to patch', () => {
    const r = patch('# Note\n\nNo table here.\n', { cloudUrls: link('Dropbox', 'https://db/x') });
    expect(r.content).not.toContain('Dropbox');
  });

  it('does nothing when there are no links to write', () => {
    expect(patch(table, { cloudUrls: [] }).content).toBe(patch(table).content);
  });
});
