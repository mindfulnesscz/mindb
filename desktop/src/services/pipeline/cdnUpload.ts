/* CDN upload stages — thumbnails, per-page previews, and originals.
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

import { stat, readTextFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import {
  filterHighestVersions, storageTarget, assetUrl, tierFor,
  pageTarget, pagePrefix, pageObjectName, type AccessLevel, type ObjectKind,
} from '@sotto/domain';
import type { RunContext, RunStats } from './types';
import { cdnStemKey } from '../supabaseService';
import { loadR2Cache, saveR2Cache, r2CacheKey, rememberR2Upload } from './r2Cache';
import { PAGE_PREVIEW_EXTS, extensionOf } from './naming';

/* The level a brand-new asset is written at. Must equal the create-time default the export stage
   uses (PIPELINE_DEFAULT_PERM='client' at status 'published'), or an asset's bytes would land at
   one level while its row claims another — the object key IS the authorization, so that
   disagreement is a 403 on a file the portal is offering. */
const NEW_ASSET_LEVEL: AccessLevel = 'client';

/* Every level an object could be sitting under. Used when sweeping stale objects: after a level
   change the old ones are under a DIFFERENT prefix, so a single-level search would miss them and
   leave a narrowed asset's bytes readable at its old, wider address. */
const ALL_LEVELS: readonly AccessLevel[] = ['public', 'guest', 'client', 'internal'];

interface CdnIdentity {
  stableId: string;
  childId: string;
}

/** Everything an upload needs to reach the right bucket, resolved per asset from its level. */
function routeFor(r2: NonNullable<RunContext['r2']>, level: AccessLevel, kind: 'thumbnails' | 'originals',
                  stableId: string, childId: string, ext: string) {
  const target = storageTarget(level, r2.clientId, kind, stableId, childId, ext);
  return target.tier === 'public'
    ? { ...target, bucket: r2.bucket, domain: r2.publicDomain,
        accessKeyId: r2.accessKeyId, secretKey: r2.secretKey, sessionToken: r2.sessionToken }
    : { ...target, bucket: r2.gatedBucket, domain: r2.gatedDomain,
        accessKeyId: r2.gatedAccessKeyId, secretKey: r2.gatedSecretKey, sessionToken: r2.gatedSessionToken };
}

/** The level this asset's bytes belong at. Absent from the map means the row does not exist yet. */
function levelOf(ctx: RunContext, stableId: string, childId: string): AccessLevel {
  return (ctx.assetLevels?.get(`${stableId}:${childId}`) as AccessLevel | undefined) ?? NEW_ASSET_LEVEL;
}

function bucketForLevel(r2: NonNullable<RunContext['r2']>, level: AccessLevel) {
  return tierFor(level) === 'public'
    ? { bucket: r2.bucket, accessKeyId: r2.accessKeyId, secretKey: r2.secretKey,
        sessionToken: r2.sessionToken }
    : { bucket: r2.gatedBucket, accessKeyId: r2.gatedAccessKeyId,
        secretKey: r2.gatedSecretKey, sessionToken: r2.gatedSessionToken };
}

interface StaleObject {
  key: string;
  level: AccessLevel;
}

