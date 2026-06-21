/* Pipeline service — TypeScript port of the Python POC core logic.
   File operations use @tauri-apps/plugin-fs.
   Heavy processes (thumbnails) use @tauri-apps/plugin-shell sidecars. */

import {
  readDir, copyFile, mkdir, stat,
  type DirEntry,
} from '@tauri-apps/plugin-fs';
import { join, basename, dirname } from '@tauri-apps/api/path';
import type { AppSettings } from '../store/settingsStore';
import type { LogType } from '../store/pipelineStore';
import type { RunStats } from '../store/pipelineStore';
import { filterHighestVersions } from '../domain/version';

interface RunContext {
  settings:   AppSettings;
  appendLog:  (type: LogType, msg: string) => void;
  addIssue:   (i: { category: 'skipped'|'disconnected'|'version-conflict'|'error'; file: string; reason: string }) => void;
  setProgress:(p: number) => void;
  finishRun:  (stats: RunStats, hasIssues: boolean) => void;
}

/* Naming helpers */
function shouldSkip(name: string, s: AppSettings): boolean {
  if (name.startsWith('~$')) return true;
  if (name.includes('[99]')) return true;
  if (s.filterMode === 'whitelist') return !name.includes(s.includeMark);
  return name.includes(s.excludeMark);
}

function isPackageFolder(name: string, s: AppSettings): boolean {
  return name.startsWith(s.packagePrefix);
}

function isOutFolder(name: string, s: AppSettings): boolean {
  return name.toLowerCase() === s.outFolder.toLowerCase();
}

function isPublishableFile(name: string): boolean {
  return name.includes('.') && !name.startsWith('.') && !name.startsWith('~$');
}

/* Collect all entries recursively */
async function listDir(path: string): Promise<DirEntry[]> {
  try { return await readDir(path); } catch { return []; }
}

/* Walk source tree and find all package folders */
async function findPackageFolders(root: string, s: AppSettings): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string) {
    const entries = await listDir(dir);
    for (const e of entries) {
      if (!e.isDirectory) continue;
      if (shouldSkip(e.name, s)) continue;
      const childPath = await join(dir, e.name);
      if (isPackageFolder(e.name, s)) {
        results.push(childPath);
      } else {
        await walk(childPath);
      }
    }
  }
  await walk(root);
  return results;
}

/* Collect publishable files from a directory */
async function collectFiles(dir: string, s: AppSettings, directOnly = false): Promise<string[]> {
  const results: string[] = [];
  const entries = await listDir(dir);
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (shouldSkip(e.name, s)) continue;
    const childPath = await join(dir, e.name);
    if (e.isFile && isPublishableFile(e.name) && !e.name.includes('-thumb')) {
      results.push(childPath);
    } else if (e.isDirectory && !directOnly && !isPackageFolder(e.name, s)) {
      const sub = await collectFiles(childPath, s, false);
      results.push(...sub);
    }
  }
  return results;
}

/* Check if file exists and has same size (unchanged) */
async function isUnchanged(src: string, dest: string): Promise<boolean> {
  try {
    const [ss, ds] = await Promise.all([stat(src), stat(dest)]);
    return ss.size === ds.size;
  } catch { return false; }
}

