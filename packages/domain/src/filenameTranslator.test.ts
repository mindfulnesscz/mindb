import { describe, it, expect } from 'vitest';
import {
  buildVocabMap,
  parseFilename,
  sanitizeSegment,
  translateExportName,
} from './filenameTranslator';
import { buildFilenameCode } from './vocabulary';
import type { VocabularyData } from './vocabulary';

const vocab: VocabularyData = {
  _schema_version: '4.0.0',
  _comment: 'test',
  tags: [
    { shortcode: 'PRD', slot: 'entity', parentGroup: 'Product', label: 'Product', key: 'entity.product.product', icon: '' },
    { shortcode: 'SAL', slot: 'angle', parentGroup: 'Sales', label: 'Sales', key: 'angle.sales.sales', icon: '' },
    { shortcode: 'SlD', slot: 'format', parentGroup: 'Document', label: 'Slides', key: 'format.document.slides', icon: '' },
  ],
};

const ctx = buildVocabMap(vocab);

describe('parseFilename', () => {
  it('parses canonical tag prefix and version', () => {
    const r = parseFilename('(PRD)(SAL)(SlD) Pitch Deck v1-2-0', ctx);
    expect(r.tags.map(t => t.label)).toEqual(['Product', 'Sales', 'Slides']);
    expect(r.description).toBe('Pitch Deck');
    expect(r.version).toBe('v1-2-0');
  });

  it('returns empty tags for unknown shortcodes', () => {
    const r = parseFilename('(ZZZ) Mystery v1-0-0', ctx);
    expect(r.tags).toHaveLength(0);
    expect(r.unknownTags).toContain('ZZZ');
  });
});

describe('buildFilenameCode', () => {
  it('builds coded stem from selected tags', () => {
    const code = buildFilenameCode(
      vocab.tags.filter(t => ['PRD', 'SAL', 'SlD'].includes(t.shortcode)),
      'Pitch Deck',
      { major: '1', minor: '2', patch: '0' },
    );
    expect(code).toContain('(PRD)');
    expect(code).toContain('Pitch Deck');
    expect(code).toMatch(/v1-2-0/);
  });
});

describe('sanitizeSegment', () => {
  it('keeps editable taxonomy labels inside one path segment', () => {
    expect(sanitizeSegment('../Client\\Exports')).toBe('Client Exports');
    expect(sanitizeSegment('..')).toBe('_');
    expect(sanitizeSegment('CON')).toBe('_CON');
  });

  it('strips every character that would split or break a path', () => {
    // A tag label is portal-editable free text. Each of these either creates path structure or is
    // rejected outright by a filesystem, and the failure lands at write time, mid-run.
    expect(sanitizeSegment('a/b\\c')).toBe('a b c');
    expect(sanitizeSegment('re:view <draft> "final"|v2?*')).toBe('re view draft final v2');
    expect(sanitizeSegment('  spaced   out  ')).toBe('spaced out');
  });

  it('refuses to end a segment in a dot or a space', () => {
    // Windows silently drops both, so `Deck .` and `Deck` become the same directory — one run
    // writing into the other's folder.
    expect(sanitizeSegment('Deck.')).toBe('Deck');
    expect(sanitizeSegment('Deck ...  ')).toBe('Deck');
  });

  it.each([
    ['an empty label', ''],
    ['whitespace only', '   '],
    ['a single dot', '.'],
    ['a parent traversal', '..'],
    ['a dotted traversal', '../..'],
  ])('replaces %s with a placeholder rather than an empty segment', (_label, value) => {
    // An empty segment collapses in `join()`, quietly writing one level up.
    expect(sanitizeSegment(value)).toBe('_');
  });

  it.each(['CON', 'prn', 'AUX', 'nul', 'com1', 'LPT9', 'con.txt'])(
    'escapes the reserved Windows device name %s',
    value => {
      expect(sanitizeSegment(value)).toBe(`_${value}`);
    },
  );

  it('leaves an ordinary label untouched', () => {
    expect(sanitizeSegment('Sales Deck — Q3')).toBe('Sales Deck — Q3');
    expect(sanitizeSegment('console')).toBe('console');   // not a reserved name, only a prefix of one
  });

  it('sanitizes an unparsed stem and an unknown tag too', () => {
    // Both bypass the vocabulary, so neither is covered by sanitizing labels alone.
    expect(translateExportName('../escape', '.pdf', buildVocabMap(vocab))).toBe('escape.pdf');
    expect(translateExportName('(../ZZZ) Brief', '.pdf', buildVocabMap(vocab))).not.toMatch(/[\\/]/);
  });

  it('sanitizes taxonomy labels before building an export filename', () => {
    const unsafeVocab = buildVocabMap({
      ...vocab,
      tags: [{ ...vocab.tags[0], label: '../Outside' }],
    });

    const translated = translateExportName('(PRD) Brief v1-0-0', '.pdf', unsafeVocab);
    expect(translated).toBe('Outside — Brief v1-0-0.pdf');
    expect(translated).not.toMatch(/[\\/]/);
  });
});
