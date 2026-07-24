/* Pipeline service — TypeScript port of the Python POC core logic.
   File operations use @tauri-apps/plugin-fs.
   Thumbnail generation delegates to a Rust command (generate_thumbnail). */

import {
  readDir, readFile, copyFile, mkdir, stat, rename, remove,
  readTextFile, writeTextFile, exists,
  type DirEntry,
} from '@tauri-apps/plugin-fs';
import { join, basename, dirname, appDataDir } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import type { AppSettings } from '../store/settingsStore';
import type { LogType } from '../store/pipelineStore';
import type { RunStats } from '../store/pipelineStore';
import type { VocabularyData } from '../domain/vocabulary';
import { filterHighestVersions } from '../domain/version';
import { buildVocabContext, translateExportName, parseFilename } from '../domain/filenameTranslator';
import { runObsidian } from './damService';
import { uploadDropboxFile, uploadOneDriveFile, uploadGDriveFile } from './cloudService';
import type { CloudDestination, DestExportLayout } from '../domain/client';
import { resolveExportShape } from '../domain/client';
import { stripStableId } from '../domain/stableId';
import { isOutFolder as namingIsOutFolder, isPackageFolder as namingIsPackageFolder, stripWorkflowPrefix } from '../domain/naming';
import { resolveCdnIdentity } from './supabaseService';
import { storageKey } from './pipeline/storageKey';

export interface CloudUrlEntry {
  destId?:  string;  // CloudDestination.id — preferred match key in the portal
  provider: string;  // 'dropbox' | 'onedrive' | 'gdrive'
  name:     string;  // destination name (from CloudDestination.name)
  url:      string;  // sharing link
}

export interface R2Config {
  endpoint:     string;
  accessKeyId:  string;
  secretKey:    string;
  sessionToken: string;
  bucket:       string;
  publicDomain: string;
  keyPrefix:    string;  // e.g. "{client_id}/" — prepended to all object keys
}

export interface RunContext {
  settings:          AppSettings;
  vocab:             VocabularyData;
  appendLog:         (type: LogType, msg: string) => void;
  addIssue:          (i: { category: 'skipped'|'disconnected'|'version-conflict'|'error'; file: string; reason: string }) => void;
  setProgress:       (p: number) => void;
  finishRun:         (stats: RunStats, hasIssues: boolean) => void;
  processedPackages?: string[];
  collectedAssets?:  string[]; // populated once by runPipeline, stems used for Supabase sync
  r2?:               R2Config;                             // CDN upload config; omit to skip CDN step
  cdnUrls?:          Map<string, string>;                  // stem → public CDN URL, populated by CDN step
  originalUrls?:     Map<string, string>;                  // stem → public CDN URL of the original file (version-stable key)
  cloudUrls?:        Map<string, CloudUrlEntry[]>;         // stem → cloud sharing URLs, populated by cloud export
  cloudDestinations?: CloudDestination[];                  // active cloud destinations to export to
  /** Local publish shape from the checked local destination. */
  localExportLayout?: DestExportLayout;
  localIncludePackages?: boolean;
  identityMigrated?: boolean;
  cdnIdentity?:      Map<string, { stableId: string; childId: string }>;
  storageKeyPrefix?: string;  // mirrors r2.keyPrefix when CDN enabled
}

/* ── Naming helpers ─────────────────────────────────────────────────────── */

function shouldSkip(name: string, s: AppSettings): boolean {
  if (name.startsWith('~$')) return true;
  if (name.includes('[99]')) return true;
  if (s.filterMode === 'whitelist') return !name.includes(s.includeMark);
  return s.excludeMark ? name.includes(s.excludeMark) : false;
}

/** Prefix packages — skipped during OUT-tree walks / collected for nested export. */
function isPackageFolder(name: string, s: AppSettings): boolean {
  return namingIsPackageFolder(name, {
    packagePrefix: s.packagePrefix,
    outFolder:     s.outFolder,
    excludeMark:   s.excludeMark,
    includeMark:   s.includeMark,
    filterMode:    s.filterMode,
  });
}

function isOutFolder(name: string, s: AppSettings): boolean {
  return namingIsOutFolder(name, {
    packagePrefix: s.packagePrefix,
    outFolder:     s.outFolder,
    excludeMark:   s.excludeMark,
    includeMark:   s.includeMark,
    filterMode:    s.filterMode,
  });
}

function isPublishableFile(name: string): boolean {
  return name.includes('.') && !name.startsWith('.') && !name.startsWith('~$');
}

const THUMB_EXTS = new Set(['.pptx', '.pptm', '.ppt', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.tif', '.tiff']);

/* ── Directory listing — surfaces errors in the log ─────────────────────── */

async function listDir(path: string): Promise<DirEntry[]> {
  try {
    return await readDir(path);
  } catch (e) {
    return [];
  }
}

async function listDirLogged(
  path: string,
  appendLog: (t: LogType, m: string) => void
): Promise<DirEntry[]> {
  try {
    return await readDir(path);
  } catch (e) {
    appendLog('error', `  ✕  Cannot read directory: ${path}\n     ${e}`);
    return [];
  }
}

/* ── Package folder discovery ───────────────────────────────────────────── */

/**
 * Only folders matching the configured package prefix (e.g. `📦` / `[00] 📦`).
 * Migrated `Name __hash` asset folders and `.dchub.json` are NOT packages —
 * treating them as such made Collect a no-op on prod and skipped their OUT
 * when filling real 📦 anchors.
 */
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

/**
 * Gather OUT deliverables for a 📦 anchor: every OUT under the package's parent
 * tree (siblings + nested assets), skipping other package folders. Walks into
 * migrated `Name __hash` assets so their OUT is included.
 */
async function collectOutUnderParent(
  parentDir: string,
  s: AppSettings,
): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string) {
    const entries = await listDir(dir);
    for (const e of entries) {
      if (!e.isDirectory || shouldSkip(e.name, s)) continue;
      // Never harvest from (or through) another 📦 anchor.
      if (isPackageFolder(e.name, s)) continue;
      const childPath = await join(dir, e.name);
      if (isOutFolder(e.name, s)) {
        results.push(...await collectFiles(childPath, s, false));
      } else {
        await walk(childPath);
      }
    }
  }
  await walk(parentDir);
  return results;
}