/* ── Distribute operation ───────────────────────────────────────────────── */
async function runDistribute(ctx: RunContext, stats: RunStats): Promise<void> {
  const { settings, appendLog, addIssue, setProgress } = ctx;
  const { sourceFolder: source, dryRun, keepHighestVersion } = settings;

  appendLog('section', `━━━ ${dryRun ? 'DRY RUN' : 'COLLECTING'} ━━━`);

  const packages = await findPackageFolders(source, settings);
  if (!packages.length) {
    appendLog('skip', `No folders matching "${settings.packagePrefix}" found.`);
    return;
  }

  appendLog('info', `Found ${packages.length} package folder(s)`);
  const total = packages.length;

  for (let idx = 0; idx < packages.length; idx++) {
    const pkg = packages[idx];
    const pkgName = await basename(pkg);
    const parent  = await dirname(pkg);
    appendLog('section', `📦  ${pkgName}`);

    /* Find sibling dirs */
    const parentEntries = await listDir(parent);
    const siblings = parentEntries.filter(
      e => e.isDirectory && !isPackageFolder(e.name, settings) && !shouldSkip(e.name, settings)
    );

    /* Collect [03] OUT dirs (and orphan dirs) from siblings */
    const sourceDirs: Array<{ path: string; isOrphan: boolean }> = [];
    for (const sib of siblings) {
      const sibPath   = await join(parent, sib.name);
      const outPath   = await join(sibPath, settings.outFolder);
      const outEntries = await listDir(outPath).catch(() => null);
      if (outEntries !== null) {
        sourceDirs.push({ path: outPath, isOrphan: false });
        appendLog('dim', `  ├─ ${settings.outFolder}: …/${sib.name}/${settings.outFolder}`);
      } else {
        /* Check if sibling has direct publishable files (orphan) */
        const sibEntries = await listDir(sibPath);
        const hasFiles = sibEntries.some(e => e.isFile && isPublishableFile(e.name));
        if (hasFiles) {
          sourceDirs.push({ path: sibPath, isOrphan: true });
          appendLog('dim', `  ├─ 📂 orphan: …/${sib.name}`);
        }
      }
    }

    if (!sourceDirs.length) {
      appendLog('dim', `  └─ no ${settings.outFolder} or publishable files found in siblings — skipping`);
      setProgress(Math.round(((idx + 1) / total) * 100));
      continue;
    }

    /* Collect all files */
    let allFiles: string[] = [];
    for (const sd of sourceDirs) {
      const files = await collectFiles(sd.path, settings, sd.isOrphan);
      allFiles.push(...files);
    }

    if (!allFiles.length) {
      appendLog('dim', `  └─ ${settings.outFolder} folders are empty — skipping`);
      setProgress(Math.round(((idx + 1) / total) * 100));
      continue;
    }

    /* Version filter */
    if (keepHighestVersion) {
      const names = allFiles.map(f => f.split('/').pop()!);
      const kept  = new Set(filterHighestVersions(names));
      const beforeCount = allFiles.length;
      allFiles = allFiles.filter(f => kept.has(f.split('/').pop()!));
      const skippedCount = beforeCount - allFiles.length;
      if (skippedCount > 0) {
        appendLog('skip', `  ⊘  skipped ${skippedCount} older version(s)`);
        stats.skipped += skippedCount;
      }
    }

    stats.packages += 1;

    /* Copy files into package folder */
    for (const srcFile of allFiles) {
      const fileName = srcFile.split('/').pop()!;
      const destFile = await join(pkg, fileName);

      if (dryRun) {
        appendLog('success', `  ✓  [DRY] would copy: ${fileName}`);
        stats.copied += 1;
        continue;
      }

      if (await isUnchanged(srcFile, destFile)) {
        appendLog('dim', `  ↷  unchanged: ${fileName}`);
        stats.skipped += 1;
        continue;
      }

      try {
        await mkdir(await dirname(destFile), { recursive: true });
        await copyFile(srcFile, destFile);
        appendLog('success', `  ✓  copied: ${fileName}`);
        stats.copied += 1;
      } catch (e) {
        appendLog('error', `  ✕  failed: ${fileName} — ${e}`);
        addIssue({ category: 'error', file: fileName, reason: String(e) });
        stats.errors += 1;
      }
    }

    setProgress(Math.round(((idx + 1) / total) * 100));
  }

  appendLog('section',
    `━━━ COLLECT DONE — ${stats.copied} copied · ${stats.skipped} skipped · ${stats.errors} errors ━━━`
  );
}

