/* The run itself: everything that happens between the Run button and the completion notification.
 *
 * Three things happen around `runPipeline` that are easy to mistake for part of it:
 *
 *   BEFORE  the portal vocabulary is refreshed (the portal owns tag LABELS, so a stale local cache
 *           would name files with the old label), and a short-lived, client-scoped R2 grant is
 *           requested — no permanent storage credentials exist on this machine;
 *   AFTER   the assets are synced to Supabase, the CDN objects the sync reports as stale are deleted
 *           (a targeted diff, not an R2 listing), and version history is rebuilt.
 *
 * A failed grant DEGRADES the run — the CDN stages are skipped and logged — rather than aborting it,
 * because the local and cloud exports are still useful to the operator.
 */

import { useSettingsStore } from '../../store/settingsStore';
import { usePipelineStore } from '../../store/pipelineStore';
import { useVocabularyStore } from '../../store/vocabularyStore';
import { useClientStore } from '../../store/clientStore';
import { resolveExportShape } from '../../domain/client';
import type { CloudDestination } from '../../domain/client';
import { runPipeline, scanVersionMap, deleteCdnObjects, type RunContext } from '../../services/pipelineService';
import type { CloudUrlEntry } from '../../services/pipelineService';
import {
  exportAssetsToSupabase, syncVersionHistory, syncTagsFromVocabulary, requestR2Grant,
  fetchAssetLevels, fetchPreviewPageLimit, reconcileCdnObjects, syncStreamVideos,
} from '../../services/supabaseService';
import { loadVocabulary } from '../../services/vocabService';
import { notifyRunComplete } from '../../services/notifyService';
import { groupAssets, type VocabularyData } from '@sotto/domain';
import { resolveRunPlan } from './runPlan';

