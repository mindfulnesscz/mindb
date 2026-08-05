/* Stage 4 — soft-disconnect rows whose file left the disk.
 *
 * SOFT, always. A row carries the asset's ratings, comments, approvals and view/download events;
 * deleting it would take those with it, and a transient disk change (an unmounted drive, a folder
 * being reorganised) must never be able to do that. The row is marked `disconnected` and the CDN
 * keys are merely REPORTED, so object deletion stays a separate, explicit action.
 */

import { sbFetch, BATCH } from './rest';
import { assessFreshDestruction } from '../guardrail';
import type { StableRow, SupabaseExportResult } from './exportTypes';

export async function disconnectStaleRows(
  existing: Map<string, StableRow>,
  currentStableKeys: Set<string>,
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
    result.staleObjectKeys.push(...stale.map(r => r.download_key).filter(Boolean) as string[]);
    return;
  }

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
      }
    } catch (e) { appendLog('error', `  ✕  Stable stale-mark error: ${e}`); }
  }

  result.staleObjectKeys.push(...stale.map(r => r.download_key).filter(Boolean) as string[]);
}