/** Delete one bounded stale object only when no other live row still names it. */
async function pruneStaleObject(
  ctx: RunContext,
  r2: NonNullable<RunContext['r2']>,
  stale: StaleObject,
  identity: CdnIdentity,
  kind: 'thumbnail' | 'original',
  currentKey: string,
  plannedKeys: Set<string>,
): Promise<boolean> {
  if (ctx.isStopping?.() || stale.key === currentKey || plannedKeys.has(stale.key)) return false;

  const owner = `${identity.stableId}:${identity.childId}`;
  const references = ctx.cdnKeyReferences;
  if (!references) {
    ctx.appendLog('dim',
      `  ↷  kept stale ${kind} (was ${stale.level}) — live row references unavailable: ${stale.key}`);
    return false;
  }
  const otherOwners = [...(references.get(stale.key) ?? [])].filter(candidate => candidate !== owner);
  if (otherOwners.length) {
    ctx.appendLog('dim',
      `  ↷  kept shared stale ${kind} (was ${stale.level}; referenced by ${otherOwners.join(', ')}): ${stale.key}`);
    return false;
  }

  if (ctx.settings.dryRun) {
    ctx.appendLog('dim', `  [DRY] would prune stale ${kind} (was ${stale.level}): ${stale.key}`);
    return false;
  }

  const from = bucketForLevel(r2, stale.level);
  try {
    await invoke('delete_r2_object', {
      endpoint: r2.endpoint, bucket: from.bucket,
      accessKeyId: from.accessKeyId, secretKey: from.secretKey,
      sessionToken: from.sessionToken, objectKey: stale.key,
    });
    ctx.appendLog('dim', `  ↷  pruned stale ${kind} (was ${stale.level}): ${stale.key}`);
    return true;
  } catch (e) {
    ctx.appendLog('warn', `  ↷  stale ${kind} prune failed (will retry): ${stale.key} — ${e}`);
    return false;
  }
}

export async function fetchR2KeyManifest(
  r2: NonNullable<RunContext['r2']>, prefix: string,
  appendLog: RunContext['appendLog'],
  bucket = r2.bucket, accessKeyId = r2.accessKeyId,
  secretKey = r2.secretKey, sessionToken = r2.sessionToken,
): Promise<Set<string> | null> {
  try {
    const keys = await invoke<string[]>('list_r2_keys', {
      endpoint:    r2.endpoint,
      bucket,
      accessKeyId,
      secretKey,
      sessionToken,
      prefix,
    });
    return new Set(keys);
  } catch (e) {
    appendLog('dim', `  R2 inventory list failed (${e}) — falling back to per-file checks`);
    return null;
  }
}


/**
 * Which keys already exist, across BOTH tiers.
 *
 * One asset's objects can be in either bucket and under any of three level prefixes, so a manifest
 * of a single prefix would report "absent" for most of them. That errs safely — a false absent
 * causes a re-upload, never a skipped one — but it would re-upload most of the library every run,
 * which is exactly the cost this manifest exists to avoid.
 *
 * A failure in any one listing degrades to per-file checks for everything, matching the old
 * behaviour: null means "no manifest", not "nothing is there".
 */