export function useRunPipeline(selectedDests: CloudDestination[]): () => Promise<void> {
  const settings = useSettingsStore(s => s.settings);
  const vocab    = useVocabularyStore(s => s.data);
  const { startRun, appendLog, addIssue, finishRun, setProgress, setSupabaseSync } = usePipelineStore();
  const { clients, activeClientId } = useClientStore();
  const activeClient = clients.find(c => c.id === activeClientId) ?? null;

  return async function handleRun() {
    startRun();
    const { effectiveSettings, localDest: runLocalDest, cloudDests } = resolveRunPlan(settings, selectedDests);

    const collectedAssets: string[] = [];
    const sourceReadErrors = new Set<string>();
    const cdnUrls      = new Map<string, string>();
    const originalUrls = new Map<string, string>();
    const cloudUrls    = new Map<string, CloudUrlEntry[]>();
    /* Page counts from the render step, carried to the Supabase sync so the portal knows how many
       pages it can show and how many the document actually has. */
    const pageCounts   = new Map<string, { total: number; rendered: number }>();

    /* ── Pre-run: vocabulary, then the storage grant ─────────────────────────── */
    // The client IS a DB row — its id is the identity, no name resolution. Sync runs as the
    // signed-in user under the RLS staff policies; no service key is present.
    const sbEnabled = !!(activeClient?.supabaseUrl && activeClient?.supabaseAnonKey);
    const sbConfig  = sbEnabled ? {
      url:     activeClient!.supabaseUrl!,
      anonKey: activeClient!.supabaseAnonKey!,
    } : null;
    const clientId: string | null = sbConfig ? activeClient!.id : null;
    const log = appendLog as (type: string, msg: string) => void;

    // Portal tags are the source of truth for labels, so refresh before the run: asset names and
    // export translation must pick up hub renames (Handover → Handout). Local UNPUBLISHED edits win
    // instead — those get published after the sync below.
    const vocabDirty =
      useVocabularyStore.getState().dirty || !!useVocabularyStore.getState().data?._unpublished;
    let vocabData = vocab ?? { _schema_version: '2.1.0', _comment: '', tags: [] };
    let vocabFresh = false;
    if (clientId && !vocabDirty) {
      try {
        const fresh = await loadVocabulary(clientId, {
          forceFromDb: true,
          persistCache: !effectiveSettings.dryRun,
          requireDb: true,
        });
        vocabData = fresh;
        vocabFresh = true;
        useVocabularyStore.getState().setData(fresh, { dirty: false });
        log('dim', '  Vocabulary refreshed from portal');
      } catch (e) {
        log('warn', `  Vocabulary refresh skipped — using cached labels (${e})`);
      }
    } else if (vocabDirty) {
      log('dim', '  Using local unpublished vocabulary (will publish leaves after sync)');
    }

    let r2Config: RunContext['r2'];
    let assetLevels: Map<string, string> | undefined;
    let previewPageLimit: number | undefined;
    if (sbConfig && clientId && !effectiveSettings.dryRun
        && (effectiveSettings.doThumbnails || effectiveSettings.doCdnOriginals)) {
      try {
        const grant = await requestR2Grant(sbConfig, clientId);
        // A pipeline grant without the gated half means the environment is half-provisioned.
        // Refusing here is the point: uploading anyway would put client and internal assets on
        // the public domain, and the run would report success.
        if (!grant.gatedBucket || !grant.gatedDomain || !grant.gatedAccessKeyId) {
          throw new Error(
            'storage grant has no gated tier — set R2_GATED_BUCKET and R2_GATED_DOMAIN function '
            + 'secrets for this environment. Refusing to publish to the public bucket.',
          );
        }
        r2Config = {
          endpoint:     grant.endpoint,
          accessKeyId:  grant.accessKeyId,
          secretKey:    grant.secretAccessKey,
          sessionToken: grant.sessionToken,
          bucket:       grant.bucket,
          publicDomain: grant.publicDomain,
          keyPrefix:    grant.keyPrefix,
          clientId:     grant.clientId ?? clientId,
          gatedBucket:       grant.gatedBucket,
          gatedDomain:       grant.gatedDomain,
          gatedAccessKeyId:  grant.gatedAccessKeyId,
          gatedSecretKey:    grant.gatedSecretAccessKey!,
          gatedSessionToken: grant.gatedSessionToken!,
        };
        log('dim', `  Storage grant issued for "${activeClient!.name}" (public ${grant.bucket} · gated ${grant.gatedBucket}, expires ${new Date(grant.expiresAt).toLocaleTimeString()})`);

        /* Object keys carry the access level, so the upload stages need each asset's CURRENT
           level before they write — and `perm` is portal-owned, so the database is the only place
           that knows it. Fetched once per run. An empty map (a failed read) means every asset is
           treated as new and written at the create-time default: the restrictive direction, and
           the reconciler picks up anything that lands wrong. */
        assetLevels = await fetchAssetLevels(clientId, sbConfig);
        log('dim', `  ${assetLevels.size} known asset level(s) loaded for key routing`);

        /* How many pages of a document get previewed is an admin setting on the client row, so it
           comes from the same place `perm` does. A failed read leaves it undefined and the pipeline
           uses the documented default rather than an unbounded render. */
        previewPageLimit = await fetchPreviewPageLimit(clientId, sbConfig) ?? undefined;
        if (previewPageLimit !== undefined) {
          log('dim', `  Page-preview limit for this client: ${previewPageLimit}`);
        }
      } catch (e) {
        log('error', `  ✕  CDN steps disabled — ${e}`);
      }
    }

    /* ── The pipeline ────────────────────────────────────────────────────────── */
    const stats = await runPipeline({
      settings: effectiveSettings,
      vocab:    vocabData,
      appendLog, addIssue, setProgress, finishRun,
      collectedAssets,
      sourceReadErrors,
      cdnUrls,
      originalUrls,
      assetLevels,
      previewPageLimit,
      pageCounts,
      cloudUrls,
      cloudDestinations: cloudDests,
      localExportLayout:    resolveExportShape(runLocalDest ?? {}).exportLayout,
      localIncludePackages: resolveExportShape(runLocalDest ?? {}).includePackages,
      r2: r2Config,
      isStopping: () => usePipelineStore.getState().runStatus === 'stopping',
      deferFinish: true,
    });

    /* ── Post-run: Supabase sync, targeted CDN cleanup, version history ──────── */
    try {
      if (sbConfig && clientId && usePipelineStore.getState().runStatus !== 'stopping') {
        await syncRunToPortal({
          effectiveSettings, collectedAssets, clientId, sbConfig, vocabData, vocabDirty, vocabFresh,
          cdnUrls, cloudUrls, originalUrls, pageCounts, r2Config, log, appendLog, setSupabaseSync,
          isStopping: () => usePipelineStore.getState().runStatus === 'stopping',
          sourceFresh: sourceReadErrors.size === 0,
        });
      } else if (usePipelineStore.getState().runStatus === 'stopping') {
        log('warn', '  ⏹  Stop requested — portal sync skipped.');
      }
    } catch (e) {
      log('error', `  ✕  Post-run sync failed: ${e}`);
      stats.errors += 1;
    }

    finishRun(stats, stats.errors > 0 || stats.skipped > 0);
    notifyRunComplete(stats, stats.errors > 0 || stats.skipped > 0);
  };
}

