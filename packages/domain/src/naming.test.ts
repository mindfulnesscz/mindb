/* Folder-convention matching: which folders are packages, which are OUT, and which
   files the run must skip.

   These four predicates decide what the pipeline touches on disk. A false positive on
   isPackageFolder made Collect a no-op on production ("Migrated `Name __hash` folders
   are NOT packages" in the source comment); a false negative on isOutFolder makes a
   client's deliverables invisible. Both are pinned here. */

import { describe, it, expect } from 'vitest';
import {
  DEFAULTS, shouldSkipName, stripWorkflowPrefix, isPackageFolder, isOutFolder,
  isPublishableFile, isThumbFile, type NamingSettings,
} from './naming';

const s: NamingSettings = { ...DEFAULTS };

describe('shouldSkipName', () => {
  it('always skips Office lock files and [99] folders', () => {
    expect(shouldSkipName('~$Deck.pptx', s)).toBe(true);
    expect(shouldSkipName('[99] Archive', s)).toBe(true);
  });

  it('skips anything carrying the exclude mark', () => {
    expect(shouldSkipName('⦰ Draft', s)).toBe(true);
    expect(shouldSkipName('Draft ⦰', s)).toBe(true);   // position does not matter
    expect(shouldSkipName('Deck', s)).toBe(false);
  });

  it('is opt-out — an unmarked name is always in scope', () => {
    // Exclusion is the ONLY filtering mode. There is no marker a folder must carry to be
    // picked up, so nothing is skipped for lacking one. (An opt-in "whitelist" mode once
    // existed and was removed: it required every directory on the path to be marked, which
    // the OUT folder could not be, so it collected nothing. Any folder still carrying that
    // retired marker is now treated as an ordinary name.)
    expect(shouldSkipName('Anything At All', s)).toBe(false);
    expect(shouldSkipName('★ Prefixed With A Symbol', s)).toBe(false);
  });

  it('with no exclude mark configured, skips EVERY name', () => {
    // `includes('')` is true for any string. The pipeline's own copy of this guard is
    // `s.excludeMark ? ... : false`; the domain version has no such guard. Locked as a
    // known divergence — do not "fix" one without the other.
    expect(shouldSkipName('Deck', { ...s, excludeMark: '' })).toBe(true);
  });
});

describe('stripWorkflowPrefix', () => {
  it('removes a [NN] prefix and surrounding whitespace', () => {
    expect(stripWorkflowPrefix('[03] OUT')).toBe('OUT');
    expect(stripWorkflowPrefix('[00] 📦 Deliverables')).toBe('📦 Deliverables');
    expect(stripWorkflowPrefix('[3]OUT')).toBe('OUT');
  });

  it('leaves an unprefixed name alone', () => {
    expect(stripWorkflowPrefix('OUT')).toBe('OUT');
    expect(stripWorkflowPrefix('📦 Deliverables')).toBe('📦 Deliverables');
  });

  it('only strips a leading numeric bracket, not any bracket', () => {
    expect(stripWorkflowPrefix('[draft] OUT')).toBe('[draft] OUT');
  });
});

describe('isPackageFolder', () => {
  it('matches the configured prefix exactly', () => {
    expect(isPackageFolder('[00] 📦 Client Handoff', s)).toBe(true);
  });

  it('matches a migrated folder that dropped the [00] while settings kept it', () => {
    // The tolerance that matters: settings say "[00] 📦" but disk says "📦 Name".
    expect(isPackageFolder('📦 Client Handoff', s)).toBe(true);
  });

  it('matches when settings store the bare emoji but disk kept [00]', () => {
    const bare: NamingSettings = { ...s, packagePrefix: '📦' };
    expect(isPackageFolder('[00] 📦 Client Handoff', bare)).toBe(true);
    expect(isPackageFolder('📦 Client Handoff', bare)).toBe(true);
  });

  it('does NOT treat a stable-id asset folder as a package', () => {
    // This exact false positive made Collect a no-op on production: identity folders
    // are assets to harvest OUT *from*, never package anchors to fill.
    expect(isPackageFolder('Deda Energie __e0b29f18', s)).toBe(false);
    expect(isPackageFolder('Product Launch', s)).toBe(false);
    expect(isPackageFolder('[03] OUT', s)).toBe(false);
  });

  it('never matches when no prefix is configured', () => {
    // Guards against an empty prefix making startsWith('') true for every folder,
    // which would turn the entire source tree into package anchors.
    expect(isPackageFolder('Anything', { ...s, packagePrefix: '' })).toBe(false);
    expect(isPackageFolder('Anything', { ...s, packagePrefix: '   ' })).toBe(false);
  });

  it('requires the marker at the start, not anywhere in the name', () => {
    expect(isPackageFolder('Old 📦 Handoff', s)).toBe(false);
  });
});

describe('isOutFolder', () => {
  it('matches the configured OUT name with or without its [NN] prefix', () => {
    expect(isOutFolder('[03] OUT', s)).toBe(true);
    expect(isOutFolder('OUT', s)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isOutFolder('out', s)).toBe(true);
    expect(isOutFolder('[03] Out', s)).toBe(true);
  });

  it('always accepts a plain "OUT" even when settings name something else', () => {
    // `got === want || got === 'out'` — the literal 'out' fallback is unconditional, so
    // a client who renamed OUT to "DELIVERY" still has stray "out" folders harvested.
    // Deliberate tolerance for half-migrated trees; pinned so it is a choice, not a surprise.
    const renamed: NamingSettings = { ...s, outFolder: '[03] DELIVERY' };
    expect(isOutFolder('DELIVERY', renamed)).toBe(true);
    expect(isOutFolder('OUT', renamed)).toBe(true);
  });

  it('falls back to OUT when the setting is empty', () => {
    expect(isOutFolder('OUT', { ...s, outFolder: '' })).toBe(true);
  });

  it('rejects folders that merely contain OUT', () => {
    expect(isOutFolder('OUTTAKES', s)).toBe(false);
    expect(isOutFolder('Checkout', s)).toBe(false);
  });
});

describe('isPublishableFile', () => {
  it('requires an extension and rejects dotfiles', () => {
    expect(isPublishableFile('Deck.pdf')).toBe(true);
    expect(isPublishableFile('Deck')).toBe(false);
    expect(isPublishableFile('.DS_Store')).toBe(false);
    expect(isPublishableFile('.gitkeep')).toBe(false);
  });

  it('accepts a name whose only dot is not leading', () => {
    expect(isPublishableFile('a.b.pdf')).toBe(true);
  });
});

describe('isThumbFile', () => {
  it('detects the -thumb marker anywhere in the stem', () => {
    expect(isThumbFile('Deck-thumb')).toBe(true);
    expect(isThumbFile('Deck-thumb.webp')).toBe(true);
    expect(isThumbFile('Deck')).toBe(false);
    expect(isThumbFile('thumbnail')).toBe(false);   // needs the hyphen
  });
});
