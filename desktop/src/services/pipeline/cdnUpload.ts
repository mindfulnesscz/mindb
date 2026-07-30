/* CDN upload stages — thumbnails and originals.
 *
 * An R2 object key is a PERMANENT PUBLIC ADDRESS: the portal stores it and browsers cache it.
 * Keys are built from folder identity (stable_id/child_id), never from the filename, so renaming a
 * file or bumping its version keeps the same address instead of orphaning the old object.
 * 
 * Identity is looked up by ABSOLUTE PATH (thumbnails by directory+stem, since one thumbnail serves
 * every extension variant). A filename-keyed lookup used to collide across packages holding the
 * same filename, uploading both files over one key — F-5, fixed and regression-tested.
 * 
 * An asset with no folder identity is REPORTED, never uploaded under an invented key.
 */

import { stat } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { filterHighestVersions } from '@dc-hub/domain';
import type { RunContext, RunStats } from './types';
import { cdnStemKey } from '../supabaseService';
import { storageKey } from './storageKey';
import { loadR2Cache, saveR2Cache, r2CacheKey, rememberR2Upload, r2PublicUrl } from './r2Cache';

export async function fetchR2KeyManifest(
  r2: NonNullable<RunContext['r2']>, prefix: string,
  appendLog: RunContext['appendLog'],
): Promise<Set<string> | null> {
  try {
    const keys = await invoke<string[]>('list_r2_keys', {
      endpoint:    r2.endpoint,
      bucket:      r2.bucket,
      accessKeyId: r2.accessKeyId,
      secretKey:   r2.secretKey,
      sessionToken: r2.sessionToken,
      prefix,
    });
    return new Set(keys);
  } catch (e) {
    appendLog('dim', `  R2 inventory list failed (${e}) — falling back to per-file checks`);
    return null;
  }
}

/* CDN uploads publish one object per logical asset under a version-stable key —
   feeding several version files of the same asset into them makes each overwrite
   the others under that one key, re-uploading forever. Old versions belong in
   versions/, but when they sit in OUT keep only the highest per base+ext. Grouped
   per directory, since base names can legitimately repeat across packages. */
export function filterCdnEligible(paths: string[]): { kept: string[]; dropped: number } {
  const byDir = new Map<string, string[]>();
  for (const p of paths) {
    const dir = p.substring(0, p.lastIndexOf('/') + 1);
    const list = byDir.get(dir) ?? [];
    list.push(p);
    byDir.set(dir, list);
  }
  const kept: string[] = [];
  for (const ps of byDir.values()) {
    const keep = new Set(filterHighestVersions(ps.map(p => p.split('/').pop()!)));
    kept.push(...ps.filter(p => keep.has(p.split('/').pop()!)));
  }
  return { kept, dropped: paths.length - kept.length };
}

/* ── CDN thumbnail upload ───────────────────────────────────────────────── */

