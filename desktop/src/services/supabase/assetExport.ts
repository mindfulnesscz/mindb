/* Asset export — the pipeline's Supabase sync, as a four-stage flow.
 *
 * Rows are matched by `${stable_id}:${child_id}` — the package folder's hash plus the manifest's
 * per-file id — never by shortcode, so renaming a file or retitling an asset keeps its row, and
 * with it the asset's ratings, comments, approvals and view/download events.
 *
 *   1 identify    folder identity, or refuse to guess          ./exportIdentify
 *   2 plan        assets → the rows to write (+ manifests)     ./exportPlan
 *   3 write       parents, then children                       ./exportWrite
 *   4 disconnect  soft-mark what left the disk                 ./exportDisconnect
 *
 * The stages hand data to each other explicitly. Before this split they shared one function's
 * locals — `manifests`, `parentWrites`, `childWrites`, `currentStableKeys`, `readmeTargets` — which
 * is exactly what made the 489-line original resistant to being divided. Splitting it was only
 * safe once assetExport.characterization.test.ts pinned the behaviour hermetically.
 */

import { buildVocabMap, parseFilename, type VocabularyData, type GalleryGroup, type SingleAsset } from '@dc-hub/domain';
import type { CloudUrlEntry } from '../pipeline/types';
import { writeReadme } from '../readmeService';
import type { SupabaseConfig } from './rest';
import { makeHeaders, fetchAllForClient } from './rest';
import { fetchAssetStats } from './assetQueries';
import { parseAssetForSupabase } from './rowMapping';
import type { StableRow, SupabaseExportResult, ReadmeTarget } from './exportTypes';
import { identifyAssets } from './exportIdentify';
import { planExport } from './exportPlan';
import { dedupeByKey, writeParents, writeChildren } from './exportWrite';
import { disconnectStaleRows } from './exportDisconnect';

export type { SupabaseExportResult } from './exportTypes';

