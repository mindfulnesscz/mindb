/* Stage 4 — soft-disconnect rows whose file left the disk.
 *
 * SOFT, always. A row carries the asset's ratings, comments, approvals and view/download events;
 * deleting it would take those with it, and a transient disk change (an unmounted drive, a folder
 * being reorganised) must never be able to do that. The row is marked `disconnected` and the CDN
 * keys are merely REPORTED, so object deletion stays a separate, explicit action.
 */

import { sbFetch, BATCH } from './rest';
import type { StableRow, SupabaseExportResult } from './exportTypes';

export async function disconnectStaleRows(
  existing: Map<string, StableRow>,
  currentStableKeys: Set<string>,
  base: string,
  headers: Record<string, string>,
  result: SupabaseExportResult,
  appendLog: (type: string, msg: string) => void,
): Promise<void> {
  const stale = [...existing.entries()]
    .filter(([key]) => !currentStableKeys.has(key))
    .map(([, row]) => row);
  if (!stale.length) return;

  for (let i = 0; i < stale.length; i += BATCH) {
    const batch = stale.slice(i, i + BATCH);
    try {
      const res = await sbFetch(`${base}/assets?id=in.(${batch.map(r => r.id).join(',')})`, {
        method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'disconnected' }),
      });
      if (!res.ok) appendLog('error', `  ✕  Stable stale-mark failed: ${await res.text()}`);
      else {
        appendLog('dim', `  ⦾  Marked ${batch.length} stable record(s) disconnected (folder/file no longer on disk)`);
        result.disconnected += batch.length;
      }
    } catch (e) { appendLog('error', `  ✕  Stable stale-mark error: ${e}`); }
  }

  result.staleObjectKeys.push(...stale.map(r => r.download_key).filter(Boolean) as string[]);
}
