/* Stage 3 — write the planned rows, parents before children.
 *
 * Children need their parent's resolved uuid, so the order is load-bearing.
 * 
 * Two guards that exist because of real corruption:
 *   - dedupe by key — two items resolving to one `stable_id:child_id` in a run would make the
 *     second INSERT a row its sibling just created;
 *   - a key that is BOTH a primary and a child keeps the primary, or the child write would PATCH a
 *     relation onto the primary's own row.
 * 
 * stripAbsentUrls covers the page-preview counts too, for the same reason.
 *
 * stripAbsentUrls matters because PATCH leaves omitted fields untouched in Postgres: sending
 * `thumbnail_url: null` from a run where the upload phase was cached or disabled would BLANK the
 * image the portal is already serving. Absent means "no opinion", not "clear it".
 *
 * stripPortalOwnedFields uses that same PATCH semantics deliberately: `perm` is a decision an
 * editor makes in the portal, so the pipeline supplies it once at INSERT and then has no opinion.
 * Sending it on every update would silently undo every promotion or lock-down between runs — and
 * because the access level is encoded in the R2 object key, it would drag the bytes back too.
 */

import { sbFetch } from './rest';
import type { ChildWrite, ParentWrite, StableRow, SupabaseExportResult } from './exportTypes';

type Log = (type: string, msg: string) => void;

/** Collapse repeats by key, warning on each dropped duplicate. */
export function dedupeByKey<T extends { key: string }>(items: T[], label: string, appendLog: Log): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) {
    if (byKey.has(item.key)) appendLog('warn', `  ⚠  Duplicate ${label} target ${item.key} this run — keeping first, dropping repeat`);
    else byKey.set(item.key, item);
  }
  return [...byKey.values()];
}

/** Drop URL fields we have no value for — see the note above on PATCH semantics. */
export function stripAbsentUrls(record: Record<string, unknown>): Record<string, unknown> {
  const out = { ...record };
  if (out.thumbnail_url == null) delete out.thumbnail_url;
  if (out.download_url == null) delete out.download_url;
  if (Array.isArray(out.download_urls) && out.download_urls.length === 0) delete out.download_urls;
  /* Same reasoning for the page counts: a run with thumbnails disabled, or one where this asset was
     not re-rendered, has NO OPINION about them. Sending null would blank the count the portal reads
     to decide how many pages to show. */
  if (out.preview_page_count == null) delete out.preview_page_count;
  if (out.preview_page_total == null) delete out.preview_page_total;
  return out;
}

/**
 * Drop fields the portal owns once a row exists — see the note above.
 *
 * `perm` only. `status` stays on the update path on purpose: it is how a row whose file came back
 * to disk is un-`disconnected`, and dropping it would leave reconnected assets invisible forever.
 */
export function stripPortalOwnedFields(record: Record<string, unknown>): Record<string, unknown> {
  const out = { ...record };
  delete out.perm;
  return out;
}

/**
 * Write parents/singles. Returns key → row uuid so children can be linked.
 * `existing` is updated as we go, so a key resolved more than once this run still lands as an
 * update rather than a duplicate insert.
 */
export async function writeParents(
  parents: ParentWrite[],
  existing: Map<string, StableRow>,
  base: string,
  headers: Record<string, string>,
  result: SupabaseExportResult,
  appendLog: Log,
  shouldStop?: () => boolean,
): Promise<Map<string, string>> {
  const parentIdByKey = new Map<string, string>();

  for (const { key, record: rawRecord } of parents) {
    if (shouldStop?.()) break;
    // A primary/gallery parent is always top-of-hierarchy — clear BOTH relation fields
    // explicitly, or a stale value from an earlier build lingers (PATCH omits ⇒ untouched).
    const record = stripAbsentUrls({ ...rawRecord, parent_id: null, variant_of: null });
    const existingRow = existing.get(key);
    try {
      if (existingRow) {
        const res = await sbFetch(`${base}/assets?id=eq.${existingRow.id}`, {
          method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify(stripPortalOwnedFields(record)),
        });
        if (res.ok) { result.updated++; parentIdByKey.set(key, existingRow.id); }
        else { appendLog('error', `  ✕  Stable update failed for ${key}: ${await res.text()}`); result.errors++; }
      } else {
        const res = await sbFetch(`${base}/assets`, {
          method: 'POST', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify(record),
        });
        if (res.ok) {
          const created = await res.json<Array<{ id: string }>>();
          result.created++;
          if (created[0]?.id) {
            parentIdByKey.set(key, created[0].id);
            existing.set(key, {
              id: created[0].id,
              stable_id: rawRecord.stable_id as string,
              child_id: rawRecord.child_id as string,
              thumbnail_url: (rawRecord.thumbnail_url as string | null) ?? null,
              parent_id: null, variant_of: null,
            });
          }
        } else { appendLog('error', `  ✕  Stable insert failed for ${key}: ${await res.text()}`); result.errors++; }
      }
    } catch (e) { appendLog('error', `  ✕  Stable write error for ${key}: ${e}`); result.errors++; }
  }

  return parentIdByKey;
}

/** Write children, linking each to its parent by the relation the plan chose. */
export async function writeChildren(
  children: ChildWrite[],
  parentIdByKey: Map<string, string>,
  existing: Map<string, StableRow>,
  base: string,
  headers: Record<string, string>,
  result: SupabaseExportResult,
  appendLog: Log,
  shouldStop?: () => boolean,
): Promise<void> {
  for (const { key, record, parentKey, relation } of children) {
    if (shouldStop?.()) return;
    const parentId = parentIdByKey.get(parentKey);
    if (!parentId) { appendLog('error', `  ✕  No parent ID for ${key} — child skipped`); result.errors++; continue; }
    // Null the OTHER relation too: a row synced by an earlier build (before galleries and
    // variants were split apart) may still carry a stale value there.
    const otherRelation = relation === 'parent_id' ? 'variant_of' : 'parent_id';
    const withParent = stripAbsentUrls({ ...record, [relation]: parentId, [otherRelation]: null });
    const existingRow = existing.get(key);
    try {
      if (existingRow) {
        const res = await sbFetch(`${base}/assets?id=eq.${existingRow.id}`, {
          method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify(stripPortalOwnedFields(withParent)),
        });
        if (res.ok) result.updated++;
        else { appendLog('error', `  ✕  Stable child update failed for ${key}: ${await res.text()}`); result.errors++; }
      } else {
        const res = await sbFetch(`${base}/assets`, {
          method: 'POST', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify(withParent),
        });
        if (res.ok) {
          const created = await res.json<Array<{ id: string }>>();
          result.created++;
          if (created[0]?.id) existing.set(key, {
            id: created[0].id,
            stable_id: record.stable_id as string,
            child_id: record.child_id as string,
            thumbnail_url: (record.thumbnail_url as string | null) ?? null,
            parent_id: (withParent.parent_id as string | null) ?? null,
            variant_of: (withParent.variant_of as string | null) ?? null,
          });
        } else { appendLog('error', `  ✕  Stable child insert failed for ${key}: ${await res.text()}`); result.errors++; }
      }
    } catch (e) { appendLog('error', `  ✕  Stable child write error for ${key}: ${e}`); result.errors++; }
  }
}
