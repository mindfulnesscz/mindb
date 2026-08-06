/* Ask the backend to move any asset whose bytes no longer sit at the key its level requires.
 *
 * A pipeline run changes `status` — it publishes new rows, and soft-disconnects assets whose file
 * left the disk — and `status` is half of the access level. A disconnected asset drops to
 * `internal`, so its bytes must leave whatever level they were serving from. A database trigger
 * queues that work; this drains it at the end of a run.
 *
 * Best-effort, and never allowed to fail a run: the queue is durable, so a failure here delays the
 * move rather than losing it. Reporting a successful publish as failed because a follow-up call
 * timed out would be the worse error.
 */

import type { SupabaseConfig } from './rest';
import { makeHeaders, sbFetch } from './rest';

/** One asset the reconcile could not finish, and why. Absent on a pre-3.2.2 backend. */
export interface ReconcileFailure {
  asset_id: string;
  stage: 'thumbnail_url' | 'download_url' | 'stream' | 'page' | 'database';
  reason: string;
}

interface ReconcileResult {
  moved: number;
  skipped: number;
  failed: number;
  remaining: number;
  failures?: ReconcileFailure[];
}

/** How many per-asset reasons to print before collapsing the rest into a count. */
const MAX_REPORTED = 5;

/**
 * Turn the response's failure list into log lines.
 *
 * Identical reasons are grouped: a missing `CF_STREAM_TOKEN` fails every video in the batch, and
 * twenty-five copies of one sentence buries the run log rather than explaining it.
 */
export function describeReconcileFailures(failures: ReconcileFailure[]): string[] {
  const byReason = new Map<string, string[]>();
  for (const f of failures) {
    const line = `${f.stage}: ${f.reason}`;
    byReason.set(line, [...(byReason.get(line) ?? []), f.asset_id]);
  }

  const lines: string[] = [];
  for (const [reason, ids] of [...byReason].slice(0, MAX_REPORTED)) {
    lines.push(ids.length === 1
      ? `      ↳ ${ids[0]} — ${reason}`
      : `      ↳ ${ids.length} assets — ${reason}`);
  }
  const hidden = byReason.size - Math.min(byReason.size, MAX_REPORTED);
  if (hidden > 0) lines.push(`      ↳ …and ${hidden} more distinct reason(s)`);
  return lines;
}

export async function reconcileCdnObjects(
  config:    SupabaseConfig,
  appendLog: (type: string, msg: string) => void,
): Promise<void> {
  try {
    const res = await sbFetch(`${config.url}/functions/v1/cdn-reconcile`, {
      method:  'POST',
      headers: await makeHeaders(config.anonKey),
      body:    '{}',
    });
    if (!res.ok) {
      // 503 means the environment has no gated tier configured, which is a setup gap rather than a
      // run failure — say so plainly instead of leaving a bare status code in the log.
      const detail = res.status === 503
        ? 'gated storage not provisioned for this environment'
        : await res.text();
      appendLog('dim', `  ⦾  CDN reconcile skipped (${res.status}): ${detail}`);
      return;
    }
    const r = await res.json<ReconcileResult>();
    if (r.moved || r.failed || r.remaining) {
      appendLog('dim', `  ⟳  CDN reconcile — ${r.moved} moved · ${r.failed} failed · ${r.remaining} still queued`);
    }
    /* The summary alone sent people to the Supabase dashboard's function logs, which is exactly
       where a desktop user cannot go mid-run. `warn`, not `dim`: a failure here means bytes and
       access level disagree, which is a security-relevant state, not housekeeping noise. */
    if (r.failures?.length) {
      for (const line of describeReconcileFailures(r.failures)) appendLog('warn', line);
    } else if (r.failed) {
      // Older backend, or a failure the function did not attribute — say which, so the missing
      // detail does not read as "no reason available".
      appendLog('warn', '      ↳ no per-asset reasons returned — check the cdn-reconcile function logs');
    }
  } catch (e) {
    appendLog('dim', `  ⦾  CDN reconcile unavailable: ${e}`);
  }
}
