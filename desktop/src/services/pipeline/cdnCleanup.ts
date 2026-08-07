/* Targeted CDN cleanup, driven by the stale list returned by the Supabase sync. */

import { invoke } from '@tauri-apps/api/core';
import { assessDestruction } from '../guardrail';
import type { R2Config } from './types';
import { timePhase } from './timing';

/* ── Targeted CDN deletion — called after Supabase sync with the stale list ─ */

export async function deleteCdnObjects(
  r2:         R2Config,
  objectKeys: string[],
  appendLog:  (type: string, msg: string) => void,
  written = 0,
  allowLargeDeletions = false,
  dryRun = false,
  shouldStop?: () => boolean,
): Promise<void> {
  if (!objectKeys.length) return;
  const phase = timePhase('CDN DELETE');
  appendLog('section', '━━━ CDN DELETE ━━━');

  // Unlike a disconnected row, a deleted object is GONE — there is no soft form of this stage. The
  // stale list comes from the same Supabase diff that drives the disconnect, so it inherits the same
  // failure mode and gets the same tripwire.
  const verdict = assessDestruction({
    unit: 'CDN object(s)', doomed: objectKeys.length, written, allowLarge: allowLargeDeletions,
  });
  appendLog(verdict.blocked ? 'error' : 'dim', verdict.message);
  if (verdict.blocked) {
    appendLog('section', '━━━ CDN DELETE SKIPPED ━━━');
    phase.done();
    return;
  }
  if (dryRun) {
    for (const objectKey of objectKeys) appendLog('dim', `  [DRY] would remove: ${objectKey}`);
    appendLog('section', `━━━ CDN DELETE DRY RUN — ${objectKeys.length} object(s) retained ━━━`);
    phase.done();
    return;
  }
  let removed = 0;
  let errors  = 0;
  for (const objectKey of objectKeys) {
    if (shouldStop?.()) return;
    /* Which bucket holds it is readable from the key: a leading level segment means the gated
       tier, anything else is public. Deleting from the wrong bucket does not fail loudly — the
       object simply is not there — so a hardcoded `r2.bucket` would leave every withdrawn gated
       object in place forever while reporting a clean removal. */
    const gated = /^(guest|client|internal)\//.test(objectKey);
    const target = gated
      ? { bucket: r2.gatedBucket, accessKeyId: r2.gatedAccessKeyId,
          secretKey: r2.gatedSecretKey, sessionToken: r2.gatedSessionToken }
      : { bucket: r2.bucket, accessKeyId: r2.accessKeyId,
          secretKey: r2.secretKey, sessionToken: r2.sessionToken };
    try {
      await invoke('delete_r2_object', {
        endpoint: r2.endpoint,
        ...target,
        objectKey,
      });
      appendLog('dim', `  ↷  removed: ${objectKey}`);
      removed += 1;
    } catch (e) {
      appendLog('error', `  ✕  Failed to remove ${objectKey}: ${e}`);
      errors += 1;
    }
  }
  appendLog('section', `━━━ CDN DELETE DONE — ${removed} removed · ${errors} errors ━━━ in ${phase.done()}`);
}