async function collectPackageOutSources(
  packageDir: string,
  s: AppSettings,
): Promise<string[]> {
  const parent = await dirname(packageDir);
  return collectOutUnderParent(parent, s);
}

/** Always keep highest version for export — one file per base+ext. */
function keepOnlyHighestVersions(paths: string[]): { kept: string[]; dropped: string[] } {
  if (paths.length <= 1) return { kept: paths, dropped: [] };
  const keptNames = new Set(filterHighestVersions(paths.map(f => f.split('/').pop()!)));
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const p of paths) {
    (keptNames.has(p.split('/').pop()!) ? kept : dropped).push(p);
  }
  return { kept, dropped };
}

/**
 * Hard-mirror purge for a package folder (source or target): delete anything that
 * isn't in liveNames — older versions, renamed taxonomy files, thumbs, prior 🚫 marks.
 * Package collections are pickup mirrors; they must not accumulate stale files.
 */
async function purgePackageMirror(
  pkgDir: string,
  liveNames: Set<string>,
  s: AppSettings,
  dryRun: boolean,
  appendLog: (t: LogType, m: string) => void,
  logPrefix = 'package',
): Promise<number> {
  const purgeRels = new Set<string>();
  async function collectPurge(dir: string, rel: string) {
    const entries = await listDir(dir);
    for (const e of entries) {
      if (e.name.startsWith('.') || shouldSkip(e.name, s)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childPath = await join(dir, e.name);
      if (e.isDirectory) {
        await collectPurge(childPath, childRel);
        continue;
      }
      if (!e.isFile) continue;
      if (e.name.includes('-thumb') || e.name.startsWith('🚫')) {
        purgeRels.add(childRel);
        continue;
      }
      if (liveNames.has(e.name)) continue;
      if (isPublishableFile(e.name)) purgeRels.add(childRel);
    }
  }
  await collectPurge(pkgDir, '');

  let removed = 0;
  for (const rel of purgeRels) {
    const abs = await join(pkgDir, rel);
    if (dryRun) {
      appendLog('dim', `  🗑  [DRY] would remove from ${logPrefix}: ${rel}`);
      removed += 1;
      continue;
    }
    try {
      if (await exists(abs)) {
        await remove(abs);
        appendLog('dim', `  🗑  removed from ${logPrefix}: ${rel}`);
        removed += 1;
      }
    } catch (err) {
      appendLog('warn', `  ⚠  could not remove ${rel}: ${err}`);
    }
  }
  return removed;
}

/**
 * Refresh a package folder from sibling OUT: copy highest versions (translated),
 * then hard-delete anything else in the package (no 🚫).
 * Returns kept OUT source paths for further export.
 */
async function syncPackageFromOut(
  pkg: string,
  s: AppSettings,
  vocabMap: ReturnType<typeof buildVocabContext>,
  dryRun: boolean,
  appendLog: (t: LogType, m: string) => void,
  onError?: (file: string, reason: string) => void,
): Promise<{ sources: string[]; copied: number; skipped: number; removed: number; errors: number }> {
  const result = { sources: [] as string[], copied: 0, skipped: 0, removed: 0, errors: 0 };

  const fromOut = await collectPackageOutSources(pkg, s);
  if (!fromOut.length) {
    appendLog('warn', '  └─ no OUT files found under parent (siblings + nested)');
    return result;
  }

  const { kept, dropped } = keepOnlyHighestVersions(fromOut);
  if (dropped.length) {
    appendLog('skip', `  ⊘  OUT older versions not packaged: ${dropped.map(p => p.split('/').pop()).join(', ')}`);
  }
  result.sources = kept.filter(p => !p.split('/').pop()!.includes('-thumb'));
  appendLog('dim', `  └─ ${result.sources.length} OUT file(s) from siblings/nested → package`);

  const liveNames = new Set<string>();
  for (const srcFile of result.sources) {
    const rawName = srcFile.split('/').pop()!;
    if (rawName.includes('-thumb')) continue;
    const ext = rawName.includes('.') ? '.' + rawName.split('.').pop()! : '';
    const stem = ext ? rawName.slice(0, -ext.length) : rawName;
    liveNames.add(translateExportName(stem, ext, vocabMap));
  }

  result.removed = await purgePackageMirror(pkg, liveNames, s, dryRun, appendLog, 'package');

  for (const srcFile of result.sources) {
    const rawName = srcFile.split('/').pop()!;
    if (rawName.includes('-thumb')) continue;
    const ext = rawName.includes('.') ? '.' + rawName.split('.').pop()! : '';
    const stem = ext ? rawName.slice(0, -ext.length) : rawName;
    const translated = translateExportName(stem, ext, vocabMap);
    const destFile = await join(pkg, translated);

    if (dryRun) {
      appendLog('success', `  ✓  [DRY] package ← ${rawName} → ${translated}`);
      result.copied += 1;
      continue;
    }

    if (await isUnchanged(srcFile, destFile)) {
      appendLog('dim', `  ↷  package unchanged: ${translated}`);
      result.skipped += 1;
      continue;
    }

    try {
      await mkdir(await dirname(destFile), { recursive: true });
      await copyFile(srcFile, destFile);
      appendLog('success', `  ✓  package ← ${rawName} → ${translated}`);
      result.copied += 1;
    } catch (e) {
      appendLog('error', `  ✕  package update failed: ${rawName} — ${e}`);
      onError?.(rawName, String(e));
      result.errors += 1;
    }
  }

  return result;
}

/* ── Collect publishable files from a directory ─────────────────────────── */

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

/* ── Unchanged check (mtime — dest missing/older → copy, dest newer-or-same → skip) ── */

async function isUnchanged(src: string, dest: string): Promise<boolean> {
  try {
    const [ss, ds] = await Promise.all([stat(src), stat(dest)]);
    if (ss.mtime && ds.mtime) return ds.mtime.getTime() >= ss.mtime.getTime();
    return ss.size === ds.size; // mtime unavailable on this filesystem — fall back to size
  } catch { return false; } // dest missing (or unreadable) — not unchanged, copy it
}

/* ── Distribute operation ───────────────────────────────────────────────── */

async function runDistribute(ctx: RunContext, stats: RunStats): Promise<void> {
  const { settings, appendLog, addIssue, setProgress } = ctx;
  const { sourceFolder: source, dryRun } = settings;

  if (!source) {
    appendLog('error', 'Source folder not configured — skipping collect.');
    return;
  }

  appendLog('section', `━━━ ${dryRun ? 'DRY RUN' : 'COLLECTING'} ━━━`);
  appendLog('dim', `  Source: ${source}`);
  appendLog('dim',
    `  Fill "${settings.packagePrefix}" anchors from sibling + nested OUT (highest version only)`,
  );

  const packages = await findPackageFolders(source, settings);
  if (!packages.length) {
    appendLog('skip',
      `  No package folders found matching prefix "${settings.packagePrefix}". `
      + 'Name __hash asset folders are not package anchors.',
    );
    return;
  }

  appendLog('info', `  Found ${packages.length} package folder(s)`);
  const total = packages.length;
  const vocabMap = buildVocabContext(ctx.vocab);

  for (let idx = 0; idx < packages.length; idx++) {
    const pkg = packages[idx];
    const pkgName = await basename(pkg);
    appendLog('section', `📦  ${pkgName}`);

    const sync = await syncPackageFromOut(
      pkg,
      settings,
      vocabMap,
      dryRun,
      appendLog,
      (file, reason) => addIssue({ category: 'error', file, reason }),
    );

    if (!sync.sources.length) {
      setProgress(Math.round(((idx + 1) / total) * 100));
      continue;
    }

    stats.packages += 1;
    stats.copied += sync.copied;
    stats.skipped += sync.skipped;
    stats.errors += sync.errors;

    for (const srcFile of sync.sources) {
      const rawName = srcFile.split('/').pop()!;
      const ext = rawName.includes('.') ? '.' + rawName.split('.').pop()! : '';
      const stem = ext ? rawName.slice(0, -ext.length) : rawName;
      ctx.processedPackages?.push(stem);
    }

    setProgress(Math.round(((idx + 1) / total) * 100));
  }

  appendLog('section',
    `━━━ COLLECT DONE — ${stats.packages} package(s) · `
    + `${stats.copied} copied · ${stats.skipped} unchanged · ${stats.errors} errors ━━━`,
  );
}

/* ── Disconnected / orphan detection ───────────────────────────────────── */

async function flagDisconnected(
  targetDir: string,
  livePub:   Set<string>,
  stats:     RunStats,
  appendLog: (t: LogType, m: string) => void,
  addIssue:  (i: { category: 'skipped'|'disconnected'|'version-conflict'|'error'; file: string; reason: string }) => void,
  opts: { layout: DestExportLayout; settings: AppSettings },
): Promise<void> {
  /* Orphans: 🚫-rename outside package folders; hard-delete inside 📦 mirrors
     (pickup collections must not keep older versions / renamed tags). */
  async function collectAll(dir: string, acc: { path: string; isDir: boolean }[]) {
    const entries = await listDir(dir);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const childPath = await join(dir, e.name);
      acc.push({ path: childPath, isDir: !!e.isDirectory });
      if (e.isDirectory) await collectAll(childPath, acc);
    }
  }

  const all: { path: string; isDir: boolean }[] = [];
  await collectAll(targetDir, all);

  const targetNorm = targetDir.replace(/\\/g, '/').replace(/\/+$/, '');

  function inLayoutScope(abs: string): boolean {
    if (opts.layout === 'flat') {
      const rel = abs.replace(/\\/g, '/').replace(targetNorm, '').replace(/^\/+/, '');
      return rel.length > 0 && !rel.includes('/');
    }
    return true;
  }

  function insidePackageCollection(abs: string): boolean {
    const absN = abs.replace(/\\/g, '/');
    const rel = absN.startsWith(targetNorm + '/')
      ? absN.slice(targetNorm.length + 1)
      : absN;
    return rel.split('/').some(seg => isPackageFolder(seg, opts.settings));
  }

  const scoped = all.filter(x => inLayoutScope(x.path));

  const liveFolderAncestors = new Set<string>();
  for (const p of livePub) {
    const parts = p.replace(/\\/g, '/').split('/');
    for (let i = 1; i < parts.length; i++) {
      liveFolderAncestors.add(parts.slice(0, i).join('/'));
    }
  }

  // Normalize livePub keys for comparison (Tauri join vs walk can differ on trailing style).
  const liveNorm = new Set([...livePub].map(p => p.replace(/\\/g, '/').replace(/\/+$/, '')));

  const files   = scoped.filter(x => !x.isDir);
  const folders = scoped.filter(x => x.isDir).sort((a, b) => a.path.split('/').length - b.path.split('/').length);

  for (const { path: existingPath, isDir } of [...files, ...folders]) {
    const existingNorm = existingPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!isDir && liveNorm.has(existingNorm)) continue;
    if (isDir  && (liveNorm.has(existingNorm) || liveFolderAncestors.has(existingNorm))) continue;

    const name = existingPath.split('/').pop()!;
    const rel = existingPath.replace(targetDir, '').replace(/^\//, '');
    const inPackage = insidePackageCollection(existingPath);

    // Package mirrors: wipe stale entries (and prior 🚫 marks) instead of disconnect-rename.
    if (inPackage) {
      try {
        await remove(existingPath, { recursive: true });
        appendLog('dim', `  🗑  removed stale from package: ${rel}`);
        stats.disconnected += 1;
      } catch {
        /* already removed with parent */
      }
      continue;
    }

    if (name.startsWith('🚫')) continue;
    const flagged = await join(existingPath.substring(0, existingPath.lastIndexOf('/')), `🚫 ${name}`);
    try {
      await rename(existingPath, flagged);
      appendLog('disconnected', `  🚫 DISCONNECTED: ${rel}`);
      addIssue({ category: 'disconnected', file: rel, reason: 'No longer in source for this export layout' });
      stats.disconnected += 1;
    } catch {
      /* entry already moved as child of a renamed parent — ignore */
    }
  }
}

