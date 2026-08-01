/* Vocabulary/taxonomy helpers — the shortcode string the Generator produces and the
   Obsidian tag list the DAM export writes. Both are user-visible output formats. */

import { describe, it, expect } from 'vitest';
import {
  SLOT_LABELS, dimensionLabelForSlot, parentGroupsForSlot,
  buildFilenameCode, buildObsidianTags,
  type VocabTag, type VocabParentGroup,
} from './vocabulary';

const tag = (over: Partial<VocabTag> & Pick<VocabTag, 'shortcode' | 'slot'>): VocabTag => ({
  parentGroup: null, label: over.shortcode, key: over.shortcode.toLowerCase(), icon: '', ...over,
});

const noVersion = { major: '', minor: '', patch: '' };

describe('dimensionLabelForSlot', () => {
  it('prefers the client override', () => {
    const client = { dimensionLabels: { entity: 'Brand', angle: 'Angle', format: 'Format' } };
    expect(dimensionLabelForSlot(client, 'entity')).toBe('Brand');
  });

  it('falls back to the default label when absent, blank, or whitespace-only', () => {
    expect(dimensionLabelForSlot(null, 'entity')).toBe(SLOT_LABELS.entity);
    expect(dimensionLabelForSlot(undefined, 'angle')).toBe(SLOT_LABELS.angle);
    expect(dimensionLabelForSlot({}, 'format')).toBe(SLOT_LABELS.format);
    expect(dimensionLabelForSlot({ dimensionLabels: { entity: '   ' } }, 'entity')).toBe(SLOT_LABELS.entity);
  });

  it('trims a real override', () => {
    expect(dimensionLabelForSlot({ dimensionLabels: { entity: '  Brand  ' } }, 'entity')).toBe('Brand');
  });
});

describe('parentGroupsForSlot', () => {
  const groups: VocabParentGroup[] = [
    { name: 'Products', key: 'products', slot: 'entity' },
    { name: 'People',   key: 'people',   slot: 'entity' },
    { name: 'Decks',    key: 'decks',    slot: 'format' },
  ];

  it('lists portal groups for the slot, in portal order', () => {
    expect(parentGroupsForSlot([], 'entity', groups)).toEqual(['Products', 'People']);
  });

  it('ignores groups belonging to another slot', () => {
    expect(parentGroupsForSlot([], 'format', groups)).toEqual(['Decks']);
  });

  it('adds leaf-only groups after the portal ones', () => {
    const tags = [tag({ shortcode: 'ACQ', slot: 'entity', parentGroup: 'Campaigns' })];
    expect(parentGroupsForSlot(tags, 'entity', groups)).toEqual(['Products', 'People', 'Campaigns']);
  });

  it('does not duplicate a group that exists both in the portal and on a leaf', () => {
    const tags = [tag({ shortcode: 'PRD', slot: 'entity', parentGroup: 'Products' })];
    expect(parentGroupsForSlot(tags, 'entity', groups)).toEqual(['Products', 'People']);
  });

  it('appends "Ungrouped" last, and only when an ungrouped leaf exists', () => {
    const withOrphan = [tag({ shortcode: 'PRD', slot: 'entity', parentGroup: null })];
    expect(parentGroupsForSlot(withOrphan, 'entity', groups)).toEqual(['Products', 'People', 'Ungrouped']);
    expect(parentGroupsForSlot([], 'entity', groups)).not.toContain('Ungrouped');
  });

  it('adds "Ungrouped" once no matter how many orphans there are', () => {
    const orphans = [
      tag({ shortcode: 'A', slot: 'entity' }),
      tag({ shortcode: 'B', slot: 'entity' }),
    ];
    expect(parentGroupsForSlot(orphans, 'entity')).toEqual(['Ungrouped']);
  });

  it('works with no portal groups at all', () => {
    expect(parentGroupsForSlot([], 'entity')).toEqual([]);
  });
});

describe('buildFilenameCode', () => {
  const selected = [
    tag({ shortcode: 'PRD', slot: 'entity' }),
    tag({ shortcode: 'OVR', slot: 'angle' }),
    tag({ shortcode: 'SlD', slot: 'format' }),
  ];

  it('wraps each shortcode in parentheses, in the given order', () => {
    expect(buildFilenameCode(selected, '', noVersion)).toBe('(PRD)(OVR)(SlD)');
  });

  it('appends a trimmed description', () => {
    expect(buildFilenameCode(selected, '  Launch Deck  ', noVersion)).toBe('(PRD)(OVR)(SlD) Launch Deck');
  });

  it('omits the version entirely when major is blank', () => {
    expect(buildFilenameCode(selected, '', { major: '', minor: '5', patch: '2' })).toBe('(PRD)(OVR)(SlD)');
  });

  it('defaults blank minor/patch to 0 once major is set', () => {
    expect(buildFilenameCode(selected, '', { major: '2', minor: '', patch: '' }))
      .toBe('(PRD)(OVR)(SlD) v2-0-0');
  });

  it('keeps a literal zero major — "0" is truthy as a string', () => {
    // `version.major || '1'` would silently rewrite v0 to v1 if major were a number.
    // It is a string here, so '0' survives. This is the guard for that.
    expect(buildFilenameCode(selected, '', { major: '0', minor: '1', patch: '0' }))
      .toBe('(PRD)(OVR)(SlD) v0-1-0');
  });

  it('produces just the description when nothing is selected', () => {
    expect(buildFilenameCode([], 'Loose file', noVersion)).toBe(' Loose file');
  });
});

describe('buildObsidianTags', () => {
  it('collects each tag key and always ends with dam', () => {
    const selected = [
      tag({ shortcode: 'PRD', slot: 'entity', key: 'product' }),
      tag({ shortcode: 'SlD', slot: 'format', key: 'slides' }),
    ];
    expect(buildObsidianTags(selected)).toEqual(['product', 'slides', 'dam']);
  });

  it('de-duplicates repeated keys, keeping first-seen order', () => {
    const selected = [
      tag({ shortcode: 'A', slot: 'entity', key: 'shared' }),
      tag({ shortcode: 'B', slot: 'angle',  key: 'shared' }),
      tag({ shortcode: 'C', slot: 'format', key: 'other' }),
    ];
    expect(buildObsidianTags(selected)).toEqual(['shared', 'other', 'dam']);
  });

  it('skips blank and whitespace-only keys, and trims the rest', () => {
    const selected = [
      tag({ shortcode: 'A', slot: 'entity', key: '' }),
      tag({ shortcode: 'B', slot: 'angle',  key: '   ' }),
      tag({ shortcode: 'C', slot: 'format', key: '  spaced  ' }),
    ];
    expect(buildObsidianTags(selected)).toEqual(['spaced', 'dam']);
  });

  it('does not append a second dam when a tag already carries that key', () => {
    const selected = [tag({ shortcode: 'D', slot: 'entity', key: 'dam' })];
    expect(buildObsidianTags(selected)).toEqual(['dam']);
  });

  it('returns just dam for an empty selection', () => {
    expect(buildObsidianTags([])).toEqual(['dam']);
  });
});
