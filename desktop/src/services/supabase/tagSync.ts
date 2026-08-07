/* Publish local leaf vocabulary → public.tags.
 *
 * Parent groups are portal-managed; this only upserts and deletes shortcoded leaves. Key
 * derivation lives in ./taxonomyKeys because the portal must derive the same keys.
 */

import type { VocabularyData } from '@sotto/domain';
import type { SupabaseConfig } from './rest';
import { makeHeaders, sbFetch, fetchAllForClient } from './rest';
import { timePhase } from '../pipeline/timing';
import { slugifyKeyPart, parentKeyForLeaf } from './taxonomyKeys';
import { assessFreshDestruction } from '../guardrail';

/* ── Tag hierarchy sync ──────────────────────────────────────────────────── */

interface DbTagSyncRow {
  id: string;
  name: string;
  key: string | null;
  dimension: string;
  parent_id: string | null;
  shortcode: string | null;
  sort_order: number;
}

export interface TagSyncOptions {
  dryRun?: boolean;
  /** Deletions require a vocabulary freshly synchronized with the portal, never a dirty cache. */
  sourceFresh?: boolean;
  allowLargeDeletions?: boolean;
  shouldStop?: () => boolean;
}


/** Publish local leaf vocabulary → public.tags.
 * Parent groups are portal-managed — this only upserts/deletes shortcoded leaves.
 * Requires a signed-in staff session (RLS).
 */