/** Relative path from source root → target, stripping stable-id suffixes on ancestors. */
function nestedPublishRel(sourceRoot: string, absPath: string): string {
  const root = sourceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const abs  = absPath.replace(/\\/g, '/').replace(/\/+$/, '');
  let rel: string;
  if (abs === root) {
    rel = '';
  } else if (abs.startsWith(root + '/')) {
    rel = abs.slice(root.length + 1);
  } else {
    // Fallback: find root as a path prefix (handles mild join/realpath drift).
    const idx = abs.toLowerCase().indexOf(root.toLowerCase() + '/');
    rel = idx >= 0 ? abs.slice(idx + root.length + 1) : (abs.split('/').pop() ?? '');
  }
  const parts = rel.split('/').filter(Boolean);
  return parts
    .map(seg => stripStableId(seg))
    .join('/');
}

/* ── Publish operation ──────────────────────────────────────────────────── */

async function runPublish(ctx: RunContext, stats: RunStats): Promise<void> {
  const { settings, vocab, appendLog, addIssue } = ctx;
  const { sourceFolder, targetFolder, dryRun } = settings;

  if (!targetFolder) {
    appendLog('error', '  Target folder not set — skipping publish.');
    return;
  }

  const layout: DestExportLayout = ctx.localExportLayout ?? 'folders';
  const includePackages = layout === 'folders' && !!ctx.localIncludePackages;

  appendLog('section', `━━━ ${dryRun ? 'DRY RUN' : 'PUBLISHING'} ━━━`);
  appendLog('dim', `  → ${targetFolder}`);
  appendLog('dim', `  Layout: ${layout}${includePackages ? ' + nested packages' : ''} · always highest version only`);

  const livePub = new Set<string>();
  const vocabMap = buildVocabContext(vocab);

  async function copyOne(srcPath: string, fileDest: string, logName: string) {
    if (livePub.has(fileDest)) { stats.skipped += 1; return; }
    livePub.add(fileDest);
    const destParent = await dirname(fileDest);
    livePub.add(destParent);

    if (dryRun) {
      appendLog('success', `  [DRY] → ${logName}`);
      stats.published += 1;
      return;
    }
    try {
      await mkdir(destParent, { recursive: true });
      if (!await isUnchanged(srcPath, fileDest)) {
        await copyFile(srcPath, fileDest);
        appendLog('success', `  ✓  ${logName}`);
        stats.published += 1;
      } else {
        stats.skipped += 1;
      }
    } catch (err) {
      appendLog('error', `  ✕  publish failed: ${logName} — ${err}`);
      addIssue({ category: 'error', file: logName, reason: String(err) });
      stats.errors += 1;
    }
  }

  /* Nested packages: refresh package folder from OUT, then copy to destination. */
  async function publishNestedPackages() {
    const packages = await findPackageFolders(sourceFolder, settings);
    if (!packages.length) {
      appendLog('warn',
        `  No package folders found (prefix "${settings.packagePrefix}").`
        + ` OUT setting="${settings.outFolder}".`,
      );
      return;
    }
    appendLog('info', `  Nested packages: ${packages.length} folder(s)`);
    for (const pkg of packages) {
      const rel = nestedPublishRel(sourceFolder, pkg);
      const destPkg = await join(targetFolder, rel);
      stats.pubFolders += 1;
      livePub.add(destPkg);
      appendLog('section', `📦  ${rel}`);

      const sync = await syncPackageFromOut(
        pkg,
        settings,
        vocabMap,
        dryRun,
        appendLog,
        (file, reason) => addIssue({ category: 'error', file, reason }),
      );
      if (!sync.sources.length) {
        appendLog('warn', `  └─ package had no OUT files (looked for "${settings.outFolder}" / OUT)`);
        continue;
      }

      const liveNames = new Set<string>();
      appendLog('info', `  ✓  export ${sync.sources.map(p => p.split('/').pop()).join(', ')}`);

      for (const srcPath of sync.sources) {
        const rawName = srcPath.split('/').pop()!;
        const ext = rawName.includes('.') ? '.' + rawName.split('.').pop()! : '';
        const stem = ext ? rawName.slice(0, -ext.length) : rawName;
        const translated = translateExportName(stem, ext, vocabMap);
        liveNames.add(translated);
        await copyOne(srcPath, await join(destPkg, translated), `${rel}/${translated}`);
      }

      // Target 📦 = exact live mirror — wipe older versions / renamed tags (no 🚫).
      const wiped = await purgePackageMirror(
        destPkg, liveNames, settings, dryRun, appendLog, 'target package',
      );
      if (wiped) stats.disconnected += wiped;
    }
  }

  if (layout === 'flat') {
    appendLog('dim', '  Mode: flat (all files into target root)');
    let assets = (ctx.collectedAssets?.length
      ? ctx.collectedAssets
      : await scanAllAssets(sourceFolder, settings));
    const { kept, dropped } = keepOnlyHighestVersions(assets);
    assets = kept;
    if (dropped.length) appendLog('skip', `  ⊘  dropped ${dropped.length} older version(s)`);
    stats.pubFolders += 1;
    for (const srcPath of assets) {
      const rawName = srcPath.split('/').pop()!;
      if (!isPublishableFile(rawName) || rawName.includes('-thumb')) continue;
      const ext = rawName.includes('.') ? '.' + rawName.split('.').pop()! : '';
      const stem = ext ? rawName.slice(0, -ext.length) : rawName;
      const translated = translateExportName(stem, ext, vocabMap);
      await copyOne(srcPath, await join(targetFolder, translated), translated);
    }
  } else {
    appendLog('dim', '  Mode: full folders (OUT tree)');

    async function publishDir(dirPath: string, targetDir: string) {
      const items = await listDir(dirPath);
      const fileItems = items.filter(
        item => item.isFile && !shouldSkip(item.name, settings)
          && isPublishableFile(item.name) && !item.name.includes('-thumb'),
      );
      const paths = await Promise.all(fileItems.map(f => join(dirPath, f.name)));
      const { kept, dropped } = keepOnlyHighestVersions(paths);
      if (dropped.length) {
        appendLog('skip', `  ⊘  dropped ${dropped.map(p => p.split('/').pop()).join(', ')}`);
      }
      if (kept.length) {
        appendLog('info', `  ✓  export ${kept.map(p => p.split('/').pop()).join(', ')}`);
      }

      for (const fileSrc of kept) {
        const name = fileSrc.split('/').pop()!;
        const ext = name.includes('.') ? '.' + name.split('.').pop()! : '';
        const stem = ext ? name.slice(0, -ext.length) : name;
        const translated = translateExportName(stem, ext, vocabMap);
        await copyOne(fileSrc, await join(targetDir, translated), `${name} → ${translated}`);
      }
      for (const item of items) {
        if (shouldSkip(item.name, settings) || !item.isDirectory) continue;
        const subSrc    = await join(dirPath, item.name);
        const subTarget = await join(targetDir, item.name);
        livePub.add(subTarget);
        await publishDir(subSrc, subTarget);
      }
    }

    async function publishFolder(src: string, target: string) {
      const entries = await listDirLogged(src, appendLog);
      for (const e of entries) {
        if (shouldSkip(e.name, settings)) continue;
        if (!e.isDirectory) continue;
        // Package dirs next to OUT are handled by publishNestedPackages when enabled.
        if (isPackageFolder(e.name, settings)) continue;
        const childSrc = await join(src, e.name);

        if (isOutFolder(e.name, settings)) {
          stats.pubFolders += 1;
          await publishDir(childSrc, target);
        } else {
          const hasSiblingOut = entries.some(sib => sib.isDirectory && isOutFolder(sib.name, settings));
          if (hasSiblingOut) continue;
          await publishFolder(childSrc, await join(target, stripStableId(e.name)));
        }
      }
    }

    await publishFolder(sourceFolder, targetFolder);

    if (includePackages) {
      await publishNestedPackages();
    }
  }

  // Always scan for leftovers (even when every file was unchanged) so root package
  // dumps from older publish modes get disconnected.
  if (!dryRun) {
    await flagDisconnected(targetFolder, livePub, stats, appendLog, addIssue, {
      layout,
      settings,
    });
  }

  appendLog('section',
    `━━━ PUBLISH DONE — ${stats.published} published · ${stats.skipped} unchanged · ` +
    `${stats.disconnected} disconnected · ${stats.errors} errors ━━━`
  );
}

