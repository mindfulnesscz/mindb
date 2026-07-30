/* Version parsing and highest-version filtering.

   This is the module that decides which file ships. `filterHighestVersions` gates the
   package mirror, the OUT publish and the CDN upload — a wrong answer here either
   publishes a stale deliverable to a client or drops a current one. Git history shows
   three separate fixes in this area ("apply highest-version filter to OUT publish",
   "package export reads highest version from OUT", "apply highest-version filtering to
   package export"), so the behaviour is pinned here rather than re-derived each time. */

import { describe, it, expect } from 'vitest';
import { parseVersion, compareVersions, filterHighestVersions } from './version';

describe('parseVersion', () => {
  it('reads a trailing v-number and splits off the extension', () => {
    expect(parseVersion('(PRD)(SlD) Deck v2.pdf')).toEqual({
      base: '(PRD)(SlD) Deck', ext: '.pdf', version: [2, 0, 0],
    });
  });

  it('accepts dot and dash as the separator, and either case of v', () => {
    expect(parseVersion('Deck v1.2.3.pdf')?.version).toEqual([1, 2, 3]);
    expect(parseVersion('Deck v1-2-3.pdf')?.version).toEqual([1, 2, 3]);
    expect(parseVersion('Deck V1-2.pdf')?.version).toEqual([1, 2, 0]);
    // Mixed separators are tolerated — real folders contain both.
    expect(parseVersion('Deck v1.2-3.pdf')?.version).toEqual([1, 2, 3]);
  });

  it('strips trailing separators from the base so v1 and v1-0-0 group together', () => {
    expect(parseVersion('Deck v1.pdf')?.base).toBe('Deck');
    expect(parseVersion('Deck_v1.pdf')?.base).toBe('Deck');
    expect(parseVersion('Deck-v1.pdf')?.base).toBe('Deck');
  });

  it('returns null when there is no trailing version', () => {
    expect(parseVersion('Deck.pdf')).toBeNull();
    expect(parseVersion('v2 Deck.pdf')).toBeNull();       // must be at the END of the stem
    expect(parseVersion('Deck v2 final.pdf')).toBeNull();
  });

  it('treats a long or non-alphanumeric trailing dot-part as part of the name, not an extension', () => {
    // EXT_RE only accepts 1–8 alphanumerics, so "Deck v1.something-long" keeps its tail
    // in the stem — and then the version is no longer trailing, so it does not parse.
    expect(parseVersion('Deck v1.superlongext')).toBeNull();
  });

  it('consumes a dotted version as an extension rather than a version', () => {
    // "Deck.v2" → ".v2" matches EXT_RE, so it is split off as the extension and the
    // remaining stem "Deck" has no trailing version. Versions must be space/dash/
    // underscore separated ("Deck v2.pdf"), never dot-separated from the name.
    expect(parseVersion('Deck.v2')).toBeNull();
  });

  it('handles a versioned file with no extension', () => {
    expect(parseVersion('Deck v3')).toEqual({ base: 'Deck', ext: '', version: [3, 0, 0] });
  });

  it('reads multi-digit components', () => {
    expect(parseVersion('Deck v10-20-30.pdf')?.version).toEqual([10, 20, 30]);
  });
});

describe('compareVersions', () => {
  it('orders major, then minor, then patch', () => {
    expect(compareVersions([2, 0, 0], [1, 9, 9])).toBeGreaterThan(0);
    expect(compareVersions([1, 2, 0], [1, 1, 9])).toBeGreaterThan(0);
    expect(compareVersions([1, 1, 2], [1, 1, 1])).toBeGreaterThan(0);
    expect(compareVersions([1, 1, 1], [1, 1, 1])).toBe(0);
    expect(compareVersions([1, 0, 0], [2, 0, 0])).toBeLessThan(0);
  });

  it('compares numerically, not lexically (v10 > v9)', () => {
    expect(compareVersions([10, 0, 0], [9, 0, 0])).toBeGreaterThan(0);
  });
});

describe('filterHighestVersions', () => {
  it('keeps only the highest version of each base+ext', () => {
    const kept = filterHighestVersions(['Deck v1.pdf', 'Deck v2.pdf', 'Deck v3.pdf']);
    expect(kept).toEqual(['Deck v3.pdf']);
  });

  it('keeps v10 over v9 — the bug a lexical sort would produce', () => {
    expect(filterHighestVersions(['Deck v9.pdf', 'Deck v10.pdf'])).toEqual(['Deck v10.pdf']);
  });

  it('treats different extensions as different deliverables', () => {
    const kept = filterHighestVersions(['Deck v1.pdf', 'Deck v2.pptx']);
    expect(new Set(kept)).toEqual(new Set(['Deck v1.pdf', 'Deck v2.pptx']));
  });

  it('groups case-insensitively on base and ext', () => {
    // "deck v1.PDF" and "Deck v2.pdf" are the same deliverable; only the newer ships.
    expect(filterHighestVersions(['deck v1.PDF', 'Deck v2.pdf'])).toEqual(['Deck v2.pdf']);
  });

  it('always keeps unversioned files — they are not competing with anything', () => {
    const kept = filterHighestVersions(['README.md', 'Deck v1.pdf', 'Deck v2.pdf']);
    expect(new Set(kept)).toEqual(new Set(['README.md', 'Deck v2.pdf']));
  });

  it('does NOT treat an unversioned file as a rival of its versioned siblings', () => {
    // "Deck.pdf" alongside "Deck v2.pdf" yields both — the unversioned one is passed
    // through untouched rather than being ranked as v0.
    const kept = filterHighestVersions(['Deck.pdf', 'Deck v2.pdf']);
    expect(new Set(kept)).toEqual(new Set(['Deck.pdf', 'Deck v2.pdf']));
  });

  it('returns unversioned files first, then one winner per group', () => {
    // Order is [...unversioned, ...winners] — callers that care about ordering must
    // sort themselves. Documented because the pipeline logs surface this order.
    expect(filterHighestVersions(['A v1.pdf', 'B.md', 'A v2.pdf'])).toEqual(['B.md', 'A v2.pdf']);
  });

  it('passes through the trivial cases untouched', () => {
    expect(filterHighestVersions([])).toEqual([]);
    expect(filterHighestVersions(['only.pdf'])).toEqual(['only.pdf']);
  });

  it('picks a winner deterministically when two names tie on version', () => {
    // "Deck v1.pdf" and "Deck_v1.pdf" both reduce to base "Deck" + [1,0,0]. The
    // comparison is strictly greater-than, so the FIRST one seen wins.
    expect(filterHighestVersions(['Deck v1.pdf', 'Deck_v1.pdf'])).toEqual(['Deck v1.pdf']);
    expect(filterHighestVersions(['Deck_v1.pdf', 'Deck v1.pdf'])).toEqual(['Deck_v1.pdf']);
  });
});