/* Extracted so the run reads as pre-run → pipeline → sync, rather than as one 130-line scroll. */
async function syncRunToPortal(a: {
  effectiveSettings: ReturnType<typeof resolveRunPlan>['effectiveSettings'];
  collectedAssets: string[];
  clientId: string;
  sbConfig: { url: string; anonKey: string };
  vocabData: VocabularyData;
  vocabDirty: boolean;
  vocabFresh: boolean;
  cdnUrls: Map<string, string>;
  cloudUrls: Map<string, CloudUrlEntry[]>;
  originalUrls: Map<string, string>;
  /** absPath → page-preview counts, so the sync can record them on the asset row. */
  pageCounts: Map<string, { total: number; rendered: number }>;
  r2Config: RunContext['r2'];
  log: (type: string, msg: string) => void;
  appendLog: ReturnType<typeof usePipelineStore.getState>['appendLog'];
  setSupabaseSync: ReturnType<typeof usePipelineStore.getState>['setSupabaseSync'];
  isStopping: () => boolean;
  sourceFresh: boolean;
}): Promise<void> {
  const outFolder = a.effectiveSettings.outFolder ?? 'OUT';
  const { singles, galleries, unpackaged } = groupAssets(a.collectedAssets, outFolder);

  for (const path of unpackaged) {
    a.log('error', `  ✕  "${path.split('/').pop()}" has no ${outFolder} folder above it — not an asset package. Skipped.`);
  }

  if (!singles.length && !galleries.length) {
    a.appendLog('info', 'Supabase: no assets found in source — skipping export.');
  } else {
    const sbResult = await exportAssetsToSupabase(
      singles, a.clientId, a.vocabData, a.sbConfig, a.log,
      a.cdnUrls, a.cloudUrls, galleries, a.originalUrls,
      a.effectiveSettings.allowLargeDeletions,
      a.pageCounts,
      a.effectiveSettings.dryRun,
      a.isStopping,
      a.sourceFresh,
    );
    a.setSupabaseSync({
      created:      sbResult.created,
      updated:      sbResult.updated,
      disconnected: sbResult.disconnected,
      errors:       sbResult.errors,
    });

    // Stale CDN objects come from the Supabase diff, so no R2 listing is needed.
    if (!a.isStopping() && a.r2Config && sbResult.staleObjectKeys.length > 0) {
      // A deleted object is unrecoverable, so it is judged against the same write count.
      await deleteCdnObjects(
        a.r2Config, sbResult.staleObjectKeys, a.log,
        sbResult.created + sbResult.updated, a.effectiveSettings.allowLargeDeletions,
        a.effectiveSettings.dryRun, a.isStopping,
      );
    }

    /* This run changed `status` — new rows published, absent files disconnected — and status is
       half of the access level, so some objects now belong at a different key. The trigger queued
       them; drain it here rather than leaving it for whoever next opens the portal. */
    if (!a.isStopping()) {
      if (a.effectiveSettings.dryRun) a.log('dim', '  [DRY] would drain CDN reconcile tasks');
      else await reconcileCdnObjects(a.sbConfig, a.log);
    }

    /* Videos onto Stream. AFTER the export, because a video is attached to an asset row and a
       brand-new asset has none until the export creates it; and after reconcile, so the master is
       already at the key its access level requires rather than one about to move. */
    if (!a.isStopping()) {
      await syncStreamVideos(a.sbConfig, a.clientId, a.log, {
        dryRun: a.effectiveSettings.dryRun,
        shouldStop: a.isStopping,
      });
    }

    // Only push leaves when desktop has unpublished edits — otherwise portal renames (the label
    // source of truth) would be overwritten by a stale local cache.
    if (a.vocabDirty && !a.isStopping()) {
      const tagResult = await syncTagsFromVocabulary(
        a.vocabData, a.clientId, a.sbConfig, a.log,
        {
          dryRun: a.effectiveSettings.dryRun,
          sourceFresh: a.vocabFresh && !a.vocabDirty,
          allowLargeDeletions: a.effectiveSettings.allowLargeDeletions,
          shouldStop: a.isStopping,
        },
      );
      if (!a.effectiveSettings.dryRun && !tagResult.deletionRefused) {
        useVocabularyStore.getState().markClean();
      }
    } else {
      a.log('dim', '  Tag sync skipped — portal vocabulary is already authoritative');
    }
  }

  if (a.effectiveSettings.sourceFolder && !a.isStopping()) {
    const versionMap = await scanVersionMap(a.effectiveSettings.sourceFolder, a.vocabData, a.effectiveSettings);
    await syncVersionHistory(versionMap, a.clientId, a.vocabData, a.sbConfig, a.log, {
      dryRun: a.effectiveSettings.dryRun,
      shouldStop: a.isStopping,
    });
  }
  if (a.isStopping()) a.log('warn', '  ⏹  Stop requested — remaining portal work skipped.');
}
