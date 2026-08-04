/* COLLECT stage (runDistribute) — fill 📦 anchors from surrounding OUT folders.
 *
 * A thin loop over the discovered package folders; all the real work (harvest, version filter,
 * translate, purge, copy) lives in ./packages, which is where the destructive part is.
 */

import { basename } from '@tauri-apps/api/path';
import { buildVocabMap } from '@sotto/domain';
import type { RunContext, RunStats } from './types';
import { findPackageFolders, syncPackageFromOut } from './packages';

/* ── Distribute operation ───────────────────────────────────────────────── */

export async function runDistribute(ctx: RunContext, stats: RunStats): Promise<void> {
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
  const vocabMap = buildVocabMap(ctx.vocab);

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

