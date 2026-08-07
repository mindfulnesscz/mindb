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
 *
 * Two things here are deliberately NOT in the order they read in:
 *   - the four pre-run reads are dispatched together (see ./preRun.ts) — they share nothing, so the
 *     run waits for the slowest instead of the sum, while still applying and logging them in order;
 *   - the version-history walk that feeds `syncVersionHistory` is started by `runPipeline` right
 *     after the source scan and merely AWAITED down here, so a full second pass over the source
 *     tree happens under the network stages instead of after them.
 */

import { useSettingsStore } from '../../store/settingsStore';
import { usePipelineStore } from '../../store/pipelineStore';
import { useVocabularyStore } from '../../store/vocabularyStore';
import { useClientStore } from '../../store/clientStore';
import { resolveExportShape } from '../../domain/client';
import type { CloudDestination } from '../../domain/client';
import { runPipeline, scanVersionMap, deleteCdnObjects, type RunContext } from '../../services/pipelineService';
import type { CloudUrlEntry, VersionScanResult } from '../../services/pipelineService';
import {
  exportAssetsToSupabase, syncVersionHistory, syncTagsFromVocabulary,
  reconcileCdnObjects, syncStreamVideos,
} from '../../services/supabaseService';
import { notifyRunComplete } from '../../services/notifyService';
import { groupAssets, type VocabularyData } from '@sotto/domain';
import { resolveRunPlan } from './runPlan';
import { refreshRunVocabulary, loadCdnPrerequisites } from './preRun';
import { beginRunTimeline, endRunTimeline, logRunTimeline, timePhase } from '../../services/pipeline/timing';
import {
  buildRunRecord, findBaseline, loadRunTimings, appendRunTiming, toBaseline,
} from '../../services/pipeline/runTimings';

/* Stamped into each run record so a timing can be attributed to the build that produced it —
   an "everything got slower" report is only actionable with the version attached. */
const APP_VERSION = __APP_VERSION__;

