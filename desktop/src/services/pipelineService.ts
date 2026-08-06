/* Pipeline service — the run orchestrator, and the module every consumer imports.
 *
 * `runPipeline` is a coordinator and nothing else: it owns the stats object, the order the
 * stages run in, and the settings flags that gate each one. Every stage lives in ./pipeline/*
 * and is independently readable:
 *
 *   scan          source tree → the single asset list every later stage reads
 *   collect       fill 📦 anchors from surrounding OUT folders (destructive: mirror purge)
 *   publishLocal  mirror OUT into the client target, then reconcile (🚫 vs hard delete)
 *   artifactMigration  move a pre-3.2.2 library's loose render artifacts into thumbnails/
 *   thumbnails    generate each asset folder's thumbnails/ — sidecars and page previews
 *   cdnUpload     publish thumbnails + originals to R2 under identity-derived keys
 *   pagesUpload   publish per-page document previews (portal page viewer only)
 *   cdnCleanup    remove R2 objects identified as stale by the database sync
 *   cloudExport   push to Dropbox / OneDrive / Google Drive
 *
 * Stage ORDER is load-bearing, not incidental — see the comments inline.
 *
 * This file re-exports the types and entry points its consumers already import, so splitting
 * the implementation did not ripple into PipelineView, damService or supabaseService.
 */

import type { RunStats } from '../store/pipelineStore';
import { resolveCdnIdentity } from './supabaseService';
import { runObsidian } from './damService';

import type { RunContext } from './pipeline/types';
import { scanAllAssets } from './pipeline/scan';
import { runDistribute } from './pipeline/collect';
import { runPublish } from './pipeline/publishLocal';
import { runArtifactMigration } from './pipeline/artifactMigration';
import { runThumbnails } from './pipeline/thumbnails';
import { runCdnUpload, runPagesUpload, runOriginalUpload } from './pipeline/cdnUpload';
import { runCloudExport } from './pipeline/cloudExport';

/* ── Public surface ───────────────────────────────────────────────────────────
   Consumers import from here, not from ./pipeline/*, so the internal layout stays free to
   move. Types come from ./pipeline/types — importing them from this module would put
   damService and supabaseService back in a cycle with the orchestrator. */
export type {
  RunContext, CloudUrlEntry, R2Config, VersionEntry, AssetVersions,
} from './pipeline/types';
export { scanVersionMap } from './pipeline/scan';
export { deleteCdnObjects } from './pipeline/cdnCleanup';

/* ── Main entry point ─────────────────────────────────────────────────────── */


export async function runPipeline(ctx: RunContext): Promise<RunStats> {
  const { settings, appendLog, finishRun } = ctx;
  let stopReported = false;
  const stopping = (checkpoint: string): boolean => {
    if (!ctx.isStopping?.()) return false;
    if (!stopReported) {
      appendLog('warn', `  ⏹  Stop requested — halted before ${checkpoint}.`);
      stopReported = true;
    }
    return true;
  };

  const stats: RunStats = {
    packages: 0, copied: 0, skipped: 0, errors: 0,
    pubFolders: 0, published: 0, thumbnails: 0, pagePreviews: 0, notes: 0, disconnected: 0,
    cdnThumbUploaded: 0, cdnThumbCached: 0, cdnThumbUnchanged: 0,
    cdnPagesUploaded: 0, cdnPagesCached: 0, cdnPagesUnchanged: 0,
    cdnOrigUploaded: 0, cdnOrigCached: 0, cdnOrigUnchanged: 0,
  };

  try {
    // Single scan — shared by thumbnails (filtered) and Supabase sync (all stems)
    if (settings.sourceFolder) {
      ctx.sourceReadErrors ??= new Set<string>();
      const scanned = await scanAllAssets(settings.sourceFolder, settings, (path, error) => {
        ctx.sourceReadErrors?.add(path);
        appendLog('error', `  ✕  Cannot read source directory: ${path}\n     ${error}`);
      });
      ctx.collectedAssets?.push(...scanned);
    }

    // Resolve folder identity before anything stores an asset URL. CDN objects and cloud sharing
    // links both use stable_id/child_id, never the current filename, so equal stems in different
    // packages cannot overwrite each other.
    const needsAssetIdentity = (ctx.r2 && (settings.doThumbnails || settings.doCdnOriginals))
      || settings.doFlatExport;
    if (!settings.dryRun && !stopping('asset identity resolution') && needsAssetIdentity) {
      try {
        ctx.cdnIdentity = await resolveCdnIdentity(ctx.collectedAssets ?? [], settings.outFolder || 'OUT');
      } catch (e) {
        appendLog('error', `  ✕  Asset identity resolution failed — uploads cannot attach URLs to affected assets: ${e}`);
      }
    }

    /* Before the render stage, and gated on the same setting: every stage below reads artifacts at
       their CURRENT location, so an unmigrated library would re-render everything and then upload
       it. Cheap on a migrated one — one directory listing per asset folder and no moves. */
    if (settings.doThumbnails && !stopping('artifact layout migration')) {
      await runArtifactMigration(ctx, stats);
    }
    if (settings.doThumbnails && !stopping('thumbnail generation')) await runThumbnails(ctx, stats);
    if (settings.doThumbnails && !stopping('CDN thumbnail upload')) {
      if (settings.dryRun && !ctx.r2) appendLog('dim', '  [DRY] would upload thumbnails to CDN');
      else if (ctx.r2) await runCdnUpload(ctx, stats);
    }
    /* After the thumbnail upload, and gated on the same setting that produced the previews. R2 is
       the ONLY place page previews are published — they are deliberately excluded from packages and
       target destinations — so without this the portal's page viewer has nothing to read. */
    if (settings.doThumbnails && !stopping('CDN page-preview upload')) {
      if (settings.dryRun && !ctx.r2) appendLog('dim', '  [DRY] would upload and reconcile CDN page previews');
      else if (ctx.r2) await runPagesUpload(ctx, stats);
    }
    if (settings.doCdnOriginals && !stopping('CDN original upload')) {
      if (settings.dryRun && !ctx.r2) appendLog('dim', '  [DRY] would upload originals to CDN');
      else if (ctx.r2) await runOriginalUpload(ctx, stats);
    }
    if (settings.doDistribute && !stopping('package distribution')) await runDistribute(ctx, stats);
    if (settings.doPublish && !stopping('local publish')) await runPublish(ctx, stats);
    if (settings.doFlatExport && !stopping('cloud export')) await runCloudExport(ctx, stats);
    if (settings.doObsidian && !stopping('DAM publish')) {
      await runObsidian(ctx, stats);
    }
  } catch (e) {
    appendLog('error', `Pipeline error: ${e}`);
    stats.errors += 1;
  }

  const hasIssues = stats.errors > 0 || stats.skipped > 0;
  if (!ctx.deferFinish) finishRun(stats, hasIssues);
  return stats;
}
