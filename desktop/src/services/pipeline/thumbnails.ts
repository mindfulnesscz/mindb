/* THUMBNAILS stage — the -thumb.webp beside each thumbnable asset, plus per-page previews.
 *
 * Rendering itself is in Rust; this stage only decides what needs doing. Two paths:
 *
 *   rasters    `generate_thumbnail`. Rust compares the recorded source size+mtime and render
 *              settings before returning `cached`; existence alone is never treated as current.
 *   documents  `generate_document_previews`. Title thumbnail AND page previews from ONE LibreOffice
 *              conversion. Deliberately NOT pre-filtered by a stat: currency depends on the
 *              source's mtime/size, the page limit and the output settings, and a directory listing
 *              sees none of those. Rust owns that call via pages.json and reports `cached` back.
 */

import { invoke } from '@tauri-apps/api/core';
import type { RunContext, RunStats } from './types';
import { THUMB_EXTS, PAGE_PREVIEW_EXTS, extensionOf, DEFAULT_PREVIEW_PAGE_LIMIT } from './naming';

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
  /* Per-client cap on how many pages get previewed, owned by the portal admin. Absent means the
     client row has not been read yet (or predates the column), so fall back to the documented
     default rather than rendering an unbounded number of pages. */
  const pageLimit = ctx.previewPageLimit ?? DEFAULT_PREVIEW_PAGE_LIMIT;

  // Use pre-scanned asset list (already collected at pipeline start), filter to thumbnable exts
  const files = (ctx.collectedAssets ?? [])
    .filter(f => THUMB_EXTS.has('.' + (f.split('.').pop() ?? '').toLowerCase()));

  if (!files.length) {
    appendLog('dim', '  No thumbnable files found.');
    return;
  }

  if (settings.dryRun) {
    appendLog('dim', `  [DRY] would generate thumbnails/previews for ${files.length} file(s)`);
    stats.thumbnails += files.length;
    return;
  }

  appendLog('info', `  Found ${files.length} file(s) — checking for existing thumbnails…`);

  /* Documents get per-page previews as well as a title thumbnail, and BOTH come out of one Rust
     call — `generate_document_previews` reuses a single LibreOffice conversion, which costs ~6.4s
     per deck against ~28ms per rasterised page. Splitting them across two calls would nearly double
     the cost of every document in the library.

     They are also not pre-filtered by a stat here: whether previews are current depends on the
     source's mtime/size, the page limit and the output settings, none of which a directory listing
     can see. Rust owns that decision via pages.json and reports `cached` back. */
  type FileJob = { srcFile: string; fileName: string; destFile: string; pagesDir?: string };
  const rasterJobs: FileJob[] = [];
  const docJobs: FileJob[] = [];

  for (const srcFile of files) {
    if (ctx.isStopping?.()) return;
    const fileName = srcFile.split('/').pop()!;
    const dotIdx   = fileName.lastIndexOf('.');
    const stem     = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
    const dir      = srcFile.slice(0, srcFile.lastIndexOf('/') + 1);
    const destFile = dir + stem + '-thumb.webp';

    if (PAGE_PREVIEW_EXTS.has(extensionOf(fileName))) {
      // The previews folder shares the thumbnail's `-thumb` stem, which is what keeps it out of
      // every walker and every package (see isPreviewArtifact).
      docJobs.push({ srcFile, fileName, destFile, pagesDir: dir + stem + '-thumb' });
    } else {
      // The native command owns the source fingerprint and render-settings cache. Calling it for
      // an existing thumbnail is cheap and is what lets it detect restored/changed source bytes.
      rasterJobs.push({ srcFile, fileName, destFile });
    }
  }

  // Show exact paths for first file so path computation can be verified in the log
  if (files.length > 0) {
    const s0 = files[0];
    const n0 = s0.split('/').pop()!;
    const d0 = s0.slice(0, s0.lastIndexOf('/') + 1) + n0.slice(0, n0.lastIndexOf('.')) + '-thumb.webp';
    appendLog('dim', `  src[0]:  ${s0}`);
    appendLog('dim', `  dest[0]: ${d0}`);
  }
  appendLog('dim',
    `  Jobs: ${rasterJobs.length} raster(s) · ${docJobs.length} document(s)`);

  const total = files.length;
  let done    = 0;
  ctx.setProgress(Math.round((done / total) * 100));

  const CONCURRENCY = 8;
  for (let i = 0; i < rasterJobs.length; i += CONCURRENCY) {
    if (ctx.isStopping?.()) return;
    const batch = rasterJobs.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ srcFile, fileName, destFile }) => {
      try {
        const result = await invoke<boolean>('generate_thumbnail', { src: srcFile, dest: destFile, width, quality });
        if (result) {
          appendLog('success', `  ✓  ${fileName}`);
          stats.thumbnails += 1;
        } else {
          appendLog('dim', `  ↷  thumbnail current: ${fileName}`);
          stats.skipped += 1;
        }
      } catch (e) {
        appendLog('error', `  ✕  ${fileName} — ${e}`);
        stats.errors += 1;
      }
      ctx.setProgress(Math.round((++done / total) * 100));
    }));
  }

  /* Documents: title thumbnail + page previews, one Rust call each. Concurrency stays at 8 to match
     the rest of the pipeline — each call spawns exactly one render worker, and PDFium is only safe
     one-per-process (see render.rs). */
  for (let i = 0; i < docJobs.length; i += CONCURRENCY) {
    if (ctx.isStopping?.()) return;
    const batch = docJobs.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ srcFile, fileName, destFile, pagesDir }) => {
      try {
        const r = await invoke<{ total: number; rendered: number; cached: boolean }>(
          'generate_document_previews',
          { src: srcFile, thumb: destFile, pagesDir, width, quality, limit: pageLimit },
        );
        if (r.cached) {
          appendLog('dim', `  ↷  previews current: ${fileName} (${r.rendered}/${r.total})`);
          stats.skipped += 1;
        } else {
          // `total` beyond `rendered` is not an error — it is what the portal turns into "download
          // the asset to see the rest", so surface it rather than hiding the cap.
          const capped = r.total > r.rendered ? ` of ${r.total}` : '';
          appendLog('success', `  ✓  ${fileName} — ${r.rendered} page${r.rendered === 1 ? '' : 's'}${capped}`);
          stats.thumbnails += 1;
          stats.pagePreviews += r.rendered;
        }
        if (ctx.pageCounts) ctx.pageCounts.set(srcFile, { total: r.total, rendered: r.rendered });
      } catch (e) {
        appendLog('error', `  ✕  ${fileName} — ${e}`);
        stats.errors += 1;
      }
      ctx.setProgress(Math.round((++done / total) * 100));
    }));
  }

  appendLog('section',
    `━━━ THUMBNAILS DONE — ${stats.thumbnails} created · ${stats.pagePreviews} page preview(s) · ${stats.errors} errors ━━━`);
}

/* Scan all publishable files in OUT folders. Parallel walk — all sibling dirs listed concurrently. */
