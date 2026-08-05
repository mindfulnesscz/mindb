/* Package (📦) discovery, harvest and mirror purge.
 *
 * The most destructive code in the product: purgePackageMirror HARD-DELETES anything in a
 * package folder that is not part of the current deliverable set, from a folder the client picks
 * up from, with no undo.
 * 
 * Two guards keep that safe and are covered by pipelineCollect.characterization.test.ts:
 *   - syncPackageFromOut returns early when the OUT harvest is EMPTY, so an unreadable or empty
 *     source can never be read as "nothing is live" and wipe the mirror.
 *   - the purge skips dotfiles (.dchub.json holds the identity manifest) and extension-less files.
 */

import { copyFile, mkdir, remove, exists } from '@tauri-apps/plugin-fs';
import { join, dirname } from '@tauri-apps/api/path';
import type { AppSettings } from '../../store/settingsStore';
import type { LogType } from '../../store/pipelineStore';
import { filterHighestVersions, buildVocabMap, translateExportName, isPreviewArtifact } from '@dc-hub/domain';
import { shouldSkip, isPackageFolder, isOutFolder, isPublishableFile } from './naming';
import { listDir, collectFiles, isUnchanged } from './fs';

/* ── Package folder discovery ───────────────────────────────────────────── */

/**
 * Only folders matching the configured package prefix (e.g. `📦` / `[00] 📦`).
 * Migrated `Name __hash` asset folders and `.dchub.json` are NOT packages —
 * treating them as such made Collect a no-op on prod and skipped their OUT
 * when filling real 📦 anchors.
 */
export async function findPackageFolders(root: string, s: AppSettings): Promise<string[]> {
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
export function keepOnlyHighestVersions(paths: string[]): { kept: string[]; dropped: string[] } {
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
export async function purgePackageMirror(
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
        /* A previews folder has no business in a package mirror. Purging it as a unit also removes
           the now-empty directory, which a file-by-file purge would leave behind. */
        if (isPreviewArtifact(e.name)) {
          purgeRels.add(childRel);
          continue;
        }
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
export async function syncPackageFromOut(
  pkg: string,
  s: AppSettings,
  vocabMap: ReturnType<typeof buildVocabMap>,
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

  // Destinations already claimed this run. Two OUT files can translate to the SAME package
  // filename (different shortcodes rendering to one label, or the same name harvested from
  // two identity folders). Without this the second copy lost the isUnchanged() mtime
  // comparison against the copy just made and was silently counted as "unchanged" — its
  // content never reached the client and nothing was reported (F-6). Keep the first writer
  // and surface the collision as an issue instead.
  const claimedDests = new Map<string, string>();

  for (const srcFile of result.sources) {
    const rawName = srcFile.split('/').pop()!;
    if (rawName.includes('-thumb')) continue;
    const ext = rawName.includes('.') ? '.' + rawName.split('.').pop()! : '';
    const stem = ext ? rawName.slice(0, -ext.length) : rawName;
    const translated = translateExportName(stem, ext, vocabMap);
    const destFile = await join(pkg, translated);

    const claimedBy = claimedDests.get(destFile);
    if (claimedBy) {
      const reason =
        `Two OUT files translate to the same package name "${translated}": `
        + `"${claimedBy}" was packaged, "${rawName}" was NOT. Rename one, or give them `
        + `distinct shortcodes/versions.`;
      appendLog('error', `  ✕  name collision — ${reason}`);
      onError?.(rawName, reason);
      result.errors += 1;
      continue;
    }
    claimedDests.set(destFile, rawName);

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

