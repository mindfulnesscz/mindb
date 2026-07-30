/* CLOUD EXPORT stage — push deliverables to Dropbox / OneDrive / Google Drive.
 *
 * Per-destination export honouring each destination's layout (folders vs flat, optional nested
 * packages) and role. Sharing links are collected into ctx.cloudUrls for the Supabase sync.
 * 
 * Has its own mtime+size cache for the same reason R2 does: without it every unchanged file costs
 * a provider metadata round-trip.
 */

import { stat, readFile, readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import { join, appDataDir } from '@tauri-apps/api/path';
import { buildVocabMap, translateExportName, stripWorkflowPrefix } from '@dc-hub/domain';
import type { RunContext, RunStats } from './types';
import { resolveExportShape } from '../../domain/client';
import { uploadDropboxFile, uploadOneDriveFile, uploadGDriveFile } from '../cloudService';
import { findPackageFolders, syncPackageFromOut, keepOnlyHighestVersions } from './packages';
import { nestedPublishRel } from './publishLocal';
import { mimeFromExt } from './cdnUpload';

export interface CloudCacheEntry { mtimeMs: number; size: number; url?: string | null }
type CloudCache = Record<string, CloudCacheEntry>

let cloudCacheMemo: CloudCache | null = null

async function getCloudCachePath(): Promise<string> {
  return await join(await appDataDir(), 'cloud-upload-cache.json')
}

async function loadCloudCache(): Promise<CloudCache> {
  if (cloudCacheMemo) return cloudCacheMemo
  try {
    const path = await getCloudCachePath()
    cloudCacheMemo = (await exists(path)) ? JSON.parse(await readTextFile(path)) : {}
  } catch {
    cloudCacheMemo = {}
  }
  return cloudCacheMemo!
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
  cache[cloudCacheKey(destId, nestedName)] = { mtimeMs, size, url: url ?? null }
}

/* One ListObjectsV2 sweep of a key prefix at the start of an upload phase.
   Existence can then be decided locally — without it, every cache miss pays a
   per-file HEAD and every upload a per-file LIST for the sibling cleanup.
   `null` means the list failed; callers fall back to per-file checks. */

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
  const cloudCache = await loadCloudCache();
  let cloudCacheDirty = false;

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

  type CloudFileJob = {
    srcPath: string;
    stem: string;
    ext: string;
    fileName: string;
    relativeDir: string;
    /** When set, used as the full remote relative path (package mode). */
    nestedOverride: string | null;
  };

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

    if (!files.length) {
      appendLog('dim', `  ${dest.name}: no assets — skipping.`);
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

    // Match CDN: high concurrency; cache hits stay silent (summary only).
    const CONCURRENCY = 8;
    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async ({ srcPath, stem, ext, relativeDir, nestedOverride }) => {
        const translated = nestedOverride
          ? nestedOverride.split('/').pop()!
          : translateExportName(stem, ext, vocabMap);
        const nestedName = nestedOverride
          ?? (!flatten && relativeDir ? `${relativeDir}/${translated}` : translated);
        const gdriveFolderPath = (() => {
          if (nestedOverride) {
            const parts = nestedName.split('/');
            parts.pop();
            const sub = parts.join('/');
            return [cfg.remotePath.replace(/\/$/, ''), sub].filter(Boolean).join('/');
          }
          return !flatten && relativeDir
            ? [cfg.remotePath.replace(/\/$/, ''), relativeDir].filter(Boolean).join('/')
            : cfg.remotePath;
        })();
        const gdriveFileName = nestedOverride
          ? nestedName.split('/').pop()!
          : translated;

        let url: string | null = null;
        try {
          let srcInfo: Awaited<ReturnType<typeof stat>>;
          try {
            srcInfo = await stat(srcPath);
          } catch (e) {
            throw new Error(`Cannot stat ${srcPath}: ${e}`, { cause: e });
          }
          const mtimeMs = srcInfo.mtime?.getTime() ?? -1;
          const cacheEntry = cloudCache[cloudCacheKey(dest.id, nestedName)];
          if (cacheEntry && cacheEntry.size === srcInfo.size && cacheEntry.mtimeMs === mtimeMs) {
            url = dest.generateLink ? (cacheEntry.url ?? null) : null;
            cached += 1;
            skipped += 1;
            if (url && cloudUrls && dest.role === 'client') {
              const mapKey = relativeDir ? `${relativeDir}/${stem}` : stem;
              const existing = cloudUrls.get(mapKey) ?? cloudUrls.get(stem) ?? [];
              const idx = existing.findIndex(e => e.destId === dest.id || e.name === dest.name);
              const entry = { destId: dest.id, provider: cfg.type, name: dest.name, url };
              if (idx >= 0) existing[idx] = entry; else existing.push(entry);
              cloudUrls.set(mapKey, existing);
              if (mapKey !== stem) cloudUrls.set(stem, existing);
            }
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
            const bytes = await readFile(srcPath);
            const base   = cfg.remotePath.replace(/^\//, '').replace(/\/$/, '');
            const remote = base ? `${base}/${nestedName}` : nestedName;
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
          } else if (cfg.type === 'gdrive') {
            const result = await uploadGDriveFile(
              cfg.token!.accessToken,
              srcInfo.size,
              () => readFile(srcPath),
              mimeFromExt(ext),
              gdriveFileName,
              gdriveFolderPath,
              dest.generateLink,
              cfg.sharedDriveId,
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

          if (url && cloudUrls && dest.role === 'client') {
            const mapKey = relativeDir ? `${relativeDir}/${stem}` : stem;
            const existing = cloudUrls.get(mapKey) ?? cloudUrls.get(stem) ?? [];
            const idx      = existing.findIndex(e => e.destId === dest.id || e.name === dest.name);
            const entry    = { destId: dest.id, provider: cfg.type, name: dest.name, url };
            if (idx >= 0) existing[idx] = entry; else existing.push(entry);
            cloudUrls.set(mapKey, existing);
            if (mapKey !== stem) cloudUrls.set(stem, existing);
          }
        } catch (e) {
          appendLog('error', `  ✕  ${nestedName}: ${e}`);
          errors += 1;
          stats.errors += 1;
        }
      }));
    }
    appendLog(
      'section',
      `  ${dest.name} DONE — ${uploaded} uploaded · ${cached} cached · ${skipped - cached} remote-skip · ${errors} errors`,
    );
  }

  if (cloudCacheDirty) await saveCloudCache(cloudCache);

  const totalLinks = [...(cloudUrls?.values() ?? [])].reduce((n, arr) => n + arr.length, 0);
  if (totalLinks === 0 && activeDests.some(d => !d.generateLink)) {
    appendLog('warn', `  No sharing links collected — enable "Generate sharing link" on destinations in Settings to store URLs in Supabase and Obsidian.`);
  }

  appendLog('section', `━━━ CLOUD EXPORT DONE — ${stats.published} uploaded · ${totalLinks} link(s) collected ━━━`);
}

