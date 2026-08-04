/* Characterization tests — the ASSET ROW MAPPER (parseAssetForSupabase).
 *
 * This function turns a filename stem into the row the portal renders: shortcode, display name,
 * the three taxonomy arrays, a flat tag list, version and year_month. Every asset card, filter
 * and search result in the portal is downstream of it.
 *
 * It had no coverage. The 8 existing supabaseService tests are integration tests that need a live
 * local Postgres, so they are skipped in CI and prove nothing about this mapping. Since step 2c
 * moves exactly this logic into a shared package (the portal needs the same parsing), it gets
 * pinned first — the same order that made the pipelineService split a non-event.
 *
 * Hermetic: no database, no filesystem, no network.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: async () => false, readTextFile: async () => '', writeTextFile: async () => {},
  readFile: async () => new Uint8Array(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => ({}) }));
vi.mock('@tauri-apps/api/path', () => ({ join: async (...p: string[]) => p.join('/') }));

const { parseAssetForSupabase } = await import('./supabaseService');
import type { VocabularyData, VocabTag } from '@sotto/domain';

const tag = (shortcode: string, slot: VocabTag['slot'], label: string): VocabTag =>
  ({ shortcode, slot, parentGroup: null, label, key: label.toLowerCase(), icon: '' });

const VOCAB: VocabularyData = {
  _schema_version: '4.0.0',
  _comment: 'test fixture',
  tags: [
    tag('PRD', 'entity', 'Product'),
    tag('ACQ', 'entity', 'Acquisition'),
    tag('OVR', 'angle', 'Overview'),
    tag('SAL', 'angle', 'Sales'),
    tag('SlD', 'format', 'Slides'),
    tag('Gll', 'format', 'Gallery'),
    // Deliberate collision: a format tag whose LABEL matches an entity tag's label. Two
    // shortcodes, one display name — the mapper must not emit "Product Product".
    tag('PrB', 'format', 'Product'),
  ],
};

const parse = (stem: string) => parseAssetForSupabase(stem, VOCAB);

describe('parseAssetForSupabase — shortcode', () => {
  it('is the stem with the trailing version removed', () => {
    expect(parse('(PRD)(SlD) Deck v2').shortcode).toBe('(PRD)(SlD) Deck');
    expect(parse('(PRD)(SlD) Deck v1-2-0').shortcode).toBe('(PRD)(SlD) Deck');
  });

  it('accepts dot and underscore separators inside the version', () => {
    expect(parse('(PRD)(SlD) Deck v1.2.3').shortcode).toBe('(PRD)(SlD) Deck');
    expect(parse('(PRD)(SlD) Deck v1_2_3').shortcode).toBe('(PRD)(SlD) Deck');
  });

  it('keeps the stem intact when there is no trailing version', () => {
    expect(parse('(PRD)(SlD) Deck').shortcode).toBe('(PRD)(SlD) Deck');
  });

  it('only strips a version at the very END — a mid-name v-number is part of the name', () => {
    expect(parse('(PRD)(SlD) v2 Retrospective').shortcode).toBe('(PRD)(SlD) v2 Retrospective');
  });

  it('requires whitespace before the version, so "Deckv2" is not versioned', () => {
    expect(parse('(PRD)(SlD) Deckv2').shortcode).toBe('(PRD)(SlD) Deckv2');
  });
});

describe('parseAssetForSupabase — display name', () => {
  it('joins tag labels in FILENAME order, then appends the description', () => {
    // Order comes from the filename, not from slot order — (SlD) before (PRD) stays that way.
    expect(parse('(SlD)(PRD) Deck').name).toBe('Slides Product — Deck');
    expect(parse('(PRD)(SlD) Deck').name).toBe('Product Slides — Deck');
  });

  it('omits the em-dash when there is no description', () => {
    expect(parse('(PRD)(SlD)').name).toBe('Product Slides');
  });

  it('drops a duplicate LABEL even when the shortcodes differ', () => {
    // (PRD) entity "Product" and (PrB) format "Product" share a display name. Emitting both
    // would render "Product Product" on the card.
    expect(parse('(PRD)(PrB) Deck').name).toBe('Product — Deck');
  });

  it('drops the same shortcode repeated', () => {
    expect(parse('(PRD)(PRD) Deck').name).toBe('Product — Deck');
  });

  it('keeps an unknown shortcode visible in brackets rather than silently dropping it', () => {
    expect(parse('(PRD)(ZZZ) Deck').name).toBe('Product [ZZZ] — Deck');
  });

  it('places unknown tags after all known ones, regardless of filename order', () => {
    expect(parse('(ZZZ)(PRD) Deck').name).toBe('Product [ZZZ] — Deck');
  });

  it('falls back to the shortcode when nothing parses into a name', () => {
    expect(parse('Plain Document').name).toBe('Plain Document');
    expect(parse('Plain Document').shortcode).toBe('Plain Document');
  });

  it('uses the shortcode when the filename is only a version', () => {
    const r = parse('(PRD) v2');
    expect(r.shortcode).toBe('(PRD)');
    expect(r.name).toBe('Product');
  });
});

describe('parseAssetForSupabase — taxonomy arrays', () => {
  it('splits labels into the three dimensions', () => {
    const r = parse('(PRD)(OVR)(SlD) Deck');
    expect(r.entities).toEqual(['Product']);
    expect(r.angles).toEqual(['Overview']);
    expect(r.formats).toEqual(['Slides']);
  });

  it('supports several tags in one dimension', () => {
    const r = parse('(PRD)(ACQ)(SlD) Deck');
    expect(r.entities).toEqual(['Product', 'Acquisition']);
  });

  it('de-duplicates within a dimension', () => {
    expect(parse('(PRD)(PRD) Deck').entities).toEqual(['Product']);
  });

  it('keeps a shared label in BOTH dimensions it belongs to', () => {
    // The name collapses "Product Product" to one, but the arrays are per-dimension facts: the
    // asset genuinely is entity=Product and format=Product. Filters depend on that.
    const r = parse('(PRD)(PrB) Deck');
    expect(r.entities).toEqual(['Product']);
    expect(r.formats).toEqual(['Product']);
  });

  it('leaves a dimension empty when no tag targets it', () => {
    const r = parse('(PRD) Deck');
    expect(r.angles).toEqual([]);
    expect(r.formats).toEqual([]);
  });

  it('excludes unknown shortcodes from every dimension', () => {
    const r = parse('(ZZZ) Deck');
    expect(r.entities).toEqual([]);
    expect(r.angles).toEqual([]);
    expect(r.formats).toEqual([]);
  });
});

describe('parseAssetForSupabase — flat tag list', () => {
  it('carries every distinct known label', () => {
    expect(parse('(PRD)(OVR)(SlD) Deck').tags).toEqual(['Product', 'Overview', 'Slides']);
  });

  it('EXCLUDES bracketed unknown tags — they are display-only, never searchable facts', () => {
    expect(parse('(PRD)(ZZZ) Deck').tags).toEqual(['Product']);
  });

  it('is empty for an untagged filename', () => {
    expect(parse('Plain Document').tags).toEqual([]);
  });
});

describe('parseAssetForSupabase — version and date', () => {
  it('normalises the version to v-dash form', () => {
    expect(parse('(PRD) Deck v1-2-0').version).toBe('v1-2-0');
    expect(parse('(PRD) Deck v1.2.0').version).toBe('v1-2-0');
    expect(parse('(PRD) Deck v1_2_0').version).toBe('v1-2-0');
  });

  it('is an empty string, not null, when absent — the column is text', () => {
    expect(parse('(PRD) Deck').version).toBe('');
  });

  it('reads a YYMM tag into year_month and keeps it out of the name', () => {
    const r = parse('(2504)(PRD)(SlD) Deck');
    expect(r.year_month).toBe('2504');
    expect(r.name).toBe('Product Slides — Deck');
    expect(r.tags).toEqual(['Product', 'Slides']);
  });

  it('is null, not empty string, when there is no date — the column is nullable', () => {
    expect(parse('(PRD) Deck').year_month).toBeNull();
  });

  it('rejects an out-of-range month rather than storing it as a date', () => {
    // Month 13 is not a YYMM; it falls through to an unknown tag instead.
    const r = parse('(2513)(PRD) Deck');
    expect(r.year_month).toBeNull();
    expect(r.name).toContain('[2513]');
  });
});
