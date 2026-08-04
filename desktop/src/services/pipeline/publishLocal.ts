/* PUBLISH stage (runPublish) — mirror OUT into the client-visible target, then reconcile.
 *
 * Two layouts: `folders` preserves the OUT tree (stable-id suffixes stripped from folder names,
 * since identity is internal); `flat` dumps everything into the target root.
 * 
 * Reconciliation is deliberately asymmetric, and both halves are characterized:
 *   - OUTSIDE a package folder, a file no longer in source is RENAMED with a 🚫 prefix. Nothing
 *     is destroyed — the client keeps the file, just marked.
 *   - INSIDE a 📦 mirror it is hard-deleted, because a pickup folder must not carry leftovers.
 * 
 * Dry run returns before reconciliation entirely, so no rename is previewed.
 */

import { copyFile, mkdir, rename, remove } from '@tauri-apps/plugin-fs';
import { join, dirname } from '@tauri-apps/api/path';
import type { AppSettings } from '../../store/settingsStore';
import type { LogType } from '../../store/pipelineStore';
import { buildVocabMap, translateExportName, stripStableId } from '@sotto/domain';
import type { RunContext, RunStats } from './types';
import type { DestExportLayout } from '../../domain/client';
import { shouldSkip, isPackageFolder, isOutFolder, isPublishableFile } from './naming';
import { listDir, listDirLogged, isUnchanged } from './fs';
import { findPackageFolders, syncPackageFromOut, keepOnlyHighestVersions, purgePackageMirror } from './packages';
import { scanAllAssets } from './scan';

/* ── Disconnected / orphan detection ───────────────────────────────────── */

export async function flagDisconnected(
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
export function nestedPublishRel(sourceRoot: string, absPath: string): string {
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

export async function runPublish(ctx: RunContext, stats: RunStats): Promise<void> {
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
  const vocabMap = buildVocabMap(vocab);

  // srcPath that already claimed each destination this run — so a second source translating
  // to the same target name is reported rather than silently counted as unchanged (F-6).
  // Most visible in flat layout, where the folder tree can no longer disambiguate names.
  const claimedDests = new Map<string, string>();

  async function copyOne(srcPath: string, fileDest: string, logName: string) {
    const claimedBy = claimedDests.get(fileDest);
    if (claimedBy) {
      const reason =
        `Two sources publish to the same target "${fileDest.split('/').pop()}": `
        + `"${claimedBy.split('/').pop()}" was published, "${srcPath.split('/').pop()}" was NOT.`;
      appendLog('error', `  ✕  name collision — ${reason}`);
      addIssue({ category: 'error', file: logName, reason });
      stats.errors += 1;
      return;
    }
    claimedDests.set(fileDest, srcPath);

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