export async function runCdnUpload(ctx: RunContext, stats: RunStats): Promise<void> {
  const { r2, appendLog, collectedAssets } = ctx;
  if (!r2?.endpoint || !r2.accessKeyId || !r2.secretKey || !r2.bucket || !r2.publicDomain) {
    appendLog('error', '  CDN config incomplete — skipping upload.');
    return;
  }

  appendLog('section', '━━━ CDN UPLOAD ━━━');

  const { kept: cdnAssets, dropped: olderVersions } = filterCdnEligible(collectedAssets ?? []);
  if (olderVersions > 0) appendLog('skip', `  ⊘  ${olderVersions} older version file(s) excluded from CDN`);
  const thumbFiles = cdnAssets.map(srcPath => {
    const fileName = srcPath.split('/').pop()!;
    const stem     = fileName.substring(0, fileName.lastIndexOf('.'));
    const dir      = srcPath.substring(0, srcPath.lastIndexOf('/') + 1);
    return { thumbPath: `${dir}${stem}-thumb.webp`, stem, srcPath };
  });

  if (!thumbFiles.length) {
    appendLog('dim', '  No assets to upload.');
    return;
  }

  let uploaded = 0;
  let skipped  = 0; // no local thumb file, or already known uploaded per DB inventory
  let cached   = 0; // local mtime+size match last upload — skipped without hashing or a network call
  let deduped  = 0; // attempted, but R2 already had this exact content (content-hash match)
  let errors   = 0;
  let uploadLogged = 0;

  const r2Cache = await loadR2Cache();
  let r2CacheDirty = false;
  const remoteKeys = await fetchR2KeyManifest(r2, storageKey(r2.keyPrefix, 'thumbnails/'), appendLog);

  const CONCURRENCY = 8;
  for (let i = 0; i < thumbFiles.length; i += CONCURRENCY) {
    const batch = thumbFiles.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ thumbPath, stem, srcPath }) => {
      // Check thumbnail exists locally before attempting upload
      let thumbInfo;
      try { thumbInfo = await stat(thumbPath); } catch {
        skipped += 1;
        return;
      }
      const fileName = thumbPath.split('/').pop()!;
      // Directory-scoped stem key: one thumbnail per stem, but never shared across
      // packages that happen to hold the same filename (F-5).
      const identity = ctx.cdnIdentity?.get(cdnStemKey(srcPath));
      if (!identity) {
        // No folder identity means no rename-proof key to store this under. Uploading it
        // under its filename would strand the object the moment the file is renamed, so
        // the asset is reported instead.
        appendLog('error', `  ✕  ${fileName} — no folder identity (missing " __<hash>" package folder). Skipped.`);
        errors += 1;
        stats.errors += 1;
        return;
      }
      const objectKey = storageKey(r2.keyPrefix, `thumbnails/${identity.stableId}/${identity.childId}.webp`);

      // Cheap local check (mtime+size, no file read/hash/network) before the real thing.
      // A manifest that says the key is gone from R2 overrides the cache — re-upload.
      // Do NOT skip just because DB already has a URL — version bumps overwrite the same
      // key; we still need a fresh ?v= hash in cdnUrls for browser cache busting.
      const cacheKey = r2CacheKey(r2.bucket, objectKey);
      const cacheEntry = r2Cache[cacheKey];
      const mtimeMs = thumbInfo.mtime?.getTime() ?? -1;
      if (cacheEntry && cacheEntry.size === thumbInfo.size && cacheEntry.mtimeMs === mtimeMs
          && remoteKeys?.has(objectKey) !== false) {
        if (ctx.cdnUrls) {
          ctx.cdnUrls.set(srcPath, r2PublicUrl(r2.publicDomain, objectKey, cacheEntry.sha256));
        }
        cached += 1;
        stats.cdnThumbCached += 1;
        return;
      }

      if (uploadLogged < 3) {
        appendLog('dim', `  miss: "${stem}"`);
        uploadLogged++;
      }
      try {
        const result = await invoke<{ url: string; skipped: boolean; sha256: string }>('upload_to_r2', {
          filePath:     thumbPath,
          objectKey,
          endpoint:     r2.endpoint,
          bucket:       r2.bucket,
          accessKeyId:  r2.accessKeyId,
          secretKey:    r2.secretKey,
          sessionToken: r2.sessionToken,
          publicDomain: r2.publicDomain,
          contentType:  'image/webp',
          remoteExists: remoteKeys ? remoteKeys.has(objectKey) : null,
          knownSha256:  cacheEntry && cacheEntry.size === thumbInfo.size ? cacheEntry.sha256 : null,
        });
        if (ctx.cdnUrls) ctx.cdnUrls.set(srcPath, result.url);
        rememberR2Upload(r2Cache, r2.bucket, objectKey, mtimeMs, thumbInfo.size, result.sha256);
        r2CacheDirty = true;
        remoteKeys?.add(objectKey);
        if (result.skipped) {
          appendLog('dim', `  ↷  unchanged, skipped: ${fileName}`);
          deduped += 1;
          stats.cdnThumbUnchanged += 1;
        } else {
          appendLog('success', `  ✓  ${fileName} → ${objectKey}`);
          uploaded += 1;
          stats.cdnThumbUploaded += 1;
        }
      } catch (e) {
        appendLog('error', `  ✕  ${fileName} — ${e}`);
        errors += 1;
        stats.errors += 1;
      }
    }));
  }

  if (r2CacheDirty) await saveR2Cache(r2Cache);

  appendLog('section',
    `━━━ CDN DONE — ${uploaded} uploaded · ${cached} cached · ${deduped} unchanged · ${skipped} no thumb · ${errors} errors ━━━`,
  );
}

