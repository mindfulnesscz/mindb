/* Supabase service — the module every consumer imports.
 *
 * A barrel over ./supabase/*, so splitting the implementation did not ripple into PipelineView,
 * VocabularyView, SettingsView, clientService or pipelineService.
 *
 * The modules are grouped by how SHAREABLE they are, because that is what Phase 2/3 turns on:
 *
 *   SHARED-READY — pure, no transport, no filesystem. The web portal needs the same rules, so
 *   these move to a package as a file move whenever it does.
 *     rowMapping    filename stem → the row the portal renders (name, taxonomy arrays, version)
 *     taxonomyKeys  the stable `slot.group.leaf` keys tags are addressed by
 *
 *   DESKTOP-SIDE — touches the Tauri filesystem, so it stays here.
 *     manifest      .dchub.json ⇄ child_id resolution (rename- and version-proof)
 *     identity      absolute path → (stable_id, child_id) for CDN keying
 *
 *   QUERIES — data access through ./supabase/rest, which is where the transport lives. These are
 *   the next candidates to share: the QUERIES are platform-free, only the caller differs. See
 *   "What transport means" in REFACTOR_PLAN.md.
 *     assetQueries  reads against public.assets
 *     draftAssets   the Vocabulary "create folder" flow
 *     destinations  cloud destination definitions (tokens stripped)
 *     tagSync       local leaf vocabulary → public.tags
 *     versionHistory  the versions/ subtree → public.version_history
 *     assetExport   the pipeline's full sync (the one module still ~450 lines)
 *     connection    Settings' reachability probe
 */

export type { SupabaseConfig } from './supabase/rest';
export { requestR2Grant, type R2Grant } from './supabase/r2Grant';
export { processRenameTasks } from './supabase/renameTasks';

/* ── Shared-ready: pure mapping rules ─────────────────────────────────────── */
export { parseAssetForSupabase } from './supabase/rowMapping';
export { slugifyKeyPart, parentKeyForLeaf } from './supabase/taxonomyKeys';

/* ── Desktop-side: folder identity ────────────────────────────────────────── */
export { cdnStemKey, resolveCdnIdentity } from './supabase/identity';

/* ── Queries ──────────────────────────────────────────────────────────────── */
export { fetchExistingStableIds, fetchAssetStats } from './supabase/assetQueries';
export { resolveTagId, createDraftAsset, type DraftAssetInput } from './supabase/draftAssets';
export { fetchCloudDestinationDefs, saveCloudDestinationDefs } from './supabase/destinations';
export { syncTagsFromVocabulary } from './supabase/tagSync';
export { syncVersionHistory } from './supabase/versionHistory';
export { exportAssetsToSupabase, type SupabaseExportResult } from './supabase/assetExport';
export { checkSupabaseConnection } from './supabase/connection';
