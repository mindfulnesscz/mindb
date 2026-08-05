/* Asset row mapping — filename stem → the row the portal renders.
 *
 * SHARED-READY: pure functions over strings and a vocabulary object. No transport, no
 * filesystem, no Supabase client. This is the half of the old supabaseService that the web
 * portal needs too — it renders the same shortcodes, names and taxonomy arrays the desktop
 * pipeline writes. Moving it into @dc-hub/domain is a file move once the portal needs it.
 *
 * Two rules here pull in opposite directions, deliberately:
 *   - the display NAME de-duplicates by label, so two shortcodes sharing one display name
 *     ("Product" as both an entity and a format) do not render as "Product Product";
 *   - the taxonomy ARRAYS keep the label in every dimension it belongs to, because
 *     per-dimension membership is what the portal's filters query.
 * Collapsing either into the other breaks something. Pinned by
 * supabaseMapping.characterization.test.ts.
 */

import { parseFilename, buildVocabMap, type VocabularyData } from '@dc-hub/domain';

export function stripVersionSuffix(stem: string): string {
  return stem.replace(/\s+[vV]\d+(?:[-._]\d+)*\s*$/, '').trim();
}

export function unionStrings(lists: string[][]): string[] {
  return [...new Set(lists.flat())];
}

export function intersectStrings(lists: string[][]): string[] {
  if (!lists.length) return [];
  return lists[0].filter(x => lists.every(l => l.includes(x)));
}

export function parseAssetForSupabase(assetStem: string, vocab: VocabularyData) {
  const ctx    = buildVocabMap(vocab);
  const parsed = parseFilename(assetStem, ctx);

  const shortcode  = stripVersionSuffix(assetStem);
  const entityTags = parsed.tags.filter(t => t.slot === 'entity');
  const formatTags = parsed.tags.filter(t => t.slot === 'format');
  const angleTags  = parsed.tags.filter(t => t.slot === 'angle');

  // Preserve filename order; drop duplicate labels (same shortcode twice, or
  // two shortcodes sharing one display name across slots).
  const nameParts: string[] = [];
  const seenLabels = new Set<string>();
  for (const t of parsed.tags) {
    if (seenLabels.has(t.label)) continue;
    seenLabels.add(t.label);
    nameParts.push(t.label);
  }
  for (const u of parsed.unknownTags) {
    const token = `[${u}]`;
    if (seenLabels.has(token)) continue;
    seenLabels.add(token);
    nameParts.push(token);
  }
  let name = nameParts.join(' ');
  if (parsed.description) name += ` — ${parsed.description}`;

  const uniqLabels = (tags: typeof parsed.tags) =>
    [...new Set(tags.map(t => t.label).filter(Boolean))];

  return {
    shortcode,
    name:       name.trim() || shortcode,
    entities:   uniqLabels(entityTags),
    formats:    uniqLabels(formatTags),
    angles:     uniqLabels(angleTags),
    tags:       [...seenLabels].filter(l => !l.startsWith('[')),
    version:    parsed.version ?? '',
    year_month: parsed.yymm    ?? null,
  };
}