export async function syncTagsFromVocabulary(
  vocab:     VocabularyData,
  clientId:  string,
  config:    SupabaseConfig,
  appendLog: (type: string, msg: string) => void,
  options:   TagSyncOptions = {},
): Promise<{ created: number; updated: number; deleted: number; deletionRefused: boolean }> {
  const {
    dryRun = false,
    sourceFresh = false,
    allowLargeDeletions = false,
    shouldStop,
  } = options;
  const phase = timePhase('TAG SYNC');
  appendLog('section', '━━━ TAG SYNC (local → portal) ━━━');
  const base    = `${config.url.replace(/\/+$/, '')}/rest/v1`;
  const headers = await makeHeaders(config.anonKey);

  let existing: DbTagSyncRow[];
  try {
    existing = await fetchAllForClient<DbTagSyncRow>(
      base, 'tags', clientId,
      'id,name,key,dimension,parent_id,shortcode,sort_order',
      headers,
    );
  } catch (e) {
    appendLog('error', `  ✕  Could not fetch tags: ${e}`);
    throw e;
  }
  appendLog('dim', `  ${existing.length} existing tag row(s)`);

  const byKey = new Map<string, DbTagSyncRow>();
  const byShortcode = new Map<string, DbTagSyncRow>();
  for (const r of existing) {
    if (r.key) byKey.set(r.key, r);
    if (r.shortcode) byShortcode.set(r.shortcode, r);
  }

  const slots: Array<'entity' | 'angle' | 'format'> = ['entity', 'angle', 'format'];
  let created = 0;
  let updated = 0;
  let deleted = 0;

  async function insertTag(body: Record<string, unknown>): Promise<DbTagSyncRow | null> {
    if (dryRun) {
      appendLog('dim', `  [DRY] would insert tag "${body.name}"`);
      return {
        id: `dry:${body.key}`,
        name: String(body.name ?? ''),
        key: String(body.key ?? ''),
        dimension: String(body.dimension ?? ''),
        parent_id: (body.parent_id as string | null) ?? null,
        shortcode: String(body.shortcode ?? ''),
        sort_order: Number(body.sort_order ?? 0),
      };
    }
    const res = await sbFetch(`${base}/tags`, {
      method:  'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      appendLog('error', `  ✕  Insert failed: ${await res.text()}`);
      return null;
    }
    const rows = await res.json<DbTagSyncRow[]>();
    return rows[0] ?? null;
  }

  async function patchTag(id: string, body: Record<string, unknown>): Promise<boolean> {
    if (dryRun) {
      appendLog('dim', `  [DRY] would update tag ${id}: ${Object.keys(body).join(', ')}`);
      return true;
    }
    const res = await sbFetch(`${base}/tags?id=eq.${id}`, {
      method:  'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      appendLog('error', `  ✕  Update ${id}: ${await res.text()}`);
      return false;
    }
    return true;
  }

  // Pass 1 — resolve existing portal parent groups (never create/edit groups from desktop)
  const parentIdByGroupKey = new Map<string, string>(); // `${slot}::${parentGroupName}` → id

  for (const row of existing) {
    const isRootGroup = !row.parent_id && !(row.shortcode ?? '').trim();
    if (!isRootGroup) continue;
    parentIdByGroupKey.set(`${row.dimension}::${row.name}`, row.id);
  }

  for (const slot of slots) {
    if (shouldStop?.()) break;
    for (const leaf of vocab.tags.filter(t => t.slot === slot && t.parentGroup)) {
      const name = leaf.parentGroup!.trim();
      const mapKey = `${slot}::${name}`;
      if (parentIdByGroupKey.has(mapKey)) continue;
      // Try match by derived key from leaf path
      const gKey = parentKeyForLeaf(leaf);
      if (gKey && byKey.get(gKey)) {
        parentIdByGroupKey.set(mapKey, byKey.get(gKey)!.id);
        continue;
      }
      appendLog('dim', `  ⚠  Parent group "${name}" (${slot}) not in portal — leaf "${leaf.shortcode}" will be ungrouped`);
    }
  }

  // Pass 2 — shortcoded leaves only (groups stay portal-managed)
  const desiredShortcodes = new Set<string>();
  const desiredKeys = new Set<string>();

  for (const slot of slots) {
    if (shouldStop?.()) break;
    const leaves = vocab.tags.filter(t => t.slot === slot);
    for (let i = 0; i < leaves.length; i++) {
      if (shouldStop?.()) break;
      const tag = leaves[i];
      const shortcode = tag.shortcode.trim();
      if (!shortcode) continue;
      desiredShortcodes.add(shortcode);
      const key = tag.key.trim() || `${slot}.${slugifyKeyPart(tag.label)}`;
      desiredKeys.add(key);

      const resolvedParentId = tag.parentGroup
        ? (parentIdByGroupKey.get(`${slot}::${tag.parentGroup.trim()}`) ?? null)
        : null;

      const existingLeaf =
        byKey.get(key) ??
        byShortcode.get(shortcode) ??
        null;

      /* Pass 1 resolves the parent group by NAME; the lookup above finds the row to update by key or
         shortcode. Nothing links those two, so both can land on the SAME row — a keyed,
         shortcode-less group whose name is also this leaf's parentGroup. Writing that produces
         `parent_id = id`, which carries no information, cannot be expressed in the taxonomy import
         format, and turns every later export into a file the portal refuses ("cannot parent itself",
         then "cycle detected" for everything beneath it).
         Ungrouped is the honest outcome, and it is said out loud rather than quietly dropped. */
      const parentId = existingLeaf && resolvedParentId === existingLeaf.id ? null : resolvedParentId;
      if (parentId !== resolvedParentId) {
        appendLog('warn',
          `  ⚠  "${tag.label}" (${slot}) cannot be its own parent — its group "${tag.parentGroup?.trim()}" `
          + 'resolves to this same tag; leaving it ungrouped');
      }

      if (existingLeaf) {
        const patch: Record<string, unknown> = {};
        if (existingLeaf.name !== tag.label) patch.name = tag.label;
        if ((existingLeaf.key ?? null) !== key) patch.key = key;
        if ((existingLeaf.shortcode ?? null) !== shortcode) patch.shortcode = shortcode;
        if (existingLeaf.parent_id !== parentId) patch.parent_id = parentId;
        if (existingLeaf.dimension !== slot) patch.dimension = slot;
        if (existingLeaf.sort_order !== i) patch.sort_order = i;

        if (Object.keys(patch).length) {
          if (await patchTag(existingLeaf.id, patch)) {
            updated++;
            Object.assign(existingLeaf, patch, { key, shortcode, parent_id: parentId, dimension: slot });
            byKey.set(key, existingLeaf);
            byShortcode.set(shortcode, existingLeaf);
          }
        }
        continue;
      }

      const row = await insertTag({
        client_id:  clientId,
        name:       tag.label,
        key,
        dimension:  slot,
        parent_id:  parentId,
        shortcode,
        sort_order: i,
      });
      if (row) {
        created++;
        byKey.set(key, row);
        byShortcode.set(shortcode, row);
        existing.push(row);
      }
    }
  }

  // Pass 3 — delete shortcoded DB leaves no longer in local vocab
  const stale = existing.filter(row => {
    const sc = (row.shortcode ?? '').trim();
    if (!sc) return false;
    const k = (row.key ?? '').trim();
    return !desiredShortcodes.has(sc) && !(k && desiredKeys.has(k));
  });
  const verdict = assessFreshDestruction({
    unit: 'portal tag(s)',
    doomed: stale.length,
    written: created + updated,
    allowLarge: allowLargeDeletions,
    sourceFresh,
    source: 'the local vocabulary',
  });
  if (verdict.message) appendLog(verdict.blocked ? 'error' : 'dim', verdict.message);
  const deletionRefused = verdict.blocked;

  for (const row of verdict.blocked ? [] : stale) {
    if (shouldStop?.()) break;
    const sc = (row.shortcode ?? '').trim();
    if (dryRun) {
      appendLog('dim', `  [DRY] would delete portal tag "${row.name}" (${sc})`);
      deleted++;
      continue;
    }
    try {
      const res = await sbFetch(`${base}/tags?id=eq.${row.id}`, {
        method: 'DELETE',
        headers: { ...headers, Prefer: 'return=minimal' },
      });
      if (res.ok) {
        deleted++;
      } else {
        appendLog('error', `  ✕  Delete "${row.name}": ${await res.text()}`);
      }
    } catch (e) {
      appendLog('error', `  ✕  Delete "${row.name}": ${e}`);
    }
  }

  appendLog('dim', `  ${created} created · ${updated} updated · ${deleted} deleted`);
  appendLog('section', `━━━ TAG SYNC DONE ━━━ in ${phase.done()}`);
  return { created, updated, deleted, deletionRefused };
}