export async function exportAssetsToSupabase(
  singles:      SingleAsset[],
  clientId:     string,
  vocab:        VocabularyData,
  config:       SupabaseConfig,
  appendLog:    (type: string, msg: string) => void,
  cdnUrls?:      Map<string, string>,
  cloudUrls?:    Map<string, CloudUrlEntry[]>,
  galleries?:    GalleryGroup[],
  originalUrls?: Map<string, string>,
  allowLargeDeletions = false,
): Promise<SupabaseExportResult> {
  const result: SupabaseExportResult = { created: 0, updated: 0, disconnected: 0, errors: 0, staleObjectKeys: [] };
  const base    = `${config.url}/rest/v1`;
  const headers = await makeHeaders(config.anonKey);
  const allGalleries = galleries ?? [];

  /* ── 1. Identify ────────────────────────────────────────────────────────── */
  const identified = identifyAssets(singles, allGalleries);

  const totalReceived = singles.length + allGalleries.reduce((n, g) => n + 1 + g.children.length, 0);
  appendLog('section', '━━━ SUPABASE EXPORT ━━━');
  appendLog('dim', `  ${singles.length} flat + ${allGalleries.length} galler${allGalleries.length === 1 ? 'y' : 'ies'} (${totalReceived} total)`);
  for (const sid of identified.conflicted) {
    appendLog('error', `  ✕  Hash "__${sid}" claimed by multiple folders — same asset moved, or duplicated folder needing a fresh ID? Skipping sync for it this run.`);
  }
  for (const name of identified.unhashed) {
    appendLog('error', `  ✕  "${name}" sits in a folder with no " __<hash>" suffix — create it through Vocabulary → Create folder so it gets an identity. Skipped.`);
    result.errors += 1;
  }

  if (identified.stableSingles.length || identified.stableGalleries.length) {
    // Existing rows, keyed the same way the plan keys its writes.
    const existing = new Map<string, StableRow>();
    let readFailed = false;
    try {
      const rows = await fetchAllForClient<StableRow>(
        base, 'assets?status=neq.archived', clientId,
        'id,stable_id,child_id,thumbnail_url,parent_id,variant_of', headers,
      );
      for (const r of rows) existing.set(`${r.stable_id}:${r.child_id}`, r);
    } catch (e) {
      appendLog('error', `  ✕  Could not fetch existing stable-identity records: ${e}`);
      readFailed = true;
    }
    const existingByStableId = new Map<string, StableRow[]>();
    for (const row of existing.values()) {
      (existingByStableId.get(row.stable_id) ?? existingByStableId.set(row.stable_id, []).get(row.stable_id)!).push(row);
    }

    /* ── 2. Plan ──────────────────────────────────────────────────────────── */
    const plan = await planExport({
      identified, clientId, vocab, existingByStableId, cdnUrls, originalUrls, cloudUrls, appendLog,
    });

    /* ── 3. Write — parents first; children need the resolved parent uuid ─── */
    const parents = dedupeByKey(plan.parentWrites, 'parent/single', appendLog);
    // A key cannot be both a primary and a child: the primary wins, or the child write would
    // PATCH a relation onto the primary's own row.
    const parentKeys = new Set(parents.map(p => p.key));
    const children = dedupeByKey(plan.childWrites, 'child', appendLog).filter(c => {
      if (!parentKeys.has(c.key)) return true;
      appendLog('warn', `  ⚠  ${c.key} resolved as both primary and child — keeping the primary`);
      return false;
    });

    const parentIdByKey = await writeParents(parents, existing, base, headers, result, appendLog);
    await writeChildren(children, parentIdByKey, existing, base, headers, result, appendLog);

    appendLog('success', `  ✓  Stable identity: ${plan.parentWrites.length} parent/single · ${plan.childWrites.length} child record(s) synced`);

    await writeReadmes(plan.readmeTargets, parentIdByKey, vocab, config, appendLog);

    /* ── 4. Disconnect ────────────────────────────────────────────────────── */
    // Skipped when the read failed: "no row for this key" would then mean "unknown", not
    // "absent", and treating an empty result as truth would disconnect every asset.
    if (!readFailed) {
      await disconnectStaleRows(
        existing, plan.currentStableKeys, base, headers, result, appendLog, allowLargeDeletions,
      );
    }
  }

  appendLog('section',
    `━━━ SUPABASE DONE — ${result.created} new · ${result.updated} updated · ${result.disconnected} disconnected · ${result.errors} errors ━━━`,
  );
  return result;
}

/**
 * readme.md — a human/Obsidian-facing mirror of the DB, regenerated in full every run.
 * Stats attach to the PRIMARY row only, matching the convention that ratings, comments and
 * downloads are tracked against the primary rather than individual variants.
 */
async function writeReadmes(
  targets: ReadmeTarget[],
  parentIdByKey: Map<string, string>,
  vocab: VocabularyData,
  config: SupabaseConfig,
  appendLog: (type: string, msg: string) => void,
): Promise<void> {
  if (!targets.length) return;

  const primaryIds = targets
    .map(t => parentIdByKey.get(`${t.stableId}:c1`))
    .filter((id): id is string => !!id);
  const statsMap = await fetchAssetStats(primaryIds, config);
  const vocabCtx = buildVocabMap(vocab);

  let written = 0;
  for (const t of targets) {
    const primaryId = parentIdByKey.get(`${t.stableId}:c1`);
    if (!primaryId) continue;
    try {
      const parsed = parseFilename(t.stem, vocabCtx);
      const p      = parseAssetForSupabase(t.stem, vocab);
      await writeReadme(t.packageDir, {
        name: p.name, stableId: t.stableId, status: 'published', version: p.version, perm: 'public',
        tags: parsed.tags, stats: statsMap.get(primaryId) ?? null,
      });
      written++;
    } catch (e) {
      appendLog('error', `  ✕  readme.md write failed for "${t.packageDir}": ${e}`);
    }
  }
  appendLog('dim', `  readme.md written for ${written}/${targets.length} folder(s)`);
}