/* ── Original-file CDN upload — content-hash deduped, version/rename-stable key ──
   Keyed by stable identity (stableId/childId), which survives file and folder renames
   (see resolveCdnIdentity), so a new version's upload overwrites the last one's key
   rather than accumulating. upload_to_r2 only actually re-uploads when the file's
   content hash differs from what's already stored — unchanged re-runs are skipped. A
   small per-asset cleanup below handles the rare case where a content-hash mismatch
   under the same key changes the file extension. */
export async function runOriginalUpload(ctx: RunContext, stats: RunStats): Promise<void> {
  const { r2, appendLog, collectedAssets } = ctx;
  if (!r2?.endpoint || !r2.accessKeyId || !r2.secretKey || !r2.bucket || !r2.publicDomain) {
    appendLog('error', '  CDN config incomplete — skipping original upload.');
    return;
  }

  appendLog('section', '━━━ CDN ORIGINALS UPLOAD ━━━');

  const { kept: cdnAssets, dropped: olderVersions } = filterCdnEligible(collectedAssets ?? []);
  if (olderVersions > 0) appendLog('skip', `  ⊘  ${olderVersions} older version file(s) excluded from CDN`);
  const files = cdnAssets.map(srcPath => {
    const fileName  = srcPath.split('/').pop()!;
    const dotIdx    = fileName.lastIndexOf('.');
    const ext       = dotIdx > 0 ? fileName.slice(dotIdx) : '';
    const stem      = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
    return { srcPath, stem, ext };
  });

  if (!files.length) {
    appendLog('dim', '  No assets to upload.');
    return;
  }

  let uploaded = 0;
  let cached   = 0; // local mtime+size match last upload — skipped without hashing or a network call
  let deduped  = 0; // attempted, but R2 already had this exact content (content-hash match)
  let errors   = 0;

  const r2Cache = await loadR2Cache();
  let r2CacheDirty = false;
  const remoteKeys = await fetchR2KeyManifest(r2, storageKey(r2.keyPrefix, 'originals/'), appendLog);

  // Identity by full filename first — extension-only variants (foo.pdf + foo.webp) share a
  // stem but carry distinct child ids in the manifest.
  const withKeys = files.flatMap(f => {
    // Per-FILE identity, keyed by absolute path: extension variants of a stem carry
    // distinct child ids, and two packages may hold the same filename (F-5).
    const identity = ctx.cdnIdentity?.get(f.srcPath);
    if (!identity) {
      appendLog('error', `  ✕  ${f.stem}${f.ext} — no folder identity (missing " __<hash>" package folder). Skipped.`);
      errors += 1;
      stats.errors += 1;
      return [];
    }
    const keyPrefix = storageKey(r2.keyPrefix, `originals/${identity.stableId}/${identity.childId}`);
    return [{ ...f, keyPrefix, objectKey: `${keyPrefix}${f.ext}` }];
  });
  // Keys claimed by any file this run — the stale-sibling cleanup must never delete
  // these, or two files sharing a key prefix would destroy each other's upload.
  const plannedKeys = new Set(withKeys.map(f => f.objectKey));

  const CONCURRENCY = 8;
  for (let i = 0; i < withKeys.length; i += CONCURRENCY) {
    const batch = withKeys.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ srcPath, stem, ext, keyPrefix, objectKey }) => {

      // Cheap local check (mtime+size, no file read/hash/network) before the real thing.
      let srcInfo;
      try { srcInfo = await stat(srcPath); } catch (e) {
        appendLog('error', `  ✕  ${stem}${ext} — ${e}`);
        errors += 1;
        stats.errors += 1;
        return;
      }
      const cacheKey = r2CacheKey(r2.bucket, objectKey);
      const cacheEntry = r2Cache[cacheKey];
      const mtimeMs = srcInfo.mtime?.getTime() ?? -1;
      if (cacheEntry && cacheEntry.size === srcInfo.size && cacheEntry.mtimeMs === mtimeMs
          && remoteKeys?.has(objectKey) !== false) {
        // Supabase sync writes download_url from ctx.originalUrls — there is no DB
        // pre-population for originals, so skipping without setting the map would
        // null the column on the next sync (the web portal's download button).
        if (ctx.originalUrls) {
          ctx.originalUrls.set(srcPath, r2PublicUrl(r2.publicDomain, objectKey, cacheEntry.sha256));
        }
        cached += 1;
        stats.cdnOrigCached += 1;
        return;
      }

      try {
        const result = await invoke<{ url: string; skipped: boolean; sha256: string }>('upload_to_r2', {
          filePath:     srcPath,
          objectKey,
          endpoint:     r2.endpoint,
          bucket:       r2.bucket,
          accessKeyId:  r2.accessKeyId,
          secretKey:    r2.secretKey,
          sessionToken: r2.sessionToken,
          publicDomain: r2.publicDomain,
          contentType:  mimeFromExt(ext),
          remoteExists: remoteKeys ? remoteKeys.has(objectKey) : null,
          knownSha256:  cacheEntry && cacheEntry.size === srcInfo.size ? cacheEntry.sha256 : null,
        });
        // Keyed by absolute path, so extension variants and same-named files in other
        // packages each record their own URL instead of racing for one key.
        if (ctx.originalUrls) ctx.originalUrls.set(srcPath, result.url);
        rememberR2Upload(r2Cache, r2.bucket, objectKey, mtimeMs, srcInfo.size, result.sha256);
        r2CacheDirty = true;
        remoteKeys?.add(objectKey);

        // Safety net: if a version bump (or a genuine content change under stable
        // identity) changed the extension, remove the stale sibling object so it
        // doesn't linger under the same key prefix. With a manifest this is decided
        // locally; without one, the LIST round-trip is only worth it after a real upload.
        try {
          const siblingKeys = remoteKeys
            ? [...remoteKeys].filter(k => k.startsWith(`${keyPrefix}.`))
            : result.skipped ? [] : await invoke<string[]>('list_r2_keys', {
                endpoint:     r2.endpoint,
                bucket:       r2.bucket,
                accessKeyId:  r2.accessKeyId,
                secretKey:    r2.secretKey,
          sessionToken: r2.sessionToken,
                prefix:       `${keyPrefix}.`,
              });
          for (const staleKey of siblingKeys.filter(k => k !== objectKey && !plannedKeys.has(k))) {
            await invoke('delete_r2_object', {
              endpoint: r2.endpoint, bucket: r2.bucket,
              accessKeyId: r2.accessKeyId, secretKey: r2.secretKey, sessionToken: r2.sessionToken, objectKey: staleKey,
            });
            remoteKeys?.delete(staleKey);
            appendLog('dim', `  ↷  removed stale original: ${staleKey}`);
          }
        } catch { /* best-effort cleanup — never fails the run */ }

        if (result.skipped) {
          appendLog('dim', `  ↷  unchanged, skipped: ${stem}${ext}`);
          deduped += 1;
          stats.cdnOrigUnchanged += 1;
        } else {
          appendLog('success', `  ✓  ${stem}${ext} → ${objectKey}`);
          uploaded += 1;
          stats.cdnOrigUploaded += 1;
        }
      } catch (e) {
        appendLog('error', `  ✕  ${stem}${ext} — ${e}`);
        errors += 1;
        stats.errors += 1;
      }
    }));
  }

  if (r2CacheDirty) await saveR2Cache(r2Cache);

  appendLog('section', `━━━ CDN ORIGINALS DONE — ${uploaded} uploaded · ${cached} cached · ${deduped} unchanged · ${errors} errors ━━━`);
}


export function mimeFromExt(ext: string): string {
  const m: Record<string, string> = {
    '.pdf':  'application/pdf',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.pptm': 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
    '.ppt':  'application/vnd.ms-powerpoint',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.mp4':  'video/mp4',
    '.mov':  'video/quicktime',
    '.svg':  'image/svg+xml',
    '.ai':   'application/postscript',
    '.eps':  'application/postscript',
    '.zip':  'application/zip',
  };
  return m[ext.toLowerCase()] ?? 'application/octet-stream';
}