/* ── Thumbnail generation ───────────────────────────────────────────────── */

async function runThumbnails(ctx: RunContext, stats: RunStats): Promise<void> {
  const { settings, appendLog } = ctx;
  const { sourceFolder: source, thumbWidth, thumbQuality } = settings;

  if (!source) {
    appendLog('error', '  Source folder not set — skipping thumbnails.');
    return;
  }

  appendLog('section', '━━━ THUMBNAILS ━━━');
  const width   = parseInt(String(thumbWidth),  10) || 320;
  const quality = parseInt(String(thumbQuality), 10) || 70;

  // Use pre-scanned asset list (already collected at pipeline start), filter to thumbnable exts
  const files = (ctx.collectedAssets ?? [])
    .filter(f => THUMB_EXTS.has('.' + (f.split('.').pop() ?? '').toLowerCase()));

  if (!files.length) {
    appendLog('dim', '  No thumbnable files found.');
    return;
  }

  appendLog('info', `  Found ${files.length} file(s) — checking for existing thumbnails…`);

  type FileJob = { srcFile: string; fileName: string; destFile: string };
  const needsRegen: FileJob[] = [];
  let preSkipped = 0;

  const STAT_CONCURRENCY = 16;
  for (let i = 0; i < files.length; i += STAT_CONCURRENCY) {
    const batch = files.slice(i, i + STAT_CONCURRENCY);
    await Promise.all(batch.map(async srcFile => {
      const fileName = srcFile.split('/').pop()!;
      const dotIdx   = fileName.lastIndexOf('.');
      const stem     = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
      const dir      = srcFile.slice(0, srcFile.lastIndexOf('/') + 1);
      const destFile = dir + stem + '-thumb.webp';
      try {
        await stat(destFile);   // throws if not found → goes to needsRegen
        preSkipped += 1;
      } catch {
        needsRegen.push({ srcFile, fileName, destFile });
      }
    }));
  }

  // Show exact paths for first file so path computation can be verified in the log
  if (files.length > 0) {
    const s0 = files[0];
    const n0 = s0.split('/').pop()!;
    const d0 = s0.slice(0, s0.lastIndexOf('/') + 1) + n0.slice(0, n0.lastIndexOf('.')) + '-thumb.webp';
    appendLog('dim', `  src[0]:  ${s0}`);
    appendLog('dim', `  dest[0]: ${d0}`);
  }
  appendLog('dim', `  Pre-filter: ${preSkipped} exist · ${needsRegen.length} to generate`);

  const total = files.length;
  let done    = preSkipped;
  ctx.setProgress(Math.round((done / total) * 100));

  const CONCURRENCY = 8;
  for (let i = 0; i < needsRegen.length; i += CONCURRENCY) {
    const batch = needsRegen.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ srcFile, fileName, destFile }) => {
      try {
        const result = await invoke<boolean>('generate_thumbnail', { src: srcFile, dest: destFile, width, quality });
        if (result) {
          appendLog('success', `  ✓  ${fileName}`);
          stats.thumbnails += 1;
        } else {
          appendLog('dim', `  ↷  skipped (exists): ${fileName}`);
          stats.skipped += 1;
        }
      } catch (e) {
        appendLog('error', `  ✕  ${fileName} — ${e}`);
        stats.errors += 1;
      }
      ctx.setProgress(Math.round((++done / total) * 100));
    }));
  }

  appendLog('section', `━━━ THUMBNAILS DONE — ${stats.thumbnails} created · ${stats.errors} errors ━━━`);
}

