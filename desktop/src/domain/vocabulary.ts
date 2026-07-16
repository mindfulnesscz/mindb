/* Vocabulary domain types and helpers */

export type Slot = 'entity' | 'angle' | 'format';

export interface VocabTag {
  shortcode: string;
  slot: Slot;
  /** Display name of the parent group (from parent_id); null = ungrouped root leaf. */
  parentGroup: string | null;
  label: string;
  /** Stable taxonomy key — used as the Obsidian tag on export. */
  key: string;
  icon: string;
}

/** Portal-managed parent group (no shortcode). Desktop selects these; does not create them. */
export interface VocabParentGroup {
  name: string;
  key: string;
  slot: Slot;
}

export interface VocabularyData {
  _schema_version: string;
  _comment: string;
  tags: VocabTag[];
  /** Parent groups from DB — portal-only structure. */
  parentGroups?: VocabParentGroup[];
  legacy_aliases?: Record<string, string>;
  /** Set on local cache when there are unpublished edits (survives client switch). */
  _unpublished?: boolean;
}

export const SLOT_LABELS: Record<Slot, string> = {
  entity: 'Entity',
  angle: 'Angle',
  format: 'Format',
};

/** Per-client display name for a dimension (falls back to SLOT_LABELS). */
export function dimensionLabelForSlot(
  client: { dimensionLabels?: Partial<Record<Slot, string>> } | null | undefined,
  slot: Slot,
): string {
  return client?.dimensionLabels?.[slot]?.trim() || SLOT_LABELS[slot];
}

export const SLOT_DESCRIPTIONS: Record<Slot, string> = {
  entity: "Tags that answer 'Who or what is this about?'",
  angle: "Tags that answer 'What is the purpose or angle?'",
  format: "Tags that answer 'What kind of file is it?'",
};

/** Unique parent group labels for a slot from portal groups + any leaf parentGroup values. */
export function parentGroupsForSlot(
  tags: VocabTag[],
  slot: Slot,
  portalGroups?: VocabParentGroup[],
): string[] {
  const seen = new Set<string>();
  const groups: string[] = [];
  for (const g of portalGroups ?? []) {
    if (g.slot !== slot) continue;
    if (!seen.has(g.name)) {
      seen.add(g.name);
      groups.push(g.name);
    }
  }
  let hasUngrouped = false;
  for (const t of tags) {
    if (t.slot !== slot) continue;
    if (!t.parentGroup) {
      hasUngrouped = true;
      continue;
    }
    if (!seen.has(t.parentGroup)) {
      seen.add(t.parentGroup);
      groups.push(t.parentGroup);
    }
  }
  if (hasUngrouped) groups.push('Ungrouped');
  return groups;
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

/** Collect Obsidian tags from selection — each tag's `key`, de-duplicated, always ending with `dam`. */
export function buildObsidianTags(selected: VocabTag[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of selected) {
    const k = tag.key.trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      result.push(k);
    }
  }
  if (!seen.has('dam')) result.push('dam');
  return result;
}
