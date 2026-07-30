/* Folder-based stable identity — the permanent match key every sync, CDN key and
   rename path depends on. The suffix format is a published contract: change it and
   every already-published R2 object key and every DB row stops matching its folder.
   These tests exist to make that contract expensive to break by accident. */

import { describe, it, expect } from 'vitest';
import {
  ID_SUFFIX_PATTERN, hasStableId, extractStableId, stripStableId,
  appendStableId, generateStableId,
} from './stableId';

describe('ID_SUFFIX_PATTERN', () => {
  it('accepts exactly " __" + 8 lowercase hex at the end', () => {
    expect(hasStableId('Product Launch __a1b2c3d4')).toBe(true);
    expect(hasStableId('__a1b2c3d4')).toBe(false);          // needs the leading space
    expect(hasStableId('Name _a1b2c3d4')).toBe(false);       // single underscore
    expect(hasStableId('Name __a1b2c3d')).toBe(false);       // 7 chars
    expect(hasStableId('Name __a1b2c3d4e')).toBe(false);     // 9 chars
    expect(hasStableId('Name __A1B2C3D4')).toBe(false);      // uppercase is not our format
    expect(hasStableId('Name __g1b2c3d4')).toBe(false);      // g is not hex
  });

  it('only matches at the end — a suffix mid-name is not an identity', () => {
    expect(hasStableId('Name __a1b2c3d4 (copy)')).toBe(false);
    expect(hasStableId('Name __a1b2c3d4/OUT')).toBe(false);
  });

  it('is not sticky across calls (no /g flag — .test() would alternate)', () => {
    // A /g regex reused with .test() advances lastIndex and returns false every
    // other call. Guard against that being reintroduced.
    const name = 'Name __a1b2c3d4';
    expect(ID_SUFFIX_PATTERN.test(name)).toBe(true);
    expect(ID_SUFFIX_PATTERN.test(name)).toBe(true);
    expect(ID_SUFFIX_PATTERN.test(name)).toBe(true);
  });
});

describe('extractStableId', () => {
  it('returns the bare hash, without the separator', () => {
    expect(extractStableId('Deda Energie __e0b29f18')).toBe('e0b29f18');
  });

  it('returns null when there is no identity', () => {
    expect(extractStableId('Deda Energie')).toBeNull();
    expect(extractStableId('')).toBeNull();
  });
});

describe('stripStableId', () => {
  it('removes the suffix and the space before it', () => {
    expect(stripStableId('Product Launch __a1b2c3d4')).toBe('Product Launch');
  });

  it('leaves a name without an identity untouched', () => {
    expect(stripStableId('Product Launch')).toBe('Product Launch');
  });

  it('removes only the trailing identity, not an earlier lookalike', () => {
    expect(stripStableId('__deadbeef __a1b2c3d4')).toBe('__deadbeef');
  });
});

describe('appendStableId', () => {
  it('appends the suffix', () => {
    expect(appendStableId('Product Launch', 'a1b2c3d4')).toBe('Product Launch __a1b2c3d4');
  });

  it('is idempotent — re-stamping replaces rather than stacking', () => {
    // The migration and the Vocabulary "create folder" flow both call this on names
    // that may already carry an id; stacking would produce an unmatchable folder.
    const once = appendStableId('Product Launch', 'a1b2c3d4');
    expect(appendStableId(once, 'a1b2c3d4')).toBe(once);
    expect(appendStableId(once, 'ffff0000')).toBe('Product Launch __ffff0000');
  });
});

describe('generateStableId', () => {
  it('produces a value its own pattern accepts', () => {
    const hash = generateStableId(new Set());
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(hasStableId(`Name __${hash}`)).toBe(true);
  });

  it('never returns a hash already taken, and records the one it hands out', () => {
    // `taken` is the caller's set of ids already in use for this client; the function
    // mutates it so a loop generating N ids cannot collide with itself.
    const taken = new Set<string>();
    const generated = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const hash = generateStableId(taken);
      expect(generated.has(hash)).toBe(false);
      generated.add(hash);
      expect(taken.has(hash)).toBe(true);
    }
    expect(taken.size).toBe(200);
  });

  it('skips a hash that is already taken', () => {
    // Exhaust the space down to one free value: with 4 bits of entropy... not
    // feasible, so assert the contract directly by pre-taking a produced value.
    const first = generateStableId(new Set());
    const taken = new Set([first]);
    const second = generateStableId(taken);
    expect(second).not.toBe(first);
    expect(taken).toEqual(new Set([first, second]));
  });
});