/* Scan all publishable files in OUT folders. Parallel walk — all sibling dirs listed concurrently. */
async function scanAllAssets(root: string, s: AppSettings): Promise<string[]> {
  const results: string[] = [];

  async function walkForOut(dir: string) {
    const entries = await listDir(dir);
    const hasOut  = entries.some(e => e.isDirectory && isOutFolder(e.name, s));
    const dirs    = entries.filter(e => e.isDirectory && !shouldSkip(e.name, s) && !isPackageFolder(e.name, s));
    await Promise.all(dirs.map(async e => {
      const childPath = await join(dir, e.name);
      if (isOutFolder(e.name, s)) {
        await collectInOut(childPath);
      } else if (!hasOut) {
        await walkForOut(childPath);
      }
    }));
  }

  async function collectInOut(dir: string) {
    const entries = await listDir(dir);
    await Promise.all(entries.map(async e => {
      if (e.name.startsWith('.') || shouldSkip(e.name, s) || e.name.includes('-thumb')) return;
      if (e.isDirectory && e.name.toLowerCase() === 'versions') return; // versions/ handled separately in VH sync
      const childPath = await join(dir, e.name);
      if (e.isFile && isPublishableFile(e.name)) {
        results.push(childPath);
      } else if (e.isDirectory) {
        await collectInOut(childPath);
      }
    }));
  }

  await walkForOut(root);
  return results;
}

