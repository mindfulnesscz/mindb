/* CDN cleanup — delete objects that no longer correspond to a live asset.
 *
 * reconcileCdn computes the keys that SHOULD exist and deletes the rest, so it refuses to run at
 * all when no identity resolved — otherwise every object would look stale and be deleted. It must
 * mirror cdnUpload's key construction exactly; that is why both call cdnStemKey.
 * 
 * deleteCdnObjects is the targeted path, driven by the stale list the Supabase sync returns.
 */

import { invoke } from '@tauri-apps/api/core';
import { assessDestruction } from '../guardrail';
import type { RunContext, RunStats, R2Config } from './types';
import { cdnStemKey } from '../supabaseService';
import { storageKey } from './storageKey';

/* ── CDN cleanup — remove stale thumbnails from R2 ─────────────────────── */

/** Full R2 reconcile — lists all objects and deletes stale ones. Use manually when DB is out of
 * sync. Not currently wired to any UI action. Requires `ctx.cdnIdentity` to be populated by a
 * prior `resolveCdnIdentity` call on the same ctx — without it nothing is considered expected,
 * and every object would look stale. */
export async function reconcileCdn(ctx: RunContext, stats: RunStats): Promise<void> {
  const { r2, appendLog, collectedAssets } = ctx;
  if (!r2) return;

  appendLog('section', '━━━ CDN CLEANUP ━━━');

  // Keys that should exist — one per collected asset, mirroring runCdnUpload's key logic
  // exactly so this never mistakes a current object for a stale one.
  if (!ctx.cdnIdentity?.size) {
    appendLog('error', '  ✕  No CDN identity resolved — refusing to reconcile (every object would look stale).');
    return;
  }
  const expectedKeys = new Set(
    (collectedAssets ?? []).flatMap(srcPath => {
      const identity = ctx.cdnIdentity?.get(cdnStemKey(srcPath));
      return identity
        ? [storageKey(r2.keyPrefix, `thumbnails/${identity.stableId}/${identity.childId}.webp`)]
        : [];
    }),
  );

  let allKeys: string[];
  try {
    allKeys = await invoke<string[]>('list_r2_keys', {
      endpoint:     r2.endpoint,
      bucket:       r2.bucket,
      accessKeyId:  r2.accessKeyId,
      secretKey:    r2.secretKey,
          sessionToken: r2.sessionToken,
      prefix:       storageKey(r2.keyPrefix, 'thumbnails/'),
    });
  } catch (e) {
    appendLog('error', `  ✕  Could not list R2 objects: ${e}`);
    return;
  }

  const stale = allKeys.filter(k => !expectedKeys.has(k));

  if (!stale.length) {
    appendLog('dim', `  ✓  Nothing to remove (${allKeys.length} object(s) current)`);
    return;
  }

  appendLog('info', `  ${stale.length} stale thumbnail(s) to remove…`);
  let removed = 0;
  let errors  = 0;

  for (const objectKey of stale) {
    try {
      await invoke('delete_r2_object', {
        endpoint:     r2.endpoint,
        bucket:       r2.bucket,
        accessKeyId:  r2.accessKeyId,
        secretKey:    r2.secretKey,
          sessionToken: r2.sessionToken,
        objectKey,
      });
      appendLog('dim', `  ↷  removed: ${objectKey}`);
      removed += 1;
    } catch (e) {
      appendLog('error', `  ✕  Failed to remove ${objectKey}: ${e}`);
      errors += 1;
      stats.errors += 1;
    }
  }

  appendLog('section', `━━━ CDN CLEANUP DONE — ${removed} removed · ${errors} errors ━━━`);
}

/* ── Targeted CDN deletion — called after Supabase sync with the stale list ─ */

export async function deleteCdnObjects(
  r2:         R2Config,
  objectKeys: string[],
  appendLog:  (type: string, msg: string) => void,
  written = 0,
  allowLargeDeletions = false,
): Promise<void> {
  if (!objectKeys.length) return;
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
    return;
  }
  let removed = 0;
  let errors  = 0;
  for (const objectKey of objectKeys) {
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
  appendLog('section', `━━━ CDN DELETE DONE — ${removed} removed · ${errors} errors ━━━`);
}

