/* CLOUD EXPORT stage — push deliverables to Dropbox / OneDrive / Google Drive.
 *
 * Per-destination export honouring each destination's layout (folders vs flat, optional nested
 * packages) and role. Sharing links are collected into ctx.cloudUrls for the Supabase sync.
 * 
 * Has its own mtime+size cache for the same reason R2 does: without it every unchanged file costs
 * a provider metadata round-trip.
 *
 * Everything here is written for the run where that cache MISSES — a first run, a reconnected
 * destination, a cleared app data folder, a Dropbox sync that touched every mtime. A warm cache was
 * always fast; a cold one used to re-read and re-send a library that had not changed. So: one Drive
 * folder listing instead of one lookup per file, a content hash computed at most once per file ever,
 * OneDrive asking what is already there before reading anything off disk, and the cache written on
 * the way out of a STOPPED run as well as a finished one.
 */

import { invoke } from '@tauri-apps/api/core';
import { stat, readFile, readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import { appDataDir } from '@tauri-apps/api/path';
import { timePhase, timeStep } from './timing';
import {
  assetIdentityKey, buildVocabMap, translateExportName, stripWorkflowPrefix, isArtifactPath,
} from '@sotto/domain';
import type { RunContext, RunStats } from './types';
import { resolveExportShape } from '../../domain/client';
import {
  uploadDropboxFile, uploadOneDriveFile, uploadGDriveFile,
  ensureGDriveFolderPaths, sweepGDriveFolderFiles, drainGDriveDuplicateFolders,
  oneDriveRemoteItem, oneDriveShareLink,
} from '../cloudService';
import { findPackageFolders, syncPackageFromOut, keepOnlyHighestVersions } from './packages';
import { nestedPublishRel } from './publishLocal';
import { mimeFromExt } from './cdnUpload';
import { asyncPool } from './pool';
import { joinPath } from './paths';

/** Unchanged from the chunked batches this replaced — the pipeline's standing upload width. */
const UPLOAD_CONCURRENCY = 8;

export interface CloudCacheEntry { mtimeMs: number; size: number; url?: string | null }

/* A content hash of one SOURCE file, kept beside the per-destination upload records.
 *
 * Keyed by source path rather than by destination, because the fact it records — "these bytes hash
 * to this" — is a property of the file and not of where it was sent. That is what makes it worth
 * persisting: a second destination, a reconnected one (new id, cold upload cache), or a run stopped
 * half way all used to re-hash the same unchanged file, and hashing means READING it. On a Dropbox
 * or iCloud source tree an online-only file is downloaded to be read, so the hash is not merely slow
 * — it materialises the library on disk. Same bug class as the byte-compare removed from
 * `pipeline/fs.ts` `isUnchanged`.
 *
 * The fingerprint is the same mtime+size pair every other skip in the pipeline uses; a file whose
 * mtime or size moved is re-hashed rather than trusted. */
interface SourceHashEntry { mtimeMs: number; size: number; md5?: string; quickXor?: string }
type SourceHashKind = 'md5' | 'quickXor'

interface CloudCache {
  /** `${destId}::${nestedName}` → what was last sent there. */
  uploads: Record<string, CloudCacheEntry>;
  /** Source path → its content hashes at a known mtime+size. */
  hashes:  Record<string, SourceHashEntry>;
}

const HASH_COMMANDS: Record<SourceHashKind, string> = {
  md5:      'file_md5',              // Google Drive publishes md5Checksum
  quickXor: 'file_quick_xor_hash',   // Graph publishes file.hashes.quickXorHash
}

let cloudCacheMemo: CloudCache | null = null

async function getCloudCachePath(): Promise<string> {
  return joinPath(await appDataDir(), 'cloud-upload-cache.json')
}

/** Reads the current two-section shape, and the flat `{key: entry}` one every version before this
 *  wrote — an upgrade must not throw away a warm cache and re-upload the library to prove it. */
function parseCloudCache(raw: string): CloudCache {
  const parsed = JSON.parse(raw) as Partial<CloudCache> & Record<string, unknown>
  if (parsed && typeof parsed === 'object' && parsed.uploads && typeof parsed.uploads === 'object') {
    return { uploads: parsed.uploads, hashes: parsed.hashes ?? {} }
  }
  return { uploads: (parsed ?? {}) as Record<string, CloudCacheEntry>, hashes: {} }
}

async function loadCloudCache(): Promise<CloudCache> {
  if (cloudCacheMemo) return cloudCacheMemo
  try {
    const path = await getCloudCachePath()
    cloudCacheMemo = (await exists(path)) ? parseCloudCache(await readTextFile(path)) : emptyCloudCache()
  } catch {
    cloudCacheMemo = emptyCloudCache()
  }
  return cloudCacheMemo!
}

function emptyCloudCache(): CloudCache {
  return { uploads: {}, hashes: {} }
}

async function saveCloudCache(cache: CloudCache): Promise<void> {
  try {
    await writeTextFile(await getCloudCachePath(), JSON.stringify(cache))
  } catch { /* best-effort */ }
}

function cloudCacheKey(destId: string, nestedName: string): string {
  return `${destId}::${nestedName}`
}

function rememberCloudUpload(
  cache: CloudCache,
  destId: string,
  nestedName: string,
  mtimeMs: number,
  size: number,
  url: string | null,
): void {
  cache.uploads[cloudCacheKey(destId, nestedName)] = { mtimeMs, size, url: url ?? null }
}

/** The hash of a source file, computed at most once per (path, mtime, size) — ever, not per run.
 *  A stale fingerprint discards BOTH hashes: they describe the same bytes, so if one is out of date
 *  the other is too. */
async function sourceContentHash(
  cache:   CloudCache,
  kind:    SourceHashKind,
  srcPath: string,
  mtimeMs: number,
  size:    number,
): Promise<{ hash: string; hashed: boolean }> {
  const known = cache.hashes[srcPath]
  const current = known?.mtimeMs === mtimeMs && known.size === size ? known : null
  const cached = current?.[kind]
  if (cached) return { hash: cached, hashed: false }

  const hash = await invoke<string>(HASH_COMMANDS[kind], { path: srcPath })
  cache.hashes[srcPath] = { ...(current ?? { mtimeMs, size }), [kind]: hash }
  return { hash, hashed: true }
}

type CloudFileJob = {
  srcPath: string;
  stem: string;
  ext: string;
  fileName: string;
  relativeDir: string;
  /** When set, used as the full remote relative path (package mode). */
  nestedOverride: string | null;
}

/** Where one job lands remotely. Shared so the Drive folder pre-resolve targets exactly the folders
 *  the upload loop will ask for — two copies of these rules would pre-warm the wrong tree. */
function remoteNamesFor(
  job: CloudFileJob,
  vocabMap: ReturnType<typeof buildVocabMap>,
  flatten: boolean,
  remotePath: string,
): { nestedName: string; gdriveFolderPath: string; gdriveFileName: string } {
  const { stem, ext, relativeDir, nestedOverride } = job;
  const translated = nestedOverride
    ? nestedOverride.split('/').pop()!
    : translateExportName(stem, ext, vocabMap);
  const nestedName = nestedOverride
    ?? (!flatten && relativeDir ? `${relativeDir}/${translated}` : translated);
  const base = remotePath.replace(/\/$/, '');
  const sub = nestedOverride
    ? nestedName.split('/').slice(0, -1).join('/')
    : (!flatten ? relativeDir : '');
  const gdriveFolderPath = nestedOverride || sub
    ? [base, sub].filter(Boolean).join('/')
    : remotePath;
  return {
    nestedName,
    gdriveFolderPath,
    gdriveFileName: nestedOverride ? nestedName.split('/').pop()! : translated,
  };
}

function relativeUnderOut(srcPath: string, outFolderName: string): { dir: string; fileName: string } {
  const parts = srcPath.replace(/\\/g, '/').split('/');
  let outIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    const want = stripWorkflowPrefix(outFolderName || 'OUT').toLowerCase();
    const got  = stripWorkflowPrefix(parts[i]).toLowerCase();
    if (got === want || got === 'out') { outIdx = i; break; }
  }
  const fileName = parts[parts.length - 1] ?? '';
  if (outIdx < 0) return { dir: '', fileName };
  const relative = parts.slice(outIdx + 1);
  if (relative.length <= 1) return { dir: '', fileName };
  return { dir: relative.slice(0, -1).join('/'), fileName };
}