/* ── Version history scan ───────────────────────────────────────────────── */

function stripVersionSuffix(stem: string): string {
  return stem.replace(/\s+[vV]\d+(?:[-._]\d+)*\s*$/, '').trim();
}

function versionGt(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/i, '').split(/[._-]/).map(n => parseInt(n, 10) || 0);
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0, nb = pb[i] ?? 0;
    if (na !== nb) return na > nb;
  }
  return false;
}

export interface VersionEntry {
  file:      string;
  stem:      string;
  version:   string;
  shortcode: string;
}

export interface AssetVersions {
  current: VersionEntry | null;
  history: VersionEntry[];
}

export async function scanVersionMap(
  root:     string,
  vocab:    VocabularyData,
  settings: AppSettings,
): Promise<Map<string, AssetVersions>> {
  const vmap     = new Map<string, AssetVersions>();
  const vocabCtx = buildVocabContext(vocab);

  function addEntry(file: string, name: string, isHistory: boolean) {
    if (!isPublishableFile(name) || name.includes('-thumb')) return;
    const dot       = name.lastIndexOf('.');
    const stem      = dot > 0 ? name.slice(0, dot) : name;
    const parsed    = parseFilename(stem, vocabCtx);
    const version   = parsed.version ?? '';
    const shortcode = stripVersionSuffix(stem);
    const entry: VersionEntry = { file, stem, version, shortcode };
    const av = vmap.get(shortcode) ?? { current: null, history: [] };
    if (isHistory) {
      av.history.push(entry);
    } else {
      if (!av.current) {
        av.current = entry;
      } else if (versionGt(version, av.current.version)) {
        av.history.push(av.current);
        av.current = entry;
      } else {
        av.history.push(entry);
      }
    }
    vmap.set(shortcode, av);
  }

  async function walkForVH(dir: string) {
    const entries = await listDir(dir);
    const hasOut  = entries.some(e => e.isDirectory && isOutFolder(e.name, settings));
    await Promise.all(
      entries
        .filter(e => e.isDirectory && !shouldSkip(e.name, settings) && !isPackageFolder(e.name, settings))
        .map(async e => {
          const childPath = await join(dir, e.name);
          if (isOutFolder(e.name, settings)) {
            await collectFromDir(childPath, false);
            const versPath = await join(childPath, 'versions');
            await collectFromDir(versPath, true).catch(() => {}); // OK if absent
          } else if (!hasOut) {
            await walkForVH(childPath);
          }
        })
    );
  }

  async function collectFromDir(dir: string, isHistory: boolean) {
    const entries = await listDir(dir);
    await Promise.all(entries.map(async e => {
      if (e.name.startsWith('.') || shouldSkip(e.name, settings) || e.name.includes('-thumb')) return;
      const childPath = await join(dir, e.name);
      if (e.isFile) {
        addEntry(childPath, e.name, isHistory);
      } else if (e.isDirectory && e.name.toLowerCase() !== 'versions') {
        await collectFromDir(childPath, isHistory);
      }
    }));
  }

  await walkForVH(root);
  return vmap;
}




