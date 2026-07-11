/* Filename parsing and export-name translation, ported from Python POC's
   _parse_asset_filename() + _translate_export_name(). Shared by both the
   pipeline publish step and the DAM/Obsidian note builder. */

import type { VocabTag, VocabularyData } from './vocabulary';

export interface ParsedFilename {
  tags:        VocabTag[];
  unknownTags: string[];
  description: string | null;
  version:     string | null;
  yymm:        string | null;
  error:       string | null;
}

export interface VocabContext {
  tags:    Map<string, VocabTag>;
  aliases: Map<string, string>;
}

export function buildVocabMap(vocab: VocabularyData): Map<string, VocabTag> {
  return new Map(vocab.tags.map(t => [t.shortcode, t]));
}

export function buildVocabContext(vocab: VocabularyData): VocabContext {
  const tags    = buildVocabMap(vocab);
  const aliases = new Map<string, string>();
  if (vocab.legacy_aliases) {
    for (const [old, canonical] of Object.entries(vocab.legacy_aliases)) {
      if (old === '_comment') continue;
      if (!tags.has(canonical)) continue; // only map to known shortcodes
      if (tags.has(old)) continue;        // don't shadow a real shortcode
      aliases.set(old, canonical);
    }
  }
  return { tags, aliases };
}

export function parseFilename(stem: string, vocab: Map<string, VocabTag> | VocabContext): ParsedFilename {
  const r: ParsedFilename = {
    tags: [], unknownTags: [], description: null, version: null, yymm: null, error: null,
  };

  const tags    = vocab instanceof Map ? vocab : vocab.tags;
  const aliases = vocab instanceof Map ? undefined : vocab.aliases;

  const leadMatch = stem.match(/^(?:\([^)]+\)|\[[^\]]+\])+/);
  if (!leadMatch) {
    r.error = 'No bracket tags at start of filename';
    return r;
  }

  const rawTags = [...leadMatch[0].matchAll(/(?:\(([^)]+)\)|\[([^\]]+)\])/g)]
    .map(m => m[1] || m[2]);

  for (const tag of rawTags) {
    if (/^\d{2}(0[1-9]|1[0-2])$/.test(tag)) { r.yymm = tag; continue; }
    const resolved = aliases?.get(tag) ?? tag;
    const entry    = tags.get(resolved);
    if (entry) r.tags.push(entry);
    else r.unknownTags.push(tag);
  }

  const rest     = stem.slice(leadMatch[0].length);
  const verMatch = rest.match(/\b[vV]\d+(?:[-._]\d+)*\b/);
  if (verMatch) {
    r.version = 'v' + verMatch[0].slice(1).replace(/[._]/g, '-');
  }
  const descPart = (verMatch ? rest.slice(0, verMatch.index) : rest).trim();
  if (descPart) r.description = descPart.replace(/^[-_\s]+|[-_\s]+$/g, '');

  return r;
}

/* Mirrors Python's _build_note_name(): labels + description, no version, no ext */
export function buildNoteName(p: ParsedFilename): string {
  const parts = p.tags.map(t => t.label);
  parts.push(...p.unknownTags.map(u => `[${u}]`));
  let name = parts.length ? parts.join(' ') : '(Untagged)';
  if (p.description) name += ` — ${p.description}`;
  return name.replace(/\s+/g, ' ').trim();
}

/* Mirrors Python's _translate_export_name(): full translation with version + ext.
   Falls back to the original stem+ext when parsing fails entirely. */
export function translateExportName(stem: string, ext: string, vocab: Map<string, VocabTag> | VocabContext): string {
  const p = parseFilename(stem, vocab);
  if (p.error && !p.tags.length && !p.unknownTags.length) return stem + ext;

  const parts = p.tags.map(t => t.label);
  parts.push(...p.unknownTags.map(u => `[${u}]`));
  let name = parts.length ? parts.join(' ') : stem;
  if (p.description) name += ` — ${p.description}`;
  if (p.version)     name += ` ${p.version}`;
  name = name.replace(/\s+/g, ' ').trim();
  if (p.yymm) name = `${p.yymm} ${name}`;
  return name + ext;
}
