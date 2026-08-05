/* Publish local leaf vocabulary → public.tags.
 *
 * Parent groups are portal-managed; this only upserts and deletes shortcoded leaves. Key
 * derivation lives in ./taxonomyKeys because the portal must derive the same keys.
 */

import type { VocabularyData } from '@dc-hub/domain';
import type { SupabaseConfig } from './rest';
import { makeHeaders, sbFetch, fetchAllForClient } from './rest';
import { slugifyKeyPart, parentKeyForLeaf } from './taxonomyKeys';

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


/** Publish local leaf vocabulary → public.tags.
 * Parent groups are portal-managed — this only upserts/deletes shortcoded leaves.
 * Requires a signed-in staff session (RLS).
 */
export async function syncTagsFromVocabulary(
  vocab:     VocabularyData,
  clientId:  string,
  config:    SupabaseConfig,
  appendLog: (type: string, msg: string) => void,
): Promise<{ created: number; updated: number; deleted: number }> {
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
    const leaves = vocab.tags.filter(t => t.slot === slot);
    for (let i = 0; i < leaves.length; i++) {
      const tag = leaves[i];
      const shortcode = tag.shortcode.trim();
      if (!shortcode) continue;
      desiredShortcodes.add(shortcode);
      const key = tag.key.trim() || `${slot}.${slugifyKeyPart(tag.label)}`;
      desiredKeys.add(key);

      const parentId = tag.parentGroup
        ? (parentIdByGroupKey.get(`${slot}::${tag.parentGroup.trim()}`) ?? null)
        : null;

      const existingLeaf =
        byKey.get(key) ??
        byShortcode.get(shortcode) ??
        null;

      if (existingLeaf) {
        const patch: Record<string, unknown> = {};
        if (existingLeaf.name !== tag.label) patch.name = tag.label;
        if ((existingLeaf.key ?? null) !== key) patch.key = key;
        if ((existingLeaf.shortcode ?? null) !== shortcode) patch.shortcode = shortcode;
        if (existingLeaf.parent_id !== parentId) patch.parent_id = parentId;
        if (existingLeaf.dimension !== slot) patch.dimension = slot;
        if (existingLeaf.sort_order !== i) patch.sort_order = i;

        if (Object.keys(patch).length) {
          const oldShortcode = existingLeaf.shortcode;
          if (await patchTag(existingLeaf.id, patch)) {
            updated++;
            if (
              patch.shortcode !== undefined &&
              oldShortcode &&
              patch.shortcode !== oldShortcode
            ) {
              try {
                await sbFetch(`${base}/rename_tasks`, {
                  method:  'POST',
                  headers: { ...headers, Prefer: 'return=minimal' },
                  body: JSON.stringify({
                    client_id: clientId,
                    task_type: 'tag_rename',
                    payload: {
                      tag_id: existingLeaf.id,
                      old_shortcode: oldShortcode,
                      new_shortcode: shortcode,
                    },
                  }),
                });
              } catch (e) {
                appendLog('dim', `  ⚠  rename_task enqueue failed: ${e}`);
              }
            }
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
  for (const row of existing) {
    const sc = (row.shortcode ?? '').trim();
    if (!sc) continue;
    const k = (row.key ?? '').trim();
    if (desiredShortcodes.has(sc) || (k && desiredKeys.has(k))) continue;
    try {
      const res = await sbFetch(`${base}/tags?id=eq.${row.id}`, {
        method: 'DELETE',
        headers: { ...headers, Prefer: 'return=minimal' },
      });
      if (res.ok) {
        deleted++;
        if (sc) {
          try {
            await sbFetch(`${base}/rename_tasks`, {
              method:  'POST',
              headers: { ...headers, Prefer: 'return=minimal' },
              body: JSON.stringify({
                client_id: clientId,
                task_type: 'tag_delete',
                payload: { tag_id: row.id, shortcode: sc },
              }),
            });
          } catch { /* non-fatal */ }
        }
      } else {
        appendLog('error', `  ✕  Delete "${row.name}": ${await res.text()}`);
      }
    } catch (e) {
      appendLog('error', `  ✕  Delete "${row.name}": ${e}`);
    }
  }

  appendLog('dim', `  ${created} created · ${updated} updated · ${deleted} deleted`);
  appendLog('section', '━━━ TAG SYNC DONE ━━━');
  return { created, updated, deleted };
}