/* ── Local R2-upload cache — avoids hashing + a network HEAD for files that
   haven't changed since we last uploaded them. upload_to_r2's content-hash
   check (r2.rs) remains the correctness backstop for cache misses, first
   runs, or another machine having touched the object — this cache is purely
   a fast-path optimization on top of it, keyed by mtime+size (cheap local
   stat, no file read). A false cache hit is impossible to get wrong in a
   way that serves stale content: worst case a stale cache entry just causes
   an unnecessary but still-correct upload_to_r2 call. ───────────────────── */
interface R2CacheEntry { mtimeMs: number; size: number; sha256: string }
type R2Cache = Record<string, R2CacheEntry>;

let r2CacheMemo: R2Cache | null = null;

async function getR2CachePath(): Promise<string> {
  return await join(await appDataDir(), 'r2-upload-cache.json');
}

async function loadR2Cache(): Promise<R2Cache> {
  if (r2CacheMemo) return r2CacheMemo;
  try {
    const path = await getR2CachePath();
    r2CacheMemo = (await exists(path)) ? JSON.parse(await readTextFile(path)) : {};
  } catch {
    r2CacheMemo = {};
  }
  return r2CacheMemo!;
}

async function saveR2Cache(cache: R2Cache): Promise<void> {
  try {
    await writeTextFile(await getR2CachePath(), JSON.stringify(cache));
  } catch { /* best-effort — worst case is a slower next run, not incorrect behavior */ }
}

function r2CacheKey(bucket: string, objectKey: string): string {
  return `${bucket}::${objectKey}`;
}

function rememberR2Upload(
  cache: R2Cache, bucket: string, objectKey: string, mtimeMs: number, size: number, sha256: string,
): void {
  cache[r2CacheKey(bucket, objectKey)] = { mtimeMs, size, sha256 };
}

function r2PublicUrl(publicDomain: string, objectKey: string, contentHash?: string): string {
  const base = `${publicDomain.replace(/\/+$/, '')}/${objectKey}`;
  if (!contentHash) return base;
  return `${base}?v=${contentHash.slice(0, 12)}`;
}

/* ── Local cloud-export cache — same idea as R2: mtime+size fast-path so
   unchanged files skip without readFile / Drive list / Dropbox metadata.
   Network skip/upload remains the backstop on cache miss. ────────────────── */
