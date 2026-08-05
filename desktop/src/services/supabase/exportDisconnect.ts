/* Stage 4 — soft-disconnect rows whose file left the disk.
 *
 * SOFT, always. A row carries the asset's ratings, comments, approvals and view/download events;
 * deleting it would take those with it, and a transient disk change (an unmounted drive, a folder
 * being reorganised) must never be able to do that. The row is marked `disconnected` and the CDN
 * keys are merely REPORTED, so object deletion stays a separate, explicit action.
 */

import { effectiveLevel, pageTarget, storageTarget } from '@sotto/domain';
import { sbFetch, BATCH } from './rest';
import { assessFreshDestruction } from '../guardrail';
import type { StableRow, SupabaseExportResult } from './exportTypes';

function objectKeyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
}

function originalExtension(row: StableRow): string | null {
  const prefix = `${row.child_id}.`;
  for (const key of [row.download_key, objectKeyFromUrl(row.download_url)]) {
    if (!key) continue;
    const leaf = key.split('/').pop() ?? '';
    if (leaf.startsWith(prefix)) return leaf.slice(row.child_id.length);
  }
  return null;
}

/** Exact keys written by `runCdnUpload`/`runOriginalUpload` for this row's current level. */
export function disconnectedObjectKeys(row: StableRow, clientId: string): string[] {
  const level = effectiveLevel({ perm: row.perm, status: row.status });
  const keys: string[] = [];
  if (row.thumbnail_url) {
    keys.push(storageTarget(
      level, clientId, 'thumbnails', row.stable_id, row.child_id, '.webp',
    ).key);
  }
  const ext = originalExtension(row);
  if (ext) {
    keys.push(storageTarget(
      level, clientId, 'originals', row.stable_id, row.child_id, ext,
    ).key);
  }
  const pageCount = Math.max(0, row.preview_page_count ?? 0);
  for (let page = 1; page <= pageCount; page++) {
    keys.push(pageTarget(level, clientId, row.stable_id, row.child_id, page).key);
  }
  return keys;
}

function referencedObjectKeys(
  existing: Map<string, StableRow>,
  currentStableKeys: Set<string>,
): Set<string> {
  const referenced = new Set<string>();
  for (const [stableKey, row] of existing) {
    if (!currentStableKeys.has(stableKey)) continue;
    for (const value of [row.thumbnail_url, row.download_url, row.download_key]) {
      if (!value) continue;
      const key = value.includes('://') ? objectKeyFromUrl(value) : value;
      if (key) referenced.add(key);
    }
  }
  return referenced;
}

function appendStaleObjectKeys(
  rows: StableRow[],
  clientId: string,
  protectedKeys: Set<string>,
  result: SupabaseExportResult,
): void {
  const keys = rows.flatMap(row => disconnectedObjectKeys(row, clientId))
    .filter(key => !protectedKeys.has(key));
  result.staleObjectKeys.push(...new Set(keys));
}

export async function disconnectStaleRows(
  existing: Map<string, StableRow>,
  currentStableKeys: Set<string>,
  clientId: string,
  base: string,
  headers: Record<string, string>,
  result: SupabaseExportResult,
  appendLog: (type: string, msg: string) => void,
  allowLargeDeletions = false,
  dryRun = false,
  shouldStop?: () => boolean,
  sourceFresh = true,
): Promise<void> {
  const stale = [...existing.entries()]
    .filter(([key]) => !currentStableKeys.has(key))
    .map(([, row]) => row);
  if (!stale.length) return;
  const protectedKeys = referencedObjectKeys(existing, currentStableKeys);

  // This stage is client-wide: everything absent from THIS run is stale. That authority is correct
  // and is also how a wrong-input run hides every asset a client owns (F-9), so the ratio is checked
  // against what the run actually wrote before anything is marked.
  const verdict = assessFreshDestruction({
    unit: 'row(s)', doomed: stale.length,
    written: result.created + result.updated,
    allowLarge: allowLargeDeletions,
    sourceFresh,
    source: 'the source asset scan',
  });
  appendLog(verdict.blocked ? 'error' : 'dim', verdict.message);
  if (verdict.blocked) return;

  if (dryRun) {
    appendLog('dim', `  [DRY] would mark ${stale.length} stable record(s) disconnected`);
    result.disconnected += stale.length;
    appendStaleObjectKeys(stale, clientId, protectedKeys, result);
    return;
  }

  const disconnected: StableRow[] = [];
  for (let i = 0; i < stale.length; i += BATCH) {
    if (shouldStop?.()) return;
    const batch = stale.slice(i, i + BATCH);
    try {
      const res = await sbFetch(`${base}/assets?id=in.(${batch.map(r => r.id).join(',')})`, {
        method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'disconnected' }),
      });
      if (!res.ok) appendLog('error', `  ✕  Stable stale-mark failed: ${await res.text()}`);
      else {
        appendLog('dim', `  ⦾  Marked ${batch.length} stable record(s) disconnected (folder/file no longer on disk)`);
        result.disconnected += batch.length;
        disconnected.push(...batch);
      }
    } catch (e) { appendLog('error', `  ✕  Stable stale-mark error: ${e}`); }
  }

  // Never delete bytes for a row whose status update failed: it may still be visible in the portal.
  appendStaleObjectKeys(disconnected, clientId, protectedKeys, result);
}