/* ── Publish operation ──────────────────────────────────────────────────── */
async function runPublish(ctx: RunContext, stats: RunStats): Promise<void> {
  const { settings, appendLog, addIssue } = ctx;
  const { sourceFolder, targetFolder, dryRun } = settings;

  if (!targetFolder) {
    appendLog('error', 'Target folder not set — skipping publish.');
    return;
  }

  appendLog('section', `━━━ ${dryRun ? 'DRY RUN' : 'PUBLISHING'} ━━━`);

  async function publishFolder(src: string, target: string) {
    const entries = await listDir(src);
    for (const e of entries) {
      if (shouldSkip(e.name, settings)) continue;
      const childSrc = await join(src, e.name);

      if (e.isDirectory) {
        if (isOutFolder(e.name, settings)) {
          /* Mirror [03] OUT → target */
          const outEntries = await listDir(childSrc);
          for (const outE of outEntries) {
            if (!outE.isFile || !isPublishableFile(outE.name)) continue;
            const fileSrc  = await join(childSrc, outE.name);
            const fileDest = await join(target, e.name.replace(settings.outFolder, '').trim(), outE.name);
            if (dryRun) {
              appendLog('success', `  [DRY] would publish: ${outE.name}`);
              stats.published += 1;
            } else {
              try {
                await mkdir(await dirname(fileDest), { recursive: true });
                if (!await isUnchanged(fileSrc, fileDest)) {
                  await copyFile(fileSrc, fileDest);
                  appendLog('success', `  ✓  published: ${outE.name}`);
                  stats.published += 1;
                } else {
                  stats.skipped += 1;
                }
              } catch (e) {
                appendLog('error', `  ✕  publish failed: ${outE.name} — ${e}`);
                addIssue({ category: 'error', file: outE.name, reason: String(e) });
                stats.errors += 1;
              }
            }
          }
          stats.pubFolders += 1;
        } else {
          /* Recurse into subdirectories */
          const subTarget = await join(target, e.name);
          await publishFolder(childSrc, subTarget);
        }
      }
    }
  }

  await publishFolder(sourceFolder, targetFolder);
  appendLog('section', `━━━ PUBLISH DONE — ${stats.published} published · ${stats.errors} errors ━━━`);
}

/* ── Thumbnail generation ───────────────────────────────────────────────── */
async function runThumbnails(ctx: RunContext, _stats: RunStats): Promise<void> {
  const { appendLog } = ctx;
  appendLog('section', '━━━ THUMBNAILS ━━━');
  appendLog('info', 'Thumbnail generation requires LibreOffice and poppler sidecars.');
  appendLog('dim', 'Sidecar wiring is pending — thumbnails will be generated in a future release.');
  /* TODO: shell sidecar invoke for LibreOffice headless + poppler → webp */
}

/* ── Main entry point ───────────────────────────────────────────────────── */
export async function runPipeline(ctx: RunContext): Promise<void> {
  const { settings, appendLog, finishRun } = ctx;

  const stats: RunStats = {
    packages: 0, copied: 0, skipped: 0, errors: 0,
    pubFolders: 0, published: 0, thumbnails: 0, notes: 0,
  };

  try {
    if (settings.doThumbnails) await runThumbnails(ctx, stats);
    if (settings.doDistribute) await runDistribute(ctx, stats);
    if (settings.doPublish)    await runPublish(ctx, stats);
    if (settings.doFlatExport) {
      appendLog('section', '━━━ FLAT EXPORT ━━━');
      appendLog('info', 'Flat export to OneDrive — planned for next iteration.');
    }
    if (settings.doObsidian) {
      appendLog('section', '━━━ DAM / OBSIDIAN ━━━');
      appendLog('info', 'Obsidian vault build — planned for next iteration.');
    }
  } catch (e) {
    appendLog('error', `Pipeline error: ${e}`);
    stats.errors += 1;
  }

  const hasIssues = stats.errors > 0 || stats.skipped > 0;
  finishRun(stats, hasIssues);
}