interface CloudCacheEntry { mtimeMs: number; size: number; url?: string | null }
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
async function fetchR2KeyManifest(
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
function filterCdnEligible(paths: string[]): { kept: string[]; dropped: number } {
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

async function runCdnUpload(ctx: RunContext, stats: RunStats): Promise<void> {
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
    return { thumbPath: `${dir}${stem}-thumb.webp`, stem };
  });

  if (!thumbFiles.length) {
    appendLog('dim', '  No assets to upload.');
    return;
  }

  appendLog('dim', `  inventory map: ${ctx.cdnUrls?.size ?? 0} entries`);
  if (ctx.cdnUrls && ctx.cdnUrls.size > 0) {
    const sample = [...ctx.cdnUrls.keys()].slice(0, 2);
    appendLog('dim', `  sample stems: ${sample.map(s => `"${s}"`).join(', ')}`);
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
    await Promise.all(batch.map(async ({ thumbPath, stem }) => {
      // Check thumbnail exists locally before attempting upload
      let thumbInfo;
      try { thumbInfo = await stat(thumbPath); } catch {
        skipped += 1;
        return;
      }
      const fileName = thumbPath.split('/').pop()!;
      const identity = ctx.cdnIdentity?.get(stem);
      // Stable-identity key when resolved (rename-proof) — else today's filename-based key.
      const objectKey = storageKey(
        r2.keyPrefix,
        identity
          ? `thumbnails/${identity.stableId}/${identity.childId}.webp`
          : `thumbnails/${fileName}`,
      );

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
          ctx.cdnUrls.set(stem, r2PublicUrl(r2.publicDomain, objectKey, cacheEntry.sha256));
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
        if (ctx.cdnUrls) ctx.cdnUrls.set(stem, result.url);
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
   Keyed by stable identity (stableId/childId) when resolved — rename-proof, since
   that identity survives file/folder renames (see resolveCdnIdentity). Falls back to
   shortcode (version stripped) for legacy/unmigrated assets — not rename-proof, but
   still version-stable, so a new version's upload overwrites the last one's key rather
   than accumulating. Either way, upload_to_r2 only actually re-uploads when the file's
   content hash differs from what's already stored — unchanged re-runs are skipped. A
   small per-asset cleanup below handles the rare case where a version bump (or, for
   stable identity, an actual content-hash mismatch under the same key) changes the
   file extension. */
async function runOriginalUpload(ctx: RunContext, stats: RunStats): Promise<void> {
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
    const shortcode = stem.replace(/\s+[vV]\d+(?:[-._]\d+)*\s*$/, '').trim();
    return { srcPath, stem, ext, shortcode };
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

  // Identity by full filename first — extension-only variants (foo.pdf + foo.webp)
  // share a stem but carry distinct child ids in the manifest. Falling back to the
  // stem covers files scanned before per-file resolution existed.
  const withKeys = files.map(f => {
    const identity  = ctx.cdnIdentity?.get(`${f.stem}${f.ext}`) ?? ctx.cdnIdentity?.get(f.stem);
    const rel = identity ? `originals/${identity.stableId}/${identity.childId}` : `originals/${f.shortcode}`;
    const keyPrefix = storageKey(r2.keyPrefix, rel);
    return { ...f, keyPrefix, objectKey: `${keyPrefix}${f.ext}` };
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
          ctx.originalUrls.set(stem, r2PublicUrl(r2.publicDomain, objectKey, cacheEntry.sha256));
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
        // First writer wins per stem — extension variants share the stem, and a
        // deterministic pick (scan order) beats whichever batch happened to finish last.
        if (ctx.originalUrls && !ctx.originalUrls.has(stem)) ctx.originalUrls.set(stem, result.url);
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

/* ── CDN cleanup — remove stale thumbnails from R2 ─────────────────────── */

/** Full R2 reconcile — lists all objects and deletes stale ones. Use manually when DB is out of sync.
 * Not currently wired to any UI action. If `ctx.cdnIdentity` isn't already populated (e.g. by a
 * prior `resolveCdnIdentity` call on this same ctx), expected keys fall back to filename-based —
 * call `resolveCdnIdentity` first for accurate results on stable-identity clients. */
export async function reconcileCdn(ctx: RunContext, stats: RunStats): Promise<void> {
  const { r2, appendLog, collectedAssets } = ctx;
  if (!r2) return;

  appendLog('section', '━━━ CDN CLEANUP ━━━');

  // Keys that should exist — one per collected asset. Mirrors runCdnUpload's key logic
  // exactly (stable-identity when resolved, filename-based fallback otherwise) so this
  // never mistakes a current object under the new scheme for a stale one.
  const expectedKeys = new Set(
    (collectedAssets ?? []).map(srcPath => {
      const fileName = srcPath.split('/').pop()!;
      const stem     = fileName.substring(0, fileName.lastIndexOf('.'));
      const identity = ctx.cdnIdentity?.get(stem);
      return storageKey(
        r2.keyPrefix,
        identity
          ? `thumbnails/${identity.stableId}/${identity.childId}.webp`
          : `thumbnails/${stem}-thumb.webp`,
      );
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

/* ── Cloud export ───────────────────────────────────────────────────────── */

function mimeFromExt(ext: string): string {
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

async function runCloudExport(ctx: RunContext, stats: RunStats): Promise<void> {
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
  const vocabMap = buildVocabContext(vocab);
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
            throw new Error(`Cannot stat ${srcPath}: ${e}`);
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
            url = await uploadOneDriveFile(cfg.token!.accessToken, bytes, remote, dest.generateLink);
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

/* ── Main entry point ───────────────────────────────────────────────────── */

export async function runPipeline(ctx: RunContext): Promise<RunStats> {
  const { settings, appendLog, finishRun } = ctx;

  const stats: RunStats = {
    packages: 0, copied: 0, skipped: 0, errors: 0,
    pubFolders: 0, published: 0, thumbnails: 0, notes: 0, disconnected: 0,
    cdnThumbUploaded: 0, cdnThumbCached: 0, cdnThumbUnchanged: 0,
    cdnOrigUploaded: 0, cdnOrigCached: 0, cdnOrigUnchanged: 0,
  };

  try {
    // Single scan — shared by thumbnails (filtered) and Supabase sync (all stems)
    if (settings.sourceFolder) {
      const scanned = await scanAllAssets(settings.sourceFolder, settings);
      ctx.collectedAssets?.push(...scanned);
    }

    // Resolve rename-proof CDN identity before any CDN step runs, so those steps can key
    // by it instead of the current filename. Gated the same as the CDN steps themselves
    // (r2 configured, and thumbnails/originals actually enabled) so this cost is only ever
    // paid when its result will actually be used.
    if (ctx.identityMigrated && ctx.r2 && (settings.doThumbnails || settings.doCdnOriginals)) {
      try {
        ctx.cdnIdentity = await resolveCdnIdentity(ctx.collectedAssets ?? [], settings.outFolder || 'OUT');
      } catch (e) {
        appendLog('error', `  ✕  CDN identity resolution failed, falling back to filename-based keys: ${e}`);
      }
    }

    if (settings.doThumbnails) await runThumbnails(ctx, stats);
    if (settings.doThumbnails && ctx.r2) await runCdnUpload(ctx, stats);
    if (settings.doCdnOriginals && ctx.r2) await runOriginalUpload(ctx, stats);
    if (settings.doDistribute) await runDistribute(ctx, stats);
    if (settings.doPublish)    await runPublish(ctx, stats);
    if (settings.doFlatExport) await runCloudExport(ctx, stats);
    if (settings.doObsidian) {
      await runObsidian(ctx, stats);
    }
  } catch (e) {
    appendLog('error', `Pipeline error: ${e}`);
    stats.errors += 1;
  }

  const hasIssues = stats.errors > 0 || stats.skipped > 0;
  finishRun(stats, hasIssues);
  return stats;
}
