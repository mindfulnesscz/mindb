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

import { buildVocabMap, parseFilename, type VocabularyData, type GalleryGroup, type SingleAsset } from '@sotto/domain';
import type { CloudUrlEntry } from '../pipeline/types';
import { writeReadme } from '../readmeService';
import type { SupabaseConfig } from './rest';
import { makeHeaders, fetchAllForClient, sbFetch } from './rest';
import { fetchAssetStats } from './assetQueries';
import { parseAssetForSupabase } from './rowMapping';
import type { StableRow, SupabaseExportResult, ReadmeTarget } from './exportTypes';
import { identifyAssets } from './exportIdentify';
import { planExport } from './exportPlan';
import { dedupeByKey, writeParents, writeChildren } from './exportWrite';
import { disconnectStaleRows } from './exportDisconnect';

export type { SupabaseExportResult } from './exportTypes';

/**
 * Does this database have the page-preview columns?
 *
 * `limit=0` asks for the shape and no rows, so it is one cheap round trip. An unknown column makes
 * PostgREST answer 400 rather than ignore it, which is exactly the signal wanted here.
 */
async function hasPagePreviewColumns(
  base: string,
  headers: Record<string, string>,
): Promise<boolean> {
  try {
    // sbFetch, not global fetch: it carries this module's auth refresh and is what the stub drives.
    const res = await sbFetch(`${base}/assets?select=preview_page_count&limit=0`, { headers });
    return res.ok;
  } catch {
    // A network failure is not evidence the columns are missing, but withholding two metadata
    // fields is the harmless direction — the alternative risks failing every row.
    return false;
  }
}

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
  /** absPath → page-preview counts from the render step, for documents. */
  pageCounts?:   Map<string, { total: number; rendered: number }>,
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
      // perm/status come along for readme.md only — the pipeline reports them, never rewrites
      // perm on an existing row (see stripPortalOwnedFields).
      const rows = await fetchAllForClient<StableRow>(
        base, 'assets?status=neq.archived', clientId,
        'id,stable_id,child_id,thumbnail_url,parent_id,variant_of,perm,status', headers,
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

    /* Page-preview counts are only written where the columns exist.
       PostgREST rejects the WHOLE write when one column is unknown (PGRST204), so on an environment
       that has not had the migration yet, sending them failed the PARENT row — and every child then
       skipped for want of a parent_id. One additive metadata column stopped an entire package from
       syncing. Withholding the data is enough: `planExport` writes null without it and
       `stripAbsentUrls` removes the fields, which is the same no-opinion path a run with thumbnails
       disabled already takes. One probe per run, not per row. */
    let writablePageCounts = pageCounts;
    if (pageCounts?.size && !(await hasPagePreviewColumns(base, headers))) {
      writablePageCounts = undefined;
      appendLog('warn',
        '  ⚠  This environment has no page-preview columns yet — page counts not synced. '
        + 'Everything else is unaffected; apply the document-page-previews migration to enable them.');
    }

    /* ── 2. Plan ──────────────────────────────────────────────────────────── */
    const plan = await planExport({
      identified, clientId, vocab, existingByStableId, cdnUrls, originalUrls, cloudUrls,
      pageCounts: writablePageCounts, appendLog,
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

    // Access level as the DB has it, for readme.md. A row created this run isn't in here with a
    // perm, so the target's own create-time default stands in.
    const dbLevelById = new Map<string, { perm?: string | null; status?: string | null }>();
    for (const row of existing.values()) dbLevelById.set(row.id, { perm: row.perm, status: row.status });

    await writeReadmes(plan.readmeTargets, parentIdByKey, dbLevelById, vocab, config, appendLog);

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
 *
 * Status and permission are REPORTED, not asserted: both used to be hardcoded here
 * (`published`/`public`), so the note claimed every asset was world-readable whatever the row
 * actually said. Since these notes are how the library gets read in Obsidian, that is the one
 * place a wrong access level is most likely to be believed.
 */
async function writeReadmes(
  targets: ReadmeTarget[],
  parentIdByKey: Map<string, string>,
  dbLevelById: Map<string, { perm?: string | null; status?: string | null }>,
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
      const dbLevel = dbLevelById.get(primaryId);
      await writeReadme(t.packageDir, {
        name: p.name, stableId: t.stableId, version: p.version,
        status: dbLevel?.status ?? t.status,
        perm:   dbLevel?.perm   ?? t.perm,
        tags: parsed.tags, stats: statsMap.get(primaryId) ?? null,
      });
      written++;
    } catch (e) {
      appendLog('error', `  ✕  readme.md write failed for "${t.packageDir}": ${e}`);
    }
  }
  appendLog('dim', `  readme.md written for ${written}/${targets.length} folder(s)`);
}