async function fetchTieredManifest(
  r2: NonNullable<RunContext['r2']>, kind: ObjectKind,
  appendLog: RunContext['appendLog'],
): Promise<Set<string> | null> {
  const listings = await Promise.all([
    fetchR2KeyManifest(r2, `${r2.clientId}/${kind}/`, appendLog,
                       r2.bucket, r2.accessKeyId, r2.secretKey, r2.sessionToken),
    ...(['guest', 'client', 'internal'] as const).map(level =>
      fetchR2KeyManifest(r2, `${level}/${r2.clientId}/${kind}/`, appendLog,
                         r2.gatedBucket, r2.gatedAccessKeyId, r2.gatedSecretKey, r2.gatedSessionToken)),
  ]);
  if (listings.some(l => l === null)) return null;
  const all = new Set<string>();
  for (const l of listings) for (const k of l!) all.add(k);
  return all;
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
  if (ctx.settings.dryRun) {
    appendLog('dim',
      `  [DRY] would upload ${thumbFiles.length} thumbnail(s) and prune stale thumbnail objects`);
    return;
  }

  let uploaded = 0;
  let skipped  = 0; // no local thumb file, or already known uploaded per DB inventory
  let cached   = 0; // local mtime+size match last upload — skipped without hashing or a network call
  let deduped  = 0; // attempted, but R2 already had this exact content (content-hash match)
  let errors   = 0;
  let pruned   = 0;
  let uploadLogged = 0;

  const r2Cache = await loadR2Cache();
  let r2CacheDirty = false;
  const remoteKeys = await fetchTieredManifest(r2, 'thumbnails', appendLog);

  // Every current-level key claimed by this run. A shared thumbnail can appear more than once in
  // thumbFiles (extension variants of one stem); neither copy may prune the other's target.
  const plannedKeys = new Set<string>();
  for (const { srcPath } of thumbFiles) {
    const identity = ctx.cdnIdentity?.get(cdnStemKey(srcPath));
    if (!identity) continue;
    plannedKeys.add(storageTarget(
      levelOf(ctx, identity.stableId, identity.childId),
      r2.clientId, 'thumbnails', identity.stableId, identity.childId, '.webp',
    ).key);
  }
  const pruneTargets = new Map<string, {
    identity: CdnIdentity;
    level: AccessLevel;
    objectKey: string;
  }>();

  const CONCURRENCY = 8;
  for (let i = 0; i < thumbFiles.length; i += CONCURRENCY) {
    if (ctx.isStopping?.()) return;
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
      const level     = levelOf(ctx, identity.stableId, identity.childId);
      const route     = routeFor(r2, level,
                                 'thumbnails', identity.stableId, identity.childId, '.webp');
      const objectKey = route.key;

      // Cheap local check (mtime+size, no file read/hash/network) before the real thing.
      // A manifest that says the key is gone from R2 overrides the cache — re-upload.
      // Do NOT skip just because DB already has a URL — version bumps overwrite the same
      // key; we still need a fresh ?v= hash in cdnUrls for browser cache busting.
      const cacheKey = r2CacheKey(route.bucket, objectKey);
      const cacheEntry = r2Cache[cacheKey];
      const mtimeMs = thumbInfo.mtime?.getTime() ?? -1;
      if (cacheEntry && cacheEntry.size === thumbInfo.size && cacheEntry.mtimeMs === mtimeMs
          && remoteKeys?.has(objectKey) !== false) {
        if (ctx.cdnUrls) {
          ctx.cdnUrls.set(srcPath, assetUrl(route.domain, objectKey, cacheEntry.sha256));
        }
        cached += 1;
        stats.cdnThumbCached += 1;
        pruneTargets.set(`${identity.stableId}:${identity.childId}`,
          { identity, level, objectKey });
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
          bucket:       route.bucket,
          accessKeyId:  route.accessKeyId,
          secretKey:    route.secretKey,
          sessionToken: route.sessionToken,
          publicDomain: route.domain,
          contentType:  'image/webp',
          remoteExists: remoteKeys ? remoteKeys.has(objectKey) : null,
          knownSha256:  cacheEntry && cacheEntry.size === thumbInfo.size ? cacheEntry.sha256 : null,
        });
        if (ctx.cdnUrls) ctx.cdnUrls.set(srcPath, result.url);
        rememberR2Upload(r2Cache, route.bucket, objectKey, mtimeMs, thumbInfo.size, result.sha256);
        r2CacheDirty = true;
        remoteKeys?.add(objectKey);
        pruneTargets.set(`${identity.stableId}:${identity.childId}`,
          { identity, level, objectKey });
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

  /* The reconciler copies/repoints thumbnails on a level change but deliberately keeps the source
     for reversibility. Once this run has confirmed the current object, remove only this identity's
     exact .webp key at each other level. A key referenced by another live row is retained. */
  if (remoteKeys) {
    for (const { identity, level, objectKey } of pruneTargets.values()) {
      if (ctx.isStopping?.()) return;
      const candidates = ALL_LEVELS
        .filter(staleLevel => staleLevel !== level)
        .map(staleLevel => ({
          key: storageTarget(
            staleLevel, r2.clientId, 'thumbnails', identity.stableId, identity.childId, '.webp',
          ).key,
          level: staleLevel,
        }))
        .filter(stale => remoteKeys.has(stale.key));
      for (const stale of candidates) {
        if (await pruneStaleObject(
          ctx, r2, stale, identity, 'thumbnail', objectKey, plannedKeys,
        )) {
          remoteKeys.delete(stale.key);
          pruned += 1;
        }
      }
    }
  }

  if (r2CacheDirty) await saveR2Cache(r2Cache);

  appendLog('section',
    `━━━ CDN DONE — ${uploaded} uploaded · ${cached} cached · ${deduped} unchanged · ${pruned} pruned · ${skipped} no thumb · ${errors} errors ━━━`,
  );
}