export function useRunPipeline(selectedDests: CloudDestination[]): () => Promise<void> {
  const settings = useSettingsStore(s => s.settings);
  const vocab    = useVocabularyStore(s => s.data);
  /* One selector per action, not `usePipelineStore()`. Subscribing to the whole store made the
     component holding this hook re-render on every log line the run appended — thousands of
     renders of the pipeline view, caused by the run and competing with it. Actions are stable
     references, so these subscriptions never fire. */
  const startRun        = usePipelineStore(s => s.startRun);
  const appendLog       = usePipelineStore(s => s.appendLog);
  const addIssue        = usePipelineStore(s => s.addIssue);
  const finishRun       = usePipelineStore(s => s.finishRun);
  const setProgress     = usePipelineStore(s => s.setProgress);
  const setSupabaseSync = usePipelineStore(s => s.setSupabaseSync);
  const { clients, activeClientId } = useClientStore();
  const activeClient = clients.find(c => c.id === activeClientId) ?? null;

  return async function handleRun() {
    startRun();
    beginRunTimeline();
    const { effectiveSettings, localDest: runLocalDest, cloudDests } = resolveRunPlan(settings, selectedDests);

    const collectedAssets: string[] = [];
    const sourceReadErrors = new Set<string>();
    const cdnUrls      = new Map<string, string>();
    const originalUrls = new Map<string, string>();
    const cloudUrls    = new Map<string, CloudUrlEntry[]>();
    /* Page counts from the render step, carried to the Supabase sync so the portal knows how many
       pages it can show and how many the document actually has. */
    const pageCounts   = new Map<string, { total: number; rendered: number }>();

    /* ── Pre-run: the portal reads, all at once ──────────────────────────────── */
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
    if (vocabDirty) {
      log('dim', '  Using local unpublished vocabulary (will publish leaves after sync)');
    }

    let r2Config: RunContext['r2'];
    let assetLevels: Map<string, string> | undefined;
    let cdnKeyReferences: Map<string, Set<string>> | undefined;
    let previewPageLimit: number | undefined;

    /* Four round trips that share nothing, so the run waits for the slowest instead of the sum.
       The RESULTS are applied in the old order, and the lines they log are emitted after the join
       rather than as each read lands — see ./preRun.ts for why that order is load-bearing. */
    const wantsVocabRefresh = !!clientId && !vocabDirty;
    const wantsCdnPrereqs   = !!(sbConfig && clientId && !effectiveSettings.dryRun
      && (effectiveSettings.doThumbnails || effectiveSettings.doCdnOriginals));
    if (wantsVocabRefresh || wantsCdnPrereqs) {
      const prePhase = timePhase('PRE-RUN READS');
      const [vocabRead, cdn] = await Promise.all([
        wantsVocabRefresh
          ? refreshRunVocabulary(clientId!, { persistCache: !effectiveSettings.dryRun })
          : null,
        wantsCdnPrereqs
          ? loadCdnPrerequisites({
              sbConfig:   sbConfig!,
              clientId:   clientId!,
              clientName: activeClient!.name,
            })
          : null,
      ]);
      const preElapsed = prePhase.done();

      if (vocabRead?.data) {
        vocabData  = vocabRead.data;
        vocabFresh = vocabRead.fresh;
        useVocabularyStore.getState().setData(vocabRead.data, { dirty: false });
      }
      if (cdn) {
        r2Config         = cdn.r2;
        assetLevels      = cdn.assetLevels;
        cdnKeyReferences = cdn.cdnKeyReferences;
        previewPageLimit = cdn.previewPageLimit;
      }
      for (const line of [...(vocabRead?.lines ?? []), ...(cdn?.lines ?? [])]) log(line.type, line.msg);
      log('dim', `  Portal pre-run reads finished in ${preElapsed}`);
    }

    /* ── The pipeline ────────────────────────────────────────────────────────── */
    const runCtx: RunContext = {
      settings: effectiveSettings,
      vocab:    vocabData,
      appendLog, addIssue, setProgress, finishRun,
      collectedAssets,
      sourceReadErrors,
      cdnUrls,
      originalUrls,
      assetLevels,
      cdnKeyReferences,
      previewPageLimit,
      pageCounts,
      cloudUrls,
      cloudDestinations: cloudDests,
      localExportLayout:    resolveExportShape(runLocalDest ?? {}).exportLayout,
      localIncludePackages: resolveExportShape(runLocalDest ?? {}).includePackages,
      r2: r2Config,
      isStopping: () => usePipelineStore.getState().runStatus === 'stopping',
      deferFinish: true,
      /* Only a portal run consumes the version-history walk, and it is a second full pass over the
         source tree — a run without Supabase must not pay for one it throws away. */
      earlyVersionScan: !!(sbConfig && clientId),
    };
    const stats = await runPipeline(runCtx);

    /* ── Post-run: Supabase sync, targeted CDN cleanup, version history ──────── */
    try {
      if (sbConfig && clientId && usePipelineStore.getState().runStatus !== 'stopping') {
        await syncRunToPortal({
          effectiveSettings, collectedAssets, clientId, sbConfig, vocabData, vocabDirty, vocabFresh,
          cdnUrls, cloudUrls, originalUrls, pageCounts, r2Config, log, appendLog, setSupabaseSync,
          isStopping: () => usePipelineStore.getState().runStatus === 'stopping',
          sourceFresh: sourceReadErrors.size === 0,
          versionScan: runCtx.versionScan,
        });
      } else if (usePipelineStore.getState().runStatus === 'stopping') {
        log('warn', '  ⏹  Stop requested — portal sync skipped.');
      }
    } catch (e) {
      log('error', `  ✕  Post-run sync failed: ${e}`);
      stats.errors += 1;
    }

    /* Last thing before the run is declared over, so the total covers the pre-run fetches and the
       portal sync as well as the pipeline itself — the two places the silent gaps were found.
       The history read happens BEFORE the record is appended, or every run would compare
       against itself. */
    const record = buildRunRecord({
      settings:   effectiveSettings,
      clientId,
      clientName: activeClient?.name ?? null,
      appVersion: APP_VERSION,
      assets:     collectedAssets.length,
      errors:     stats.errors,
      stopped:    usePipelineStore.getState().runStatus === 'stopping',
    });
    const baseline = record && !record.stopped
      ? findBaseline(await loadRunTimings(), record)
      : null;
    logRunTimeline(appendLog, { baseline: baseline && toBaseline(baseline) });
    if (record) await appendRunTiming(record);
    endRunTimeline();

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
  /** The version-history walk, started at the top of the run. Absent ⇒ walk it here, as before. */
  versionScan?: Promise<VersionScanResult>;
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
       them; drain it here rather than leaving it for whoever next opens the portal.

       SCOPED TO THIS CLIENT, and the run waits for it: the Stream sync below reads each master off
       `download_url`, so those rows must already point at the key their level requires. What the run
       does NOT wait for is everyone else's backlog — that is drained by a follow-up pass that
       outlives this line. The queue is durable, so a follow-up that never lands delays the move
       rather than losing it. */
    if (!a.isStopping()) {
      if (a.effectiveSettings.dryRun) a.log('dim', '  [DRY] would drain CDN reconcile tasks');
      else {
        const reconcilePhase = timePhase('CDN RECONCILE');
        const outcome = await reconcileCdnObjects(a.sbConfig, a.log, { clientId: a.clientId });
        a.log('dim', `  CDN reconcile drained in ${reconcilePhase.done()}`);
        if (outcome && outcome.remaining > 0) {
          a.log('dim',
            `  ⟳  ${outcome.remaining} asset(s) queued elsewhere — draining after the run`);
          void reconcileCdnObjects(a.sbConfig, a.log, { background: true });
        }
      }
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
    /* The walk normally finished during the run, so this phase now measures the WAIT — which is what
       the run actually spends on it. The fallback is not dead code: the pipeline never reaches the
       kick-off if the source scan itself throws. */
    const scanPhase = timePhase('VERSION SCAN');
    const early = a.versionScan ? await a.versionScan : null;
    if (early && 'error' in early) throw early.error;
    const versionMap = early?.map
      ?? await scanVersionMap(a.effectiveSettings.sourceFolder, a.vocabData, a.effectiveSettings);
    a.log('dim', early
      ? `  Version map ready in ${scanPhase.done()} (walked in ${early.took} alongside the run)`
      : `  Version map scanned in ${scanPhase.done()}`);
    await syncVersionHistory(versionMap, a.clientId, a.vocabData, a.sbConfig, a.log, {
      dryRun: a.effectiveSettings.dryRun,
      shouldStop: a.isStopping,
    });
  }
  if (a.isStopping()) a.log('warn', '  ⏹  Stop requested — remaining portal work skipped.');
}
