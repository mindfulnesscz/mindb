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

interface ReconcileResult { moved: number; skipped: number; failed: number; remaining: number }

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
  } catch (e) {
    appendLog('dim', `  ⦾  CDN reconcile unavailable: ${e}`);
  }
}