/* ── Per-page preview upload ─────────────────────────────────────────────────
   The portal's page viewer reads these; nothing else does. They are excluded from packages and
   target destinations (see isPreviewArtifact), so R2 is the only place they are published.

   Level comes from the SAME lookup thumbnails use. Page previews are derived from the document, so a
   `client` deck whose pages landed under a public key would publish the deck's content. `perm` is
   portal-owned, which is why the database is the only source for it. */

/** What the local renderer left behind for one document, read from its manifest. */
async function readPagesManifest(pagesDir: string): Promise<{ rendered: number; total: number } | null> {
  try {
    const raw = await readTextFile(`${pagesDir}/pages.json`);
    const m = JSON.parse(raw) as { rendered?: number; total?: number };
    if (typeof m.rendered !== 'number' || typeof m.total !== 'number') return null;
    return { rendered: m.rendered, total: m.total };
  } catch {
    // No manifest means no previews for this asset — not an error, most assets have none.
    return null;
  }
}

export async function runPagesUpload(ctx: RunContext, stats: RunStats): Promise<void> {
  const { r2, appendLog, collectedAssets } = ctx;
  if (!r2?.endpoint || !r2.accessKeyId || !r2.secretKey || !r2.gatedBucket) {
    appendLog('error', '  CDN config incomplete — skipping page previews.');
    return;
  }

  appendLog('section', '━━━ CDN PAGE PREVIEWS ━━━');

  const { kept: cdnAssets } = filterCdnEligible(collectedAssets ?? []);

  /* Read manifests from disk rather than trusting a map from the render stage. The upload must be
     correct on a run where thumbnails were skipped entirely — pages.json is the source of truth for
     what exists locally. */
  const docs: Array<{ srcPath: string; pagesDir: string; rendered: number }> = [];
  for (const srcPath of cdnAssets) {
    const fileName = srcPath.split('/').pop()!;
    if (!PAGE_PREVIEW_EXTS.has(extensionOf(fileName))) continue;
    const stem = fileName.slice(0, fileName.lastIndexOf('.'));
    const dir = srcPath.slice(0, srcPath.lastIndexOf('/') + 1);
    const pagesDir = `${dir}${stem}-thumb`;
    const manifest = await readPagesManifest(pagesDir);
    if (manifest && manifest.rendered > 0) {
      docs.push({ srcPath, pagesDir, rendered: manifest.rendered });
    }
  }

  if (!docs.length) {
    appendLog('dim', '  No page previews to upload.');
    return;
  }
  if (ctx.settings.dryRun) {
    const pages = docs.reduce((total, doc) => total + doc.rendered, 0);
    appendLog('dim', `  [DRY] would upload ${pages} page preview(s) and prune stale page objects`);
    return;
  }

  let uploaded = 0, cached = 0, deduped = 0, pruned = 0, errors = 0;
  const r2Cache = await loadR2Cache();
  let r2CacheDirty = false;
  const remoteKeys = await fetchTieredManifest(r2, 'pages', appendLog);

  // One document at a time; its pages go up concurrently. Keeps the burst bounded while still
  // parallelising the many small uploads a multi-page deck produces.
  const CONCURRENCY = 8;
  for (const { srcPath, pagesDir, rendered } of docs) {
    if (ctx.isStopping?.()) return;
    const identity = ctx.cdnIdentity?.get(cdnStemKey(srcPath));
    if (!identity) {
      appendLog('error',
        `  ✕  ${srcPath.split('/').pop()} — no folder identity; page previews skipped.`);
      errors += 1;
      stats.errors += 1;
      continue;
    }
    const level = levelOf(ctx, identity.stableId, identity.childId);
    const tier = tierFor(level);
    const route = tier === 'public'
      ? { bucket: r2.bucket, domain: r2.publicDomain, accessKeyId: r2.accessKeyId,
          secretKey: r2.secretKey, sessionToken: r2.sessionToken }
      : { bucket: r2.gatedBucket, domain: r2.gatedDomain, accessKeyId: r2.gatedAccessKeyId,
          secretKey: r2.gatedSecretKey, sessionToken: r2.gatedSessionToken };

    const pageNumbers = Array.from({ length: rendered }, (_, i) => i + 1);
    const plannedKeys = new Set(
      pageNumbers.map(p => pageTarget(level, r2.clientId, identity.stableId, identity.childId, p).key),
    );

    for (let i = 0; i < pageNumbers.length; i += CONCURRENCY) {
      if (ctx.isStopping?.()) return;
      const batch = pageNumbers.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async page => {
        const localPath = `${pagesDir}/${pageObjectName(page)}`;
        const objectKey = pageTarget(level, r2.clientId, identity.stableId, identity.childId, page).key;
        let info;
        try { info = await stat(localPath); } catch {
          // The manifest promised a page that is not on disk. Rust writes the manifest last, so this
          // should not happen — report it rather than silently publishing a short document.
          appendLog('error', `  ✕  missing page file: ${localPath}`);
          errors += 1;
          stats.errors += 1;
          return;
        }
        const cacheKey = r2CacheKey(route.bucket, objectKey);
        const entry = r2Cache[cacheKey];
        const mtimeMs = info.mtime?.getTime() ?? -1;
        if (entry && entry.size === info.size && entry.mtimeMs === mtimeMs
            && remoteKeys?.has(objectKey) !== false) {
          cached += 1;
          stats.cdnPagesCached += 1;
          return;
        }
        try {
          const result = await invoke<{ url: string; skipped: boolean; sha256: string }>('upload_to_r2', {
            filePath: localPath, objectKey,
            endpoint: r2.endpoint, bucket: route.bucket,
            accessKeyId: route.accessKeyId, secretKey: route.secretKey,
            sessionToken: route.sessionToken, publicDomain: route.domain,
            contentType: 'image/webp',
            remoteExists: remoteKeys ? remoteKeys.has(objectKey) : null,
            knownSha256: entry && entry.size === info.size ? entry.sha256 : null,
          });
          rememberR2Upload(r2Cache, route.bucket, objectKey, mtimeMs, info.size, result.sha256);
          r2CacheDirty = true;
          remoteKeys?.add(objectKey);
          if (result.skipped) { deduped += 1; stats.cdnPagesUnchanged += 1; }
          else { uploaded += 1; stats.cdnPagesUploaded += 1; }
        } catch (e) {
          appendLog('error', `  ✕  ${objectKey} — ${e}`);
          errors += 1;
          stats.errors += 1;
        }
      }));
    }

    /* Prune every page object for this asset that this run did not just write — ACROSS ALL LEVELS.
       Two different problems, one sweep:

       COUNT SHRANK. An edited deck or a lowered page limit leaves objects past the new count. The
       portal renders from its stored page count, so those are invisible locally and would reappear
       if the count later grew back.

       LEVEL CHANGED. This is the security half, and it does not heal itself anywhere else.
       `rekey-gated-objects.mjs` moves objects listed in the `thumbnail_url` / `download_url`
       columns; page previews have no URL column — there is one object per page — so the reconcile
       path never sees them. Narrowing a deck (client → internal) would otherwise leave its pages
       readable under the old `client/` prefix: a leak of the deck's content. The pipeline writes at
       the current level and this sweep removes the rest, which is what keeps the two in step.

       `fetchTieredManifest` already lists all four level prefixes, so the stale keys are in hand.
       Each is deleted from the bucket ITS OWN level implies, not the asset's current one. */
    if (remoteKeys) {
      const staleKeys = ALL_LEVELS.flatMap(l => {
        const prefix = pagePrefix(l, r2.clientId, identity.stableId, identity.childId);
        return [...remoteKeys].filter(k => k.startsWith(prefix) && !plannedKeys.has(k))
          .map(key => ({ key, level: l }));
      });
      for (const { key: staleKey, level: staleLevel } of staleKeys) {
        const from = tierFor(staleLevel) === 'public'
          ? { bucket: r2.bucket, accessKeyId: r2.accessKeyId, secretKey: r2.secretKey,
              sessionToken: r2.sessionToken }
          : { bucket: r2.gatedBucket, accessKeyId: r2.gatedAccessKeyId,
              secretKey: r2.gatedSecretKey, sessionToken: r2.gatedSessionToken };
        try {
          await invoke('delete_r2_object', {
            endpoint: r2.endpoint, bucket: from.bucket,
            accessKeyId: from.accessKeyId, secretKey: from.secretKey,
            sessionToken: from.sessionToken, objectKey: staleKey,
          });
          remoteKeys.delete(staleKey);
          pruned += 1;
          appendLog('dim',
            `  ↷  pruned stale page${staleLevel === level ? '' : ` (was ${staleLevel})`}: ${staleKey}`);
        } catch { /* best-effort — never fails the run */ }
      }
    }
  }

  if (r2CacheDirty) await saveR2Cache(r2Cache);

  appendLog('section',
    `━━━ CDN PAGES DONE — ${uploaded} uploaded · ${cached} cached · ${deduped} unchanged · ${pruned} pruned · ${errors} errors ━━━`);
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
  if (ctx.settings.dryRun) {
    appendLog('dim',
      `  [DRY] would upload ${files.length} original(s), remove stale siblings, and prune stale original objects`);
    return;
  }

  let uploaded = 0;
  let cached   = 0; // local mtime+size match last upload — skipped without hashing or a network call
  let deduped  = 0; // attempted, but R2 already had this exact content (content-hash match)
  let errors   = 0;
  let pruned   = 0;

  const r2Cache = await loadR2Cache();
  let r2CacheDirty = false;
  const remoteKeys = await fetchTieredManifest(r2, 'originals', appendLog);

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
    const level = levelOf(ctx, identity.stableId, identity.childId);
    const route = routeFor(r2, level,
                           'originals', identity.stableId, identity.childId, f.ext);
    // Prefix without the extension — the stale-sibling cleanup below matches on `${prefix}.`
    const keyPrefix = route.key.slice(0, route.key.length - f.ext.length);
    return [{ ...f, identity, level, keyPrefix, objectKey: route.key, route }];
  });
  // Keys claimed by any file this run — the stale-sibling cleanup must never delete
  // these, or two files sharing a key prefix would destroy each other's upload.
  const plannedKeys = new Set(withKeys.map(f => f.objectKey));
  const pruneTargets = new Map<string, {
    identity: CdnIdentity;
    level: AccessLevel;
    ext: string;
    objectKey: string;
  }>();

  const CONCURRENCY = 8;
  for (let i = 0; i < withKeys.length; i += CONCURRENCY) {
    if (ctx.isStopping?.()) return;
    const batch = withKeys.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({
      srcPath, stem, ext, identity, level, keyPrefix, objectKey, route,
    }) => {

      // Cheap local check (mtime+size, no file read/hash/network) before the real thing.
      let srcInfo;
      try { srcInfo = await stat(srcPath); } catch (e) {
        appendLog('error', `  ✕  ${stem}${ext} — ${e}`);
        errors += 1;
        stats.errors += 1;
        return;
      }
      const cacheKey = r2CacheKey(route.bucket, objectKey);
      const cacheEntry = r2Cache[cacheKey];
      const mtimeMs = srcInfo.mtime?.getTime() ?? -1;
      if (cacheEntry && cacheEntry.size === srcInfo.size && cacheEntry.mtimeMs === mtimeMs
          && remoteKeys?.has(objectKey) !== false) {
        // Supabase sync writes download_url from ctx.originalUrls — there is no DB
        // pre-population for originals, so skipping without setting the map would
        // null the column on the next sync (the web portal's download button).
        if (ctx.originalUrls) {
          ctx.originalUrls.set(srcPath, assetUrl(route.domain, objectKey, cacheEntry.sha256));
        }
        cached += 1;
        stats.cdnOrigCached += 1;
        pruneTargets.set(`${identity.stableId}:${identity.childId}`,
          { identity, level, ext, objectKey });
        return;
      }

      try {
        const result = await invoke<{ url: string; skipped: boolean; sha256: string }>('upload_to_r2', {
          filePath:     srcPath,
          objectKey,
          endpoint:     r2.endpoint,
          bucket:       route.bucket,
          accessKeyId:  route.accessKeyId,
          secretKey:    route.secretKey,
          sessionToken: route.sessionToken,
          publicDomain: route.domain,
          contentType:  mimeFromExt(ext),
          remoteExists: remoteKeys ? remoteKeys.has(objectKey) : null,
          knownSha256:  cacheEntry && cacheEntry.size === srcInfo.size ? cacheEntry.sha256 : null,
        });
        // Keyed by absolute path, so extension variants and same-named files in other
        // packages each record their own URL instead of racing for one key.
        if (ctx.originalUrls) ctx.originalUrls.set(srcPath, result.url);
        rememberR2Upload(r2Cache, route.bucket, objectKey, mtimeMs, srcInfo.size, result.sha256);
        r2CacheDirty = true;
        remoteKeys?.add(objectKey);
        pruneTargets.set(`${identity.stableId}:${identity.childId}`,
          { identity, level, ext, objectKey });

        // Safety net: if a version bump (or a genuine content change under stable
        // identity) changed the extension, remove the stale sibling object so it
        // doesn't linger under the same key prefix. With a manifest this is decided
        // locally; without one, the LIST round-trip is only worth it after a real upload.
        try {
          const siblingKeys = remoteKeys
            ? [...remoteKeys].filter(k => k.startsWith(`${keyPrefix}.`))
            : result.skipped ? [] : await invoke<string[]>('list_r2_keys', {
                endpoint:     r2.endpoint,
                bucket:       route.bucket,
                accessKeyId:  route.accessKeyId,
                secretKey:    route.secretKey,
                sessionToken: route.sessionToken,
                prefix:       `${keyPrefix}.`,
              });
          for (const staleKey of siblingKeys.filter(k => k !== objectKey && !plannedKeys.has(k))) {
            if (await pruneStaleObject(
              ctx, r2, { key: staleKey, level }, identity, 'original', objectKey, plannedKeys,
            )) {
              remoteKeys?.delete(staleKey);
              pruned += 1;
            }
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

  /* Additive to the current-level extension-sibling cleanup above: remove every extension for this
     stable identity at NON-current levels. That covers a level and extension change in one pass,
     while keeping the delete set bounded to `${stableId}/${childId}`. */
  if (remoteKeys) {
    for (const { identity, level, ext, objectKey } of pruneTargets.values()) {
      if (ctx.isStopping?.()) return;
      const candidates = ALL_LEVELS.flatMap(staleLevel => {
        if (staleLevel === level) return [];
        const target = storageTarget(
          staleLevel, r2.clientId, 'originals', identity.stableId, identity.childId, ext,
        ).key;
        const prefix = ext ? target.slice(0, -ext.length) : target;
        return [...remoteKeys]
          .filter(key => key === prefix || key.startsWith(`${prefix}.`))
          .map(key => ({ key, level: staleLevel }));
      });
      for (const stale of candidates) {
        if (await pruneStaleObject(
          ctx, r2, stale, identity, 'original', objectKey, plannedKeys,
        )) {
          remoteKeys.delete(stale.key);
          pruned += 1;
        }
      }
    }
  }

  if (r2CacheDirty) await saveR2Cache(r2Cache);

  appendLog('section',
    `━━━ CDN ORIGINALS DONE — ${uploaded} uploaded · ${cached} cached · ${deduped} unchanged · ${pruned} pruned · ${errors} errors ━━━`);
}


export function mimeFromExt(ext: string): string {
  const m: Record<string, string> = {
    '.pdf':  'application/pdf',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.pptm': 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
    '.ppt':  'application/vnd.ms-powerpoint',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.docm': 'application/vnd.ms-word.document.macroEnabled.12',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.tif':  'image/tiff',
    '.tiff': 'image/tiff',
    '.mp4':  'video/mp4',
    '.mov':  'video/quicktime',
    '.svg':  'image/svg+xml',
    '.ai':   'application/postscript',
    '.eps':  'application/postscript',
    '.zip':  'application/zip',
  };
  return m[ext.toLowerCase()] ?? 'application/octet-stream';
}
