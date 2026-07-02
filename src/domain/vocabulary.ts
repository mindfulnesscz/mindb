/* Vocabulary domain types and helpers */

export type Slot = 'entity' | 'angle' | 'format';

export type EntitySubtype = 'company' | 'product' | 'customer' | 'partner' | 'event';
export type AngleSubtype  = 'sales-mktg' | 'content' | 'context';
export type FormatSubtype = 'document' | 'media' | 'asset';
export type Subtype = EntitySubtype | AngleSubtype | FormatSubtype;

export interface VocabTag {
  shortcode:    string;
  slot:         Slot;
  subtype:      Subtype;
  label:        string;
  obsidian_tag: string; // space-separated
  icon:         string;
}

export interface VocabularyData {
  _schema_version:  string;
  _comment:         string;
  tags:             VocabTag[];
  legacy_aliases?:  Record<string, string>;
}

/* Prefix rules for Entity subtypes */
export const ENTITY_PREFIXES: Record<EntitySubtype, string> = {
  company:  '',
  product:  'p-',
  customer: 'c-',
  partner:  'x-',
  event:    'e-',
};

export const SUBTYPES: Record<Slot, Subtype[]> = {
  entity: ['company', 'product', 'customer', 'partner', 'event'],
  angle:  ['sales-mktg', 'content', 'context'],
  format: ['document', 'media', 'asset'],
};

export const SLOT_LABELS: Record<Slot, string> = {
  entity: 'Entity',
  angle:  'Angle',
  format: 'Format',
};

export const SLOT_DESCRIPTIONS: Record<Slot, string> = {
  entity: "Tags that answer 'Who or what is this about?'",
  angle:  "Tags that answer 'What is the purpose or angle?'",
  format: "Tags that answer 'What kind of file is it?'",
};

export function prefixForSubtype(slot: Slot, subtype: Subtype): string {
  if (slot !== 'entity') return '';
  return ENTITY_PREFIXES[subtype as EntitySubtype] ?? '';
}

export function buildShortcode(slot: Slot, subtype: Subtype, distinctive: string): string {
  const prefix = prefixForSubtype(slot, subtype);
  return prefix + distinctive;
}

/* Given selected tags (by shortcode), produce the full filename shortcode string */
export function buildFilenameCode(
  selected: VocabTag[],
  description: string,
  version: { major: string; minor: string; patch: string }
): string {
  const parts = selected.map(t => `(${t.shortcode})`).join('');
  let result = parts;
  if (description.trim()) result += ` ${description.trim()}`;
  if (version.major !== '') {
    result += ` v${version.major || '1'}-${version.minor || '0'}-${version.patch || '0'}`;
  }
  return result;
}

/* Collect all Obsidian tags from a selection, de-duplicated, always ending with 'dam' */
export function buildObsidianTags(selected: VocabTag[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of selected) {
    for (const t of tag.obsidian_tag.split(' ').filter(Boolean)) {
      if (!seen.has(t)) { seen.add(t); result.push(t); }
    }
  }
  if (!seen.has('dam')) result.push('dam');
  return result;
}
