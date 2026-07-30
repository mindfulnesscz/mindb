/* THUMBNAILS stage — generate the -thumb.webp beside each thumbnable asset.
 *
 * Generation itself is a Rust command (generate_thumbnail); this stage only decides which files
 * need one. Existing thumbnails are detected by a stat and skipped, so re-runs are cheap.
 */

import { stat } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import type { RunContext, RunStats } from './types';
import { THUMB_EXTS } from './naming';

/* ── Thumbnail generation ───────────────────────────────────────────────── */

export async function runThumbnails(ctx: RunContext, stats: RunStats): Promise<void> {
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
