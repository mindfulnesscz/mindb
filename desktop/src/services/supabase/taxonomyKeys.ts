/* Taxonomy key derivation — the stable `slot.group.leaf` keys tags are addressed by.
 *
 * SHARED-READY: pure string logic, no transport. A key is an ADDRESS, not a label — it is the
 * Obsidian tag on export and the node identity in the portal's filter tree. The portal creates
 * parent groups while the desktop app publishes leaves under them, so both sides must derive the
 * same key for the same tag, or one hierarchy silently becomes two.
 */

export function slugifyKeyPart(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '');
}

/** Parent taxonomy key for a leaf: strip last key segment, or invent from parentGroup name. */
export function parentKeyForLeaf(tag: { key: string; slot: string; parentGroup: string | null }): string | null {
  if (!tag.parentGroup?.trim()) return null;
  const parts = tag.key.split('.').filter(Boolean);
  if (parts.length >= 2) return parts.slice(0, -1).join('.');
  return `${tag.slot}.${slugifyKeyPart(tag.parentGroup)}`;
}
