/* CDN cleanup — delete objects that no longer correspond to a live asset.
 *
 * reconcileCdn computes the keys that SHOULD exist and deletes the rest, so it refuses to run at
 * all when no identity resolved — otherwise every object would look stale and be deleted. It must
 * mirror cdnUpload's key construction exactly; that is why both call cdnStemKey.
 * 
 * deleteCdnObjects is the targeted path, driven by the stale list the Supabase sync returns.
 */

import { invoke } from '@tauri-apps/api/core';
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
): Promise<void> {
  if (!objectKeys.length) return;
  appendLog('section', '━━━ CDN DELETE ━━━');
  let removed = 0;
  let errors  = 0;
  for (const objectKey of objectKeys) {
    try {
      await invoke('delete_r2_object', {
        endpoint:    r2.endpoint,
        bucket:      r2.bucket,
        accessKeyId: r2.accessKeyId,
        secretKey:   r2.secretKey,
      sessionToken: r2.sessionToken,
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