export async function runCloudExport(ctx: RunContext, stats: RunStats): Promise<void> {
  const { vocab, appendLog, collectedAssets, cloudDestinations, cloudUrls, settings } = ctx;

  const phase = timePhase('CLOUD EXPORT');
  appendLog('section', '━━━ CLOUD EXPORT ━━━');

  // Any selected non-local destination with a valid token participates.
  // The "4 Cloud export" task toggle and pipeline destination checkboxes are the controls.
  const activeDests = (cloudDestinations ?? []).filter(d =>
    d.config.type !== 'local' && !!(d.config.token?.accessToken)
  );

  if (!activeDests.length) {
    const allDests = (cloudDestinations ?? []).filter(d => d.config.type !== 'local');
    if (!allDests.length) {
      appendLog('dim', '  No cloud destinations selected — check pipeline destination checkboxes.');
    } else {
      appendLog('warn', '  Cloud destinations selected but no valid tokens found. Connect them in Settings → Cloud Destinations.');
    }
    return;
  }

  const outFolder = settings.outFolder || 'OUT';
  const vocabMap = buildVocabMap(vocab);
  const cloudCache = settings.dryRun ? emptyCloudCache() : await loadCloudCache();
  let cloudCacheDirty = false;

  /* Flushed before every exit, not only the one at the bottom. A stopped run used to return without
     writing, so everything it had already sent — and every hash it had already paid for — was
     forgotten, and the next run started cold. Stopping a long export is a normal thing to do. */
  const persistCloudCache = async (): Promise<void> => {
    if (!cloudCacheDirty) return;
    cloudCacheDirty = false;
    await saveCloudCache(cloudCache);
  };

  /** A content hash for the skip decision, memoized across destinations and across runs (E1). */
  const contentHash = async (
    kind: SourceHashKind, srcPath: string, mtimeMs: number, size: number,
  ): Promise<string> => {
    const { hash, hashed } = await sourceContentHash(cloudCache, kind, srcPath, mtimeMs, size);
    if (hashed) cloudCacheDirty = true;
    return hash;
  };

  function recordCloudUrl(
    srcPath: string,
    nestedOverride: string | null,
    dest: (typeof activeDests)[number],
    url: string | null,
  ): void {
    // Nested package copies are alternate placements of an OUT asset. The portal link belongs to
    // the primary OUT upload, whose physical path is present in the identity manifest map.
    if (!url || !cloudUrls || dest.role !== 'client' || nestedOverride !== null) return;
    const identity = ctx.cdnIdentity?.get(srcPath);
    if (!identity) {
      appendLog('warn', `  No manifest identity for ${srcPath} — sharing link not attached to an asset.`);
      return;
    }
    const key = assetIdentityKey(identity.stableId, identity.childId);
    const existing = cloudUrls.get(key) ?? [];
    const index = existing.findIndex(entry => entry.destId === dest.id || entry.name === dest.name);
    const entry = { destId: dest.id, provider: dest.config.type, name: dest.name, url };
    if (index >= 0) existing[index] = entry;
    else existing.push(entry);
    cloudUrls.set(key, existing);
  }

  // Default OUT-tree file list (used when dest layout is folders or flat).
  let outAssetPaths = collectedAssets ?? [];
  if (outAssetPaths.length) {
    const { kept, dropped } = keepOnlyHighestVersions(outAssetPaths);
    outAssetPaths = kept;
    if (dropped.length) appendLog('skip', `  ⊘  dropped ${dropped.length} older version(s) from cloud export`);
  }
  const outFiles = outAssetPaths.map(srcPath => {
    const fileName = srcPath.split('/').pop()!;
    const dotIdx   = fileName.lastIndexOf('.');
    const ext      = dotIdx > 0 ? fileName.slice(dotIdx) : '';
    const stem     = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
    const { dir: relativeDir } = relativeUnderOut(srcPath, outFolder);
    return { srcPath, stem, ext, fileName, relativeDir, nestedOverride: null as string | null };
  });

  /* THE EXPORT BOUNDARY. A client destination receives assets — never a thumbnail, a previews
     folder or a render cache.

     Both job sources are already filtered upstream, and this stage relied on that: it had no test
     of its own and was clean only because `collectedAssets` arrives scan-filtered. That is exactly
     the shape in which one new caller ships a client a `thumbnails/` folder, so the rule is applied
     here too, against the path that is actually about to be uploaded. */
  function assetsOnly(jobs: CloudFileJob[], destName: string): CloudFileJob[] {
    const kept = jobs.filter(job =>
      !isArtifactPath(job.nestedOverride ?? `${job.relativeDir}/${job.fileName}`));
    const dropped = jobs.length - kept.length;
    if (dropped) {
      appendLog('skip', `  ⊘  ${destName}: ${dropped} render artifact(s) held back from the destination`);
    }
    return kept;
  }

  async function packageFileJobsNested(): Promise<CloudFileJob[]> {
    const source = settings.sourceFolder;
    if (!source) return [];
    const packages = await findPackageFolders(source, settings);
    const jobs: CloudFileJob[] = [];
    for (const pkg of packages) {
      const relPkg = nestedPublishRel(source, pkg);
      appendLog('section', `📦  ${relPkg}`);
      const sync = await syncPackageFromOut(
        pkg,
        settings,
        vocabMap,
        !!settings.dryRun,
        appendLog,
      );
      if (!sync.sources.length) continue;
      for (const srcPath of sync.sources) {
        const rawName = srcPath.split('/').pop()!;
        const dotIdx = rawName.lastIndexOf('.');
        const ext = dotIdx > 0 ? rawName.slice(dotIdx) : '';
        const stem = dotIdx > 0 ? rawName.slice(0, dotIdx) : rawName;
        const destRel = translateExportName(stem, ext, vocabMap);
        const fileName = destRel.split('/').pop()!;
        jobs.push({
          srcPath,
          stem: fileName.includes('.') ? fileName.slice(0, fileName.lastIndexOf('.')) : fileName,
          ext: fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '',
          fileName,
          relativeDir: '',
          nestedOverride: `${relPkg}/${destRel}`,
        });
      }
    }
    return jobs;
  }

  if (!outFiles.length) {
    appendLog('dim', '  No OUT assets scanned — destinations with nested packages may still export.');
  }

  appendLog('info', `  ${activeDests.length} destination(s)`);

  for (const dest of activeDests) {
    const destStep = timeStep(`CLOUD EXPORT › ${dest.name}`);
    if (ctx.isStopping?.()) { await persistCloudCache(); return; }
    const cfg = dest.config;
    if (cfg.type === 'local') continue;

    const { exportLayout: layout, includePackages } = resolveExportShape(dest);
    const flatten = layout === 'flat';
    let files: CloudFileJob[] = [...outFiles];

    if (layout === 'folders' && includePackages) {
      const pkgJobs = await packageFileJobsNested();
      if (!pkgJobs.length) {
        appendLog('warn', `  ${dest.name}: no package folders — run Distribute packages first (OUT folders still export).`);
      } else {
        files = [...outFiles, ...pkgJobs];
        appendLog('dim', `  ${dest.name}: folders + nested packages (${outFiles.length} OUT · ${pkgJobs.length} package file(s))`);
      }
    } else if (flatten) {
      appendLog('dim', `  ${dest.name}: flat export (folder structure ignored)`);
    } else {
      appendLog('dim', `  ${dest.name}: full folders under OUT`);
    }

    files = assetsOnly(files, dest.name);

    if (!files.length) {
      appendLog('dim', `  ${dest.name}: no assets — skipping.`);
      continue;
    }

    if (settings.dryRun) {
      appendLog('dim', `  [DRY] would upload ${files.length} file(s) to ${dest.name}`);
      stats.published += files.length;
      continue;
    }

    if (!dest.generateLink) {
      appendLog('info', `  → ${dest.name} (${cfg.type}) — uploading without link collection`);
    } else {
      appendLog('info', `  → ${dest.name} (${cfg.type}) — uploading + collecting sharing links`);
    }

    let uploaded = 0;
    let skipped  = 0;
    let cached   = 0;
    let errors   = 0;
    let uploadLogged = 0;

    /* Drive has no paths, so a folder is resolved by listing for its name and creating it when
       absent — and Drive accepts a second folder of the same name in the same parent. Resolving the
       whole destination tree here, sequentially, means the concurrent batch below never asks for a
       folder that does not exist yet. (`gdrive.ts` also memoizes the in-flight resolve per segment;
       this is the outer belt.) */
    const reportDuplicateFolders = (): void => {
      for (const dup of drainGDriveDuplicateFolders()) {
        appendLog('warn',
          `  ${dest.name}: ${dup.count} folders named "${dup.path}" — using the oldest (${dup.chosenId}). ` +
          `Run Settings → Cloud destinations → ${dest.name} → Clean up duplicate folders.`);
      }
    };

    /* One listing per destination FOLDER, taken before the batch starts. `null` — a failed sweep, or
       a destination whose folders could not be pre-resolved — means each upload asks Drive about its
       own file, exactly as it did before this existed. Erring toward a per-file lookup is the same
       choice the CDN manifest makes: a listing believed to be complete when it is not would read as
       "not uploaded yet" and put a second copy beside the client's file. */
    let gdriveChildren: Awaited<ReturnType<typeof sweepGDriveFolderFiles>> = null;

    if (cfg.type === 'gdrive') {
      try {
        const folderIds = await ensureGDriveFolderPaths(
          cfg.token!.accessToken,
          files.map(job => remoteNamesFor(job, vocabMap, flatten, cfg.remotePath).gdriveFolderPath),
          cfg.sharedDriveId,
          dest.id,
        );
        reportDuplicateFolders();
        const folders = folderIds?.size ?? 0;
        if (folders) {
          const sweepStep = timeStep(`CLOUD EXPORT › ${dest.name} › folder sweep`);
          gdriveChildren = await sweepGDriveFolderFiles(
            cfg.token!.accessToken, folderIds!.values(), cfg.sharedDriveId,
          );
          const took = sweepStep.done();
          if (gdriveChildren) {
            appendLog('dim', `  ${dest.name}: listed ${folders} Drive folder(s) once in ${took} — no per-file lookups`);
          } else {
            appendLog('warn', `  ${dest.name}: Drive folder sweep failed — falling back to one lookup per file`);
          }
        }
      } catch (e) {
        // Not fatal: each upload resolves its own folder anyway. The uploads report their own errors.
        appendLog('warn', `  ${dest.name}: could not pre-resolve Drive folders (${e})`);
        reportDuplicateFolders();
      }
    }

    /* Match CDN: eight at a time, cache hits silent (summary only). A pool rather than a chunked
       barrier, because a destination's file sizes vary by orders of magnitude and one 500 MB video
       in a batch of eight used to hold the other seven slots empty until it finished. */
    await asyncPool(UPLOAD_CONCURRENCY, files, async (job) => {
      const { srcPath, ext, nestedOverride } = job;
      const { nestedName, gdriveFolderPath, gdriveFileName } =
        remoteNamesFor(job, vocabMap, flatten, cfg.remotePath);

      let url: string | null = null;
      try {
        let srcInfo: Awaited<ReturnType<typeof stat>>;
        try {
          srcInfo = await stat(srcPath);
        } catch (e) {
          throw new Error(`Cannot stat ${srcPath}: ${e}`, { cause: e });
        }
        const mtimeMs = srcInfo.mtime?.getTime() ?? -1;
        const cacheEntry = cloudCache.uploads[cloudCacheKey(dest.id, nestedName)];
        if (cacheEntry && cacheEntry.size === srcInfo.size && cacheEntry.mtimeMs === mtimeMs) {
          url = dest.generateLink ? (cacheEntry.url ?? null) : null;
          cached += 1;
          skipped += 1;
          recordCloudUrl(srcPath, nestedOverride, dest, url);
          return;
        }

        if (cfg.type === 'dropbox') {
          const base   = cfg.remotePath.replace(/\/$/, '');
          const remote = (base.startsWith('/') ? base : '/' + base) + '/' + nestedName;
          const result = await uploadDropboxFile(cfg.token!.accessToken, srcPath, remote, dest.generateLink);
          url = result.url;
          if (result.skipped) {
            skipped += 1;
          } else {
            if (uploadLogged < 3) {
              appendLog('success', `  ✓  ${nestedName}`);
              uploadLogged += 1;
            } else if (uploadLogged === 3) {
              appendLog('dim', `  … further uploads omitted from log`);
              uploadLogged += 1;
            }
            uploaded += 1;
            stats.published += 1;
          }
        } else if (cfg.type === 'onedrive') {
          const base   = cfg.remotePath.replace(/^\//, '').replace(/\/$/, '');
          const remote = base ? `${base}/${nestedName}` : nestedName;

          /* SKIP-IF-UNCHANGED, which this provider simply did not have: it read the file and PUT it
             on every cache miss, so a cold cache re-sent the whole library.

             Size first, because it costs nothing and rules most changes out; the hash only when the
             size already matches. Size ALONE is never enough — that is the comparison Drive's
             uploader deliberately refuses (`updates when Drive has no MD5 instead of trusting size
             alone`), and trusting it here would keep a client on an old file forever whenever an
             edit preserved the byte count. Personal OneDrive publishes no quickXorHash, so there the
             `hashes` object is empty and the file uploads exactly as before. */
          const remoteItem = await oneDriveRemoteItem(cfg.token!.accessToken, remote, cfg.driveId);
          const unchanged = !!remoteItem
            && remoteItem.size === srcInfo.size
            && !!remoteItem.quickXorHash
            && remoteItem.quickXorHash
               === await contentHash('quickXor', srcPath, mtimeMs, srcInfo.size);

          if (unchanged) {
            url = dest.generateLink
              ? await oneDriveShareLink(cfg.token!.accessToken, remote, cfg.driveId)
              : null;
            skipped += 1;
          } else {
            // Read only once the skip has been ruled out — the bytes are the expensive part on a
            // synced source tree, where reading an online-only file downloads it.
            const bytes = await readFile(srcPath);
            url = await uploadOneDriveFile(cfg.token!.accessToken, bytes, remote, dest.generateLink, cfg.driveId);
            if (uploadLogged < 3) {
              appendLog('success', `  ✓  ${nestedName}`);
              uploadLogged += 1;
            } else if (uploadLogged === 3) {
              appendLog('dim', `  … further uploads omitted from log`);
              uploadLogged += 1;
            }
            uploaded += 1;
            stats.published += 1;
          }
        } else if (cfg.type === 'gdrive') {
          const result = await uploadGDriveFile(
            cfg.token!.accessToken,
            srcInfo.size,
            () => readFile(srcPath),
            () => contentHash('md5', srcPath, mtimeMs, srcInfo.size),
            mimeFromExt(ext),
            gdriveFileName,
            gdriveFolderPath,
            dest.generateLink,
            cfg.sharedDriveId,
            dest.id,
            gdriveChildren,
          );
          url = result.url;
          if (result.skipped) {
            skipped += 1;
          } else {
            if (uploadLogged < 3) {
              appendLog('success', `  ✓  ${nestedName}`);
              uploadLogged += 1;
            } else if (uploadLogged === 3) {
              appendLog('dim', `  … further uploads omitted from log`);
              uploadLogged += 1;
            }
            uploaded += 1;
            stats.published += 1;
          }
        }

        rememberCloudUpload(cloudCache, dest.id, nestedName, mtimeMs, srcInfo.size, url);
        cloudCacheDirty = true;

        recordCloudUrl(srcPath, nestedOverride, dest, url);
      } catch (e) {
        appendLog('error', `  ✕  ${nestedName}: ${e}`);
        errors += 1;
        stats.errors += 1;
      }
    }, ctx.isStopping);
    // A stopped run leaves without the per-destination DONE line, exactly as the chunked loop did —
    // but it keeps what it already learned, so resuming does not start from a cold cache.
    if (ctx.isStopping?.()) { await persistCloudCache(); return; }

    if (cfg.type === 'gdrive') reportDuplicateFolders();
    appendLog(
      'section',
      `  ${dest.name} DONE — ${uploaded} uploaded · ${cached} cached · ${skipped - cached} remote-skip · ${errors} errors in ${destStep.done()}`,
    );
  }

  await persistCloudCache();

  const totalLinks = [...(cloudUrls?.values() ?? [])].reduce((n, arr) => n + arr.length, 0);
  if (totalLinks === 0 && activeDests.some(d => !d.generateLink)) {
    appendLog('warn', `  No sharing links collected — enable "Generate sharing link" on destinations in Settings to store URLs in Supabase and Obsidian.`);
  }

  appendLog('section', `━━━ CLOUD EXPORT DONE — ${stats.published} uploaded · ${totalLinks} link(s) collected ━━━ in ${phase.done()}`);
}
