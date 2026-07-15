import { describe, it, expect } from 'vitest';
import { parseFilename, buildVocabContext } from './filenameTranslator';
import { buildFilenameCode } from './vocabulary';
import type { VocabularyData } from './vocabulary';

const vocab: VocabularyData = {
  _schema_version: '2.2.0',
  tags: [
    { shortcode: 'PRD', slot: 'entity', subtype: 'product', label: 'Product', obsidian_tag: 'product', icon: '' },
    { shortcode: 'SAL', slot: 'angle', subtype: 'sales-mktg', label: 'Sales', obsidian_tag: 'sales', icon: '' },
    { shortcode: 'SlD', slot: 'format', subtype: 'document', label: 'Slides', obsidian_tag: 'slides', icon: '' },
  ],
};

const ctx = buildVocabContext(vocab);

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
