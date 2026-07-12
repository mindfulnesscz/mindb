import { invoke } from '@tauri-apps/api/core';
import { readFile, readTextFile, writeTextFile, exists as fsExists } from '@tauri-apps/plugin-fs';
import { parseFilename, buildVocabContext } from '../domain/filenameTranslator';
import type { CloudDestination } from '../domain/client';
import { extractStableId } from '../domain/stableId';
import { filterHighestVersions, parseVersion, compareVersions } from '../domain/version';
import type { VocabularyData } from '../domain/vocabulary';
import type { GalleryGroup } from '../domain/assetGrouping';
import type { AssetVersions, CloudUrlEntry } from './pipelineService';
import { getCurrentAccessToken } from './authService';
import { writeReadme } from './readmeService';
import type { AssetStatsSnapshot } from './readmeService';

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface SupabaseConfig {
  url:     string; // https://<project>.supabase.co
  anonKey: string; // public API key — requests authenticate as the signed-in user
}

export interface SupabaseExportResult {
  created:        number;
  updated:        number;
  disconnected:   number; // stable-identity rows soft-marked disconnected this run
  deleted:        number; // legacy rows hard-deleted this run
  errors:         number;
  staleObjectKeys: string[]; // R2 object keys that should be deleted (thumbnails + originals)
}

export interface InventoryRecord {
  shortcode:     string;
  thumbnail_url: string | null;
  download_key:  string | null;
}

/** Existing stable_ids for a client — used to collision-check a freshly generated one
 * before scaffolding a new asset folder (see CreateAssetView.tsx / migrate-identity.ts). */
export async function fetchExistingStableIds(
  clientId: string,
  config:   SupabaseConfig,
): Promise<Set<string>> {
  const base    = `${config.url}/rest/v1`;
  const headers = makeHeaders(config.anonKey);
  const rows = await fetchAllForClient<{ stable_id: string | null }>(
    base, 'assets?stable_id=not.is.null', clientId, 'stable_id', headers,
  );
  return new Set(rows.map(r => r.stable_id).filter((x): x is string => !!x));
}

/** Fetch the CDN inventory for a client without running the full export. */
export async function fetchClientInventory(
  clientId: string,
  config:   SupabaseConfig,
): Promise<Pick<InventoryRecord, 'shortcode' | 'thumbnail_url'>[]> {
  const base    = `${config.url}/rest/v1`;
  const headers = makeHeaders(config.anonKey);
  return fetchAllForClient<Pick<InventoryRecord, 'shortcode' | 'thumbnail_url'>>(
    base,
    'assets?status=neq.archived',
    clientId,
    'shortcode,thumbnail_url',
    headers,
  );
}

/**
 * Per-asset stats for the readme.md snapshot (Task 5) — reuses the web portal's existing
 * `asset_stats` view (avg rating / rating count / comment count) and aggregates
 * `asset_events` client-side into view/download counts, mirroring
 * web/apps/client-hub/src/services/eventService.ts's own aggregation. Best-effort: a
 * fetch failure just means that run's readme.md ships without stats, never blocks the sync.
 */
export async function fetchAssetStats(
  assetIds: string[],
  config:   SupabaseConfig,
): Promise<Map<string, AssetStatsSnapshot>> {
  const base    = `${config.url}/rest/v1`;
  const headers = makeHeaders(config.anonKey);
  const result  = new Map<string, AssetStatsSnapshot>();
  if (!assetIds.length) return result;

  for (let i = 0; i < assetIds.length; i += 200) {
    const chunk = assetIds.slice(i, i + 200).join(',');
    try {
      const [statsRes, eventsRes] = await Promise.all([
        sbFetch(`${base}/asset_stats?id=in.(${chunk})&select=id,avg_rating,rating_count,comment_count`, { headers }),
        sbFetch(`${base}/asset_events?asset_id=in.(${chunk})&select=asset_id,event_type`, { headers }),
      ]);
      const statsRows = statsRes.ok
        ? await statsRes.json<Array<{ id: string; avg_rating: number; rating_count: number; comment_count: number }>>()
        : [];
      const eventRows = eventsRes.ok
        ? await eventsRes.json<Array<{ asset_id: string; event_type: string }>>()
        : [];

      const counts = new Map<string, { views: number; downloads: number }>();
      for (const e of eventRows) {
        const c = counts.get(e.asset_id) ?? { views: 0, downloads: 0 };
        if (e.event_type === 'view') c.views++;
        else if (e.event_type === 'download') c.downloads++;
        counts.set(e.asset_id, c);
      }

      for (const row of statsRows) {
        const c = counts.get(row.id) ?? { views: 0, downloads: 0 };
        result.set(row.id, {
          downloads:    c.downloads,
          views:        c.views,
          avgRating:    Number(row.avg_rating) || 0,
          ratingCount:  row.rating_count ?? 0,
          commentCount: row.comment_count ?? 0,
        });
      }
    } catch { /* best-effort — see doc comment above */ }
  }
  return result;
}

/* ── Internal fetch helpers ──────────────────────────────────────────────── */

/** Requests run as the signed-in user: the anon key identifies the project,
 * the session JWT authorizes — RLS staff policies are the write boundary.
 * The service-role key no longer exists desktop-side (authentication-plan
 * Phase 3). Throws when signed out: privileged sync fails closed. */
function makeHeaders(anonKey: string): Record<string, string> {
  const token = getCurrentAccessToken();
  if (!token) throw new Error('Not signed in — Supabase sync requires an active session.');
  return {
    apikey:         anonKey,
    Authorization:  `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

interface SbRustResponse { status: number; ok: boolean; body: string }

/** Proxy fetch through Rust — native networking, no webview CORS surface. */
async function sbFetch(
  url:     string,
  options: { method?: string; headers: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; text(): Promise<string>; json<T>(): Promise<T> }> {
  const r = await invoke<SbRustResponse>('supabase_request', {
    url,
    method:  options.method ?? 'GET',
    headers: options.headers,
    body:    options.body,
  });
  return {
    ok:     r.ok,
    status: r.status,
    text:   async () => r.body,
    json:   async <T>() => JSON.parse(r.body) as T,
  };
}

/**
 * Paginated GET for a single table. `path` is the table name optionally with
 * extra PostgREST filters already appended, e.g. 'assets?status=neq.archived'.
 * client_id, select, limit, offset are always appended.
 */
async function fetchAllForClient<T>(
  base:     string,
  path:     string,
  clientId: string,
  select:   string,
  headers:  Record<string, string>,
): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  let page = 0;
  const sep = path.includes('?') ? '&' : '?';
  while (true) {
    const url = `${base}/${path}${sep}client_id=eq.${clientId}&select=${select}&limit=${PAGE}&offset=${page * PAGE}`;
    const res = await sbFetch(url, { headers });
    if (!res.ok) throw new Error(await res.text());
    const batch = await res.json() as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    page++;
  }
  return rows;
}

/** Paginated GET for version_history rows belonging to a set of asset UUIDs. */
async function fetchVHForAssets(
  base:     string,
  assetIds: string[],
  headers:  Record<string, string>,
): Promise<Array<{ id: string; asset_id: string; version: string; status: string }>> {
  if (!assetIds.length) return [];
  const PAGE = 1000;
  const rows: Array<{ id: string; asset_id: string; version: string; status: string }> = [];
  for (let ci = 0; ci < assetIds.length; ci += 200) {
    const chunk = assetIds.slice(ci, ci + 200).join(',');
    let page = 0;
    while (true) {
      const res = await sbFetch(
        `${base}/version_history?asset_id=in.(${chunk})&select=id,asset_id,version,status&limit=${PAGE}&offset=${page * PAGE}`,
        { headers },
      );
      if (!res.ok) throw new Error(await res.text());
      const batch = await res.json() as typeof rows;
      rows.push(...batch);
      if (batch.length < PAGE) break;
      page++;
    }
  }
  return rows;
}

/* ── Client ID resolution ────────────────────────────────────────────────── */

/**
 * Looks up the Supabase clients.id by name. Creates the row on first run,
 * making the pipeline self-bootstrapping — no manual Supabase setup needed.
 */

/* resolveClientId (lookup-or-create by name) is gone: clients are DB-first —
   the desktop picks a client the database already knows, so its UUID is the
   identity everywhere. Creation lives in the client picker (admin, RLS-gated). */

/* ── Cloud destination definitions — shared across the team via Supabase.
   Tokens never leave the machine that holds them; only the shape (client ID,
   tenant ID, remote path, role, etc.) syncs. ──────────────────────────────── */

/** Strips the OAuth token from a destination's config before it's written to Supabase. */
function stripToken(dest: CloudDestination): CloudDestination {
  if (dest.config.type === 'local') return dest;
  return { ...dest, config: { ...dest.config, token: null } };
}

export async function fetchCloudDestinationDefs(
  clientId: string,
  config:   SupabaseConfig,
): Promise<CloudDestination[]> {
  const base    = `${config.url}/rest/v1`;
  const headers = makeHeaders(config.anonKey);
  try {
    const res = await sbFetch(
      `${base}/clients?id=eq.${clientId}&select=cloud_destinations&limit=1`,
      { headers },
    );
    if (!res.ok) return [];
    const rows = await res.json() as Array<{ cloud_destinations: CloudDestination[] | null }>;
    return rows[0]?.cloud_destinations ?? [];
  } catch {
    return [];
  }
}

export async function saveCloudDestinationDefs(
  clientId:     string,
  destinations: CloudDestination[],
  config:       SupabaseConfig,
): Promise<void> {
  const base    = `${config.url}/rest/v1`;
  const headers = makeHeaders(config.anonKey);
  await sbFetch(`${base}/clients?id=eq.${clientId}`, {
    method:  'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body:    JSON.stringify({ cloud_destinations: destinations.map(stripToken) }),
  });
}

/* ── Asset creation flow (Task 6) ────────────────────────────────────────── */

export interface DraftAssetInput {
  clientId:        string;
  stableId:        string;
  name:            string;
  entities:        string[];
  angles:          string[];
  formats:         string[];
  tags:            string[];
  primaryEntityId: string | null;
  primaryAngleId:  string | null;
  primaryFormatId: string | null;
}

/** Looks up a tag's Supabase row id by its rendered label — primary_*_id columns are
 * uuid FKs into `tags`, not the vocabulary's own shortcode string. Requires that client's
 * vocabulary has already been synced at least once (syncTagsFromVocabulary); returns null
 * (not an error) if the tag isn't in Supabase yet, since the FK columns are nullable. */
export async function resolveTagId(
  clientId:  string,
  dimension: 'entity' | 'angle' | 'format',
  label:     string,
  config:    SupabaseConfig,
): Promise<string | null> {
  const base    = `${config.url}/rest/v1`;
  const headers = makeHeaders(config.anonKey);
  try {
    const res = await sbFetch(
      `${base}/tags?client_id=eq.${clientId}&dimension=eq.${dimension}&name=eq.${encodeURIComponent(label)}&select=id&limit=1`,
      { headers },
    );
    if (!res.ok) return null;
    const rows = await res.json<Array<{ id: string }>>();
    return rows[0]?.id ?? null;
  } catch { return null; }
}

/** Inserts a `draft` status row for a freshly scaffolded asset folder — child_id is always
 * 'c1' since a brand-new asset has no variants yet. Throws with the actual Supabase error
 * text on failure rather than swallowing it — the caller already surfaces exceptions. */
export async function createDraftAsset(input: DraftAssetInput, config: SupabaseConfig): Promise<string> {
  const base    = `${config.url}/rest/v1`;
  const headers = makeHeaders(config.anonKey);
  const key       = `${input.stableId}:c1`;
  const shortcode = `${input.name} __${key}`;
  const res = await sbFetch(`${base}/assets`, {
    method:  'POST',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify({
      client_id: input.clientId, stable_id: input.stableId, child_id: 'c1',
      shortcode, name: input.name,
      entities: input.entities, angles: input.angles, formats: input.formats, tags: input.tags,
      status: 'draft', perm: 'internal',
      primary_entity_id: input.primaryEntityId,
      primary_angle_id:  input.primaryAngleId,
      primary_format_id: input.primaryFormatId,
    }),
  });
  if (!res.ok) throw new Error(`Supabase insert failed: ${await res.text()}`);
  const created = await res.json<Array<{ id: string }>>();
  if (!created[0]?.id) throw new Error('Supabase insert returned no row.');
  return created[0].id;
}

/* ── Asset export ────────────────────────────────────────────────────────── */

const BATCH = 500;

function stripVersionSuffix(stem: string): string {
  return stem.replace(/\s+[vV]\d+(?:[-._]\d+)*\s*$/, '').trim();
}

function unionStrings(lists: string[][]): string[] {
  return [...new Set(lists.flat())];
}

function intersectStrings(lists: string[][]): string[] {
  if (!lists.length) return [];
  return lists[0].filter(x => lists.every(l => l.includes(x)));
}

export function parseAssetForSupabase(assetStem: string, vocab: VocabularyData) {
  const ctx    = buildVocabContext(vocab);
  const parsed = parseFilename(assetStem, ctx);

  const shortcode  = stripVersionSuffix(assetStem);
  const entityTags = parsed.tags.filter(t => t.slot === 'entity');
  const formatTags = parsed.tags.filter(t => t.slot === 'format');
  const angleTags  = parsed.tags.filter(t => t.slot === 'angle');

  const nameParts = [
    ...parsed.tags.map(t => t.label),
    ...parsed.unknownTags.map(u => `[${u}]`),
  ];
  let name = nameParts.join(' ');
  if (parsed.description) name += ` — ${parsed.description}`;

  return {
    shortcode,
    name:       name.trim() || shortcode,
    entities:   entityTags.map(t => t.label),
    formats:    formatTags.map(t => t.label),
    angles:     angleTags.map(t => t.label),
    tags:       parsed.tags.map(t => t.label),
    version:    parsed.version ?? '',
    year_month: parsed.yymm    ?? null,
  };
}

/* ── Folder-based stable identity: manifest + content-hash matching ────────
   See CLAUDE_CODE_PROMPT_identity-migration.md. A migrated client's asset
   folders carry a ` __<hash>` suffix (domain/stableId.ts); the manifest below
   maps individual filenames inside that folder to a stable child_id, so
   renames don't create new DB rows. */

interface DchubManifest {
  stable_id:  string;
  children:   Record<string, { child_id: string; sha256: string }>;
  updated_at: string;
}

const MANIFEST_FILENAME = '.dchub.json';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function readManifest(packageDir: string): Promise<DchubManifest | null> {
  const path = `${packageDir}/${MANIFEST_FILENAME}`;
  try {
    if (!(await fsExists(path))) return null;
    return JSON.parse(await readTextFile(path)) as DchubManifest;
  } catch { return null; }
}

async function writeManifest(packageDir: string, manifest: DchubManifest): Promise<void> {
  const path = `${packageDir}/${MANIFEST_FILENAME}`;
  await writeTextFile(path, JSON.stringify({ ...manifest, updated_at: new Date().toISOString() }, null, 2));
}

function nextChildId(used: Set<string>): string {
  let n = 1;
  while (used.has(`c${n}`)) n++;
  const id = `c${n}`;
  used.add(id);
  return id;
}

/** A new version of an asset already in the manifest: same version-stripped base and
 * extension as an existing entry. Returns that lineage's child id (from its highest
 * version, if several entries share the base) so a version bump keeps the asset's DB
 * row — and with it feedback/ratings — and its version-stable CDN key, instead of
 * splitting off a brand-new child. */
function versionLineageChildId(manifest: DchubManifest, filename: string): string | null {
  const parsed = parseVersion(filename);
  if (!parsed) return null;
  let best: { childId: string; version: [number, number, number] } | null = null;
  for (const [name, entry] of Object.entries(manifest.children)) {
    const p = parseVersion(name);
    if (!p) continue;
    if (p.base.toLowerCase() !== parsed.base.toLowerCase() || p.ext.toLowerCase() !== parsed.ext.toLowerCase()) continue;
    if (!best || compareVersions(p.version, best.version) > 0) best = { childId: entry.child_id, version: p.version };
  }
  return best?.childId ?? null;
}

/** Matching order per Task 4: manifest filename → content-hash (renamed file) →
 * version lineage (version bump of a known asset) → brand-new. */
async function resolveChildId(
  manifest: DchubManifest,
  filename: string,
  absPath:  string,
  used:     Set<string>,
): Promise<{ childId: string; sha256: string; dirty: boolean }> {
  const byName = manifest.children[filename];
  if (byName) { used.add(byName.child_id); return { childId: byName.child_id, sha256: byName.sha256, dirty: false }; }

  let sha = '';
  try { sha = await sha256Hex(await readFile(absPath)); } catch { /* unreadable — fall through to a fresh id */ }

  if (sha) {
    const renamed = Object.entries(manifest.children).find(([, v]) => v.sha256 === sha);
    if (renamed) { used.add(renamed[1].child_id); return { childId: renamed[1].child_id, sha256: sha, dirty: true }; }
  }
  const lineage = versionLineageChildId(manifest, filename);
  if (lineage) { used.add(lineage); return { childId: lineage, sha256: sha, dirty: true }; }
  return { childId: nextChildId(used), sha256: sha, dirty: true };
}

export interface IdentityContext {
  migrated:    boolean;               // client.identityMigrated — gates stable_id matching entirely
  packageDirs: Map<string, string>;   // single stem, or gallery folder name → its package dir (OUT's parent)
  filePaths:   Map<string, string>;   // any stem (single or gallery child) → absolute file path
}

type ManifestStates = Map<string, { manifest: DchubManifest; used: Set<string>; dirty: boolean }>;

/** Reads (or initializes) the manifest state for a package dir, caching it in `manifests`
 * for the rest of the run. Shared by `exportAssetsToSupabase` and `resolveCdnIdentity` so
 * both agree on the exact same child_id assignments — whichever runs first persists them
 * to the `.dchub.json` manifest on disk, and the other reads that back via the byName fast
 * path in `resolveChildId`, rather than resolving independently. */
async function getManifestState(manifests: ManifestStates, packageDir: string, stableId: string) {
  let state = manifests.get(packageDir);
  if (!state) {
    const existing = await readManifest(packageDir);
    const manifest  = existing ?? { stable_id: stableId, children: {}, updated_at: '' };
    state = { manifest, used: new Set(Object.values(manifest.children).map(c => c.child_id)), dirty: false };
    manifests.set(packageDir, state);
  }
  return state;
}

/** Resolves each collected asset's rename-proof stable identity (stable_id/child_id) for
 * CDN keying, without touching any Supabase record/DB logic — that stays entirely inside
 * `exportAssetsToSupabase`, unchanged. Meant to run once, early, before CDN uploads, so
 * those uploads can key by this identity instead of the current filename. Entries are
 * omitted for legacy/unmigrated/orphan files (no stable identity to key by) — callers
 * should fall back to filename/shortcode-based keys for those. */
export async function resolveCdnIdentity(
  collectedAssets: string[],
  outFolderName:   string,
): Promise<Map<string, { stableId: string; childId: string }>> {
  const result: Map<string, { stableId: string; childId: string }> = new Map();
  const manifests: ManifestStates = new Map();

  // Resolved per FILE, not per stem: stems collapse extension-only variants
  // (foo.pdf + foo.webp), which would make both files claim the same child key
  // on R2 and delete each other's upload via the stale-sibling cleanup. The
  // manifest is filename-keyed and already tells them apart.
  for (const absPath of collectedAssets) {
    const parts = absPath.replace(/\\/g, '/').split('/');
    let outIdx = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].toLowerCase() === outFolderName.toLowerCase()) { outIdx = i; break; }
    }
    if (outIdx < 0) continue; // orphan layout — no package dir to carry a hash
    const packageDir = parts.slice(0, outIdx).join('/');
    const stableId   = extractStableId(packageDir.split('/').pop() ?? '');
    if (!stableId) continue;

    const filename = parts[parts.length - 1];
    const stem     = filename.replace(/\.[^.]+$/, '');
    const state    = await getManifestState(manifests, packageDir, stableId);
    const resolved = await resolveChildId(state.manifest, filename, absPath, state.used);
    if (resolved.dirty) { state.manifest.children[filename] = { child_id: resolved.childId, sha256: resolved.sha256 }; state.dirty = true; }

    const identity = { stableId, childId: resolved.childId };
    result.set(filename, identity);
    // Stem key kept for stem-scoped lookups (one shared thumbnail per stem).
    // First writer wins so extension variants can't flip the thumb key between runs.
    if (!result.has(stem)) result.set(stem, identity);
  }

  for (const [dir, state] of manifests) {
    if (!state.dirty) continue;
    try { await writeManifest(dir, state.manifest); } catch { /* best-effort — a later run will retry */ }
  }

  return result;
}

export async function exportAssetsToSupabase(
  packageNames: string[],
  clientId:     string,
  vocab:        VocabularyData,
  config:       SupabaseConfig,
  appendLog:    (type: string, msg: string) => void,
  cdnUrls?:      Map<string, string>,
  cloudUrls?:    Map<string, CloudUrlEntry[]>,
  galleries?:    GalleryGroup[],
  identity?:     IdentityContext,
  originalUrls?: Map<string, string>,
): Promise<SupabaseExportResult> {
  const result: SupabaseExportResult = { created: 0, updated: 0, disconnected: 0, deleted: 0, errors: 0, staleObjectKeys: [] };
  const base    = `${config.url}/rest/v1`;
  const headers = makeHeaders(config.anonKey);

  const allGalleries = galleries ?? [];
  const useStable     = !!identity?.migrated;

  /* ── Partition into stable-identity groups (folder carries a __hash) vs.
     legacy shortcode groups (everything else, or when the client hasn't
     migrated) ────────────────────────────────────────────────────────────── */
  const stableSingles:   Array<{ stem: string; packageDir: string; stableId: string }> = [];
  const legacySingles:   string[] = [];
  const stableGalleries: Array<{ group: GalleryGroup; packageDir: string; stableId: string }> = [];
  const legacyGalleries: GalleryGroup[] = [];

  if (useStable) {
    const hashOwners = new Map<string, Set<string>>(); // stableId → package dirs claiming it this run
    const claim = (sid: string, dir: string) => {
      const owners = hashOwners.get(sid) ?? new Set<string>();
      owners.add(dir);
      hashOwners.set(sid, owners);
    };
    for (const stem of packageNames) {
      const dir = identity!.packageDirs.get(stem);
      const sid = dir ? extractStableId(dir.split('/').pop() ?? '') : null;
      if (dir && sid) { stableSingles.push({ stem, packageDir: dir, stableId: sid }); claim(sid, dir); }
      else legacySingles.push(stem);
    }
    for (const g of allGalleries) {
      const dir = identity!.packageDirs.get(g.name);
      const sid = dir ? extractStableId(dir.split('/').pop() ?? '') : null;
      if (dir && sid) { stableGalleries.push({ group: g, packageDir: dir, stableId: sid }); claim(sid, dir); }
      else legacyGalleries.push(g);
    }
    // Duplicate-hash guard — the same hash suffix claimed by more than one folder this run.
    const conflicted = new Set([...hashOwners].filter(([, dirs]) => dirs.size > 1).map(([sid]) => sid));
    for (const sid of conflicted) {
      appendLog('error', `  ✕  Hash "__${sid}" claimed by multiple folders — same asset moved, or duplicated folder needing a fresh ID? Skipping sync for it this run.`);
    }
    if (conflicted.size) {
      stableSingles.splice(0, stableSingles.length, ...stableSingles.filter(s => !conflicted.has(s.stableId)));
      stableGalleries.splice(0, stableGalleries.length, ...stableGalleries.filter(g => !conflicted.has(g.stableId)));
    }
    const unscaffolded = legacySingles.length + legacyGalleries.length;
    if (unscaffolded) appendLog('warn', `  ⚠  ${unscaffolded} folder(s) have no __hash yet — syncing via legacy shortcode match (unscaffolded)`);
  } else {
    legacySingles.push(...packageNames);
    legacyGalleries.push(...allGalleries);
  }

  const totalReceived = packageNames.length + allGalleries.reduce((n, g) => n + 1 + g.childStems.length, 0);
  appendLog('section', '━━━ SUPABASE EXPORT ━━━');
  appendLog('dim', `  ${packageNames.length} flat + ${allGalleries.length} galler${allGalleries.length === 1 ? 'y' : 'ies'} (${totalReceived} total)`);
  if (useStable) appendLog('dim', `  ${stableSingles.length + stableGalleries.length} via stable identity · ${legacySingles.length + legacyGalleries.length} via legacy shortcode`);

  function buildRecord(stem: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const p = parseAssetForSupabase(stem, vocab);
    return {
      client_id:     clientId,
      shortcode:     p.shortcode,
      name:          p.name,
      entities:      p.entities,
      formats:       p.formats,
      angles:        p.angles,
      tags:          p.tags,
      version:       p.version,
      status:        'published',
      perm:          'public',
      thumbnail_url: cdnUrls?.get(stem) ?? null,
      download_url:  originalUrls?.get(stem) ?? null,
      download_urls: cloudUrls?.get(stem) ?? [],
      ...extra,
    };
  }

  // ── Phase 1: flat singles + gallery parents (parent_id: null) ──────────────
  const seen = new Map<string, Record<string, unknown>>();
  for (const pkgName of legacySingles) {
    const rec = buildRecord(pkgName);
    seen.set(rec.shortcode as string, rec);
  }
  for (const g of legacyGalleries) {
    const firstChild = g.childStems.length > 0 ? g.childStems[0] : null;
    const firstChildThumb    = firstChild ? (cdnUrls?.get(firstChild) ?? null) : null;
    const firstChildOriginal = firstChild ? (originalUrls?.get(firstChild) ?? null) : null;
    const firstChildCloud    = firstChild ? (cloudUrls?.get(firstChild) ?? []) : [];
    const p = parseAssetForSupabase(g.name, vocab);
    seen.set(p.shortcode, {
      client_id:     clientId,
      shortcode:     p.shortcode,
      name:          p.name,
      entities:      p.entities,
      formats:       p.formats,
      angles:        p.angles,
      tags:          p.tags,
      version:       p.version,
      status:        'published',
      perm:          'public',
      thumbnail_url: firstChildThumb,
      download_url:  firstChildOriginal,
      download_urls: firstChildCloud,
    });
  }
  const phase1Records = [...seen.values()];

  // Fetch all current (non-archived) assets to diff creates vs updates
  appendLog('dim', '  Fetching existing records…');
  type ExistingRow = { id: string; shortcode: string; thumbnail_url: string | null; download_url?: string | null; download_urls?: unknown[] | null; download_key?: string | null };
  const existingMap = new Map<string, ExistingRow>(); // shortcode → row
  try {
    // Once a client has migrated, stable-identity rows are handled entirely in the block
    // below — excluding them here prevents this legacy pass from seeing them as "not
    // currently produced" and deleting them (see the ── Stale detection ── comment below).
    const stableFilter = useStable ? '&stable_id=is.null' : '';
    const rows = await fetchAllForClient<ExistingRow>(
      base, `assets?status=neq.archived${stableFilter}`, clientId,
      'id,shortcode,thumbnail_url,download_url,download_urls', headers,
    );
    for (const r of rows) existingMap.set(r.shortcode.trim(), r);
  } catch (e) {
    appendLog('error', `  ✕  Could not fetch existing records: ${e}`);
    result.errors += totalReceived;
    return result;
  }

  // A cached or disabled upload phase leaves the URL maps empty for assets whose
  // objects are already on R2 — never let that overwrite a URL the DB already has.
  // (The bulk upsert must send uniform keys per batch, so fill rather than omit.)
  function preserveExistingUrls(records: Record<string, unknown>[]): void {
    for (const rec of records) {
      const prev = existingMap.get((rec.shortcode as string).trim());
      if (!prev) continue;
      if (rec.thumbnail_url == null && prev.thumbnail_url) rec.thumbnail_url = prev.thumbnail_url;
      if (rec.download_url == null && prev.download_url) rec.download_url = prev.download_url;
      if (Array.isArray(rec.download_urls) && rec.download_urls.length === 0 && prev.download_urls?.length) {
        rec.download_urls = prev.download_urls;
      }
    }
  }
  preserveExistingUrls(phase1Records);

  // Phase 1 upsert
  const p1Create = phase1Records.filter(r => !existingMap.has(r.shortcode as string)).length;
  appendLog('dim', `  Phase 1 — ${p1Create} to create · ${phase1Records.length - p1Create} to update`);
  for (let i = 0; i < phase1Records.length; i += BATCH) {
    const batch    = phase1Records.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    try {
      const res = await sbFetch(`${base}/assets?on_conflict=client_id,shortcode`, {
        method:  'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body:    JSON.stringify(batch),
      });
      if (!res.ok) {
        appendLog('error', `  ✕  Phase 1 batch ${batchNum}: ${await res.text()}`);
        result.errors += batch.length;
      } else {
        const created = batch.filter(r => !existingMap.has(r.shortcode as string)).length;
        result.created += created;
        result.updated += batch.length - created;
        appendLog('success', `  ✓  Phase 1 batch ${batchNum}: ${created} new · ${batch.length - created} updated`);
      }
    } catch (e) {
      appendLog('error', `  ✕  Phase 1 batch ${batchNum}: ${e}`);
      result.errors += batch.length;
    }
  }

  // ── Phase 2: gallery children (parent_id set) ──────────────────────────────
  let childRecords: Record<string, unknown>[] = [];
  if (legacyGalleries.length > 0) {
    const parentShortcodes = legacyGalleries.map(g => parseAssetForSupabase(g.name, vocab).shortcode);
    const parentIdMap = new Map<string, string>(); // parentShortcode → uuid

    // Primary: existingMap already has pre-existing parent IDs — no extra network request
    for (const sc of parentShortcodes) {
      const row = existingMap.get(sc);
      if (row?.id) parentIdMap.set(sc, row.id);
    }
    // Fallback: for parents newly created in Phase 1, fetch individually via eq. (safe with special chars)
    const missing = parentShortcodes.filter(sc => !parentIdMap.has(sc));
    for (const sc of missing) {
      try {
        const res = await sbFetch(
          `${base}/assets?client_id=eq.${clientId}&shortcode=eq.${encodeURIComponent(sc)}&select=id&limit=1`,
          { headers },
        );
        if (res.ok) {
          const rows = await res.json() as Array<{ id: string }>;
          if (rows[0]?.id) parentIdMap.set(sc, rows[0].id);
        }
      } catch { /* skip this parent */ }
    }
    appendLog('dim', `  Gallery parents: ${parentIdMap.size}/${legacyGalleries.length} IDs resolved`);

    const childSeen = new Map<string, Record<string, unknown>>(); // shortcode → record (dedup)
    for (const g of legacyGalleries) {
      const parentShortcode = parseAssetForSupabase(g.name, vocab).shortcode;
      const parentId = parentIdMap.get(parentShortcode);
      if (!parentId) {
        appendLog('error', `  ✕  No parent ID for gallery "${g.name}" — children skipped`);
        continue;
      }
      const pp = parseAssetForSupabase(g.name, vocab);
      for (const childStem of g.childStems) {
        const sc = `${parentShortcode}|${childStem}`;
        if (childSeen.has(sc)) continue; // skip duplicate stems within same gallery
        const cp = parseAssetForSupabase(childStem, vocab);
        childSeen.set(sc, {
          client_id:     clientId,
          shortcode:     sc,
          name:          cp.name || childStem,
          entities:      cp.entities.length ? cp.entities : pp.entities,
          formats:       cp.formats.length  ? cp.formats  : pp.formats,
          angles:        cp.angles.length   ? cp.angles   : pp.angles,
          tags:          cp.tags.length     ? cp.tags     : pp.tags,
          version:       cp.version || pp.version,
          status:        'published',
          perm:          'public',
          thumbnail_url: cdnUrls?.get(childStem) ?? null,
          download_url:  originalUrls?.get(childStem) ?? null,
          download_urls: cloudUrls?.get(childStem) ?? [],
          parent_id:     parentId,
        });
      }
    }
    childRecords = [...childSeen.values()];
    preserveExistingUrls(childRecords);

    appendLog('dim', `  Phase 2 — ${childRecords.length} child record(s)`);
    for (let i = 0; i < childRecords.length; i += BATCH) {
      const batch    = childRecords.slice(i, i + BATCH);
      const batchNum = Math.floor(i / BATCH) + 1;
      try {
        const res = await sbFetch(`${base}/assets?on_conflict=client_id,shortcode`, {
          method:  'POST',
          headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body:    JSON.stringify(batch),
        });
        if (!res.ok) {
          appendLog('error', `  ✕  Phase 2 batch ${batchNum}: ${await res.text()}`);
          result.errors += batch.length;
        } else {
          const created = batch.filter(r => !existingMap.has(r.shortcode as string)).length;
          result.created += created;
          result.updated += batch.length - created;
          appendLog('success', `  ✓  Phase 2 batch ${batchNum}: ${created} new · ${batch.length - created} updated`);
        }
      } catch (e) {
        appendLog('error', `  ✕  Phase 2 batch ${batchNum}: ${e}`);
        result.errors += batch.length;
      }
    }

    // Include child shortcodes in the "current" set for stale detection (placeholder row)
    for (const cr of childRecords) {
      existingMap.set(cr.shortcode as string, { id: '', shortcode: cr.shortcode as string, thumbnail_url: null, download_key: null });
    }
  }

  // ── Stale detection ────────────────────────────────────────────────────────
  const currentShortcodes = new Set([
    ...phase1Records.map(r => r.shortcode as string),
    ...legacyGalleries.flatMap(g => {
      const ps = parseAssetForSupabase(g.name, vocab).shortcode;
      return g.childStems.map(cs => `${ps}|${cs}`);
    }),
  ]);

  const staleRows = [...existingMap.entries()]
    .filter(([sc, row]) => !currentShortcodes.has(sc) && row.id)
    .map(([, row]) => row);

  // Collect R2 object keys to delete (returned to caller; actual deletion handled by pipeline)
  function urlToObjectKey(url: string | null): string | null {
    if (!url) return null;
    const m = url.match(/(?:thumbnails|originals)\/.+/);
    return m ? m[0] : null;
  }

  // Protect R2 objects still referenced by any active record.
  // Gallery parents share their thumbnail_url with the first child — deleting a stale
  // parent record must not remove a CDN object that an active child still points to.
  const activeObjectKeys = new Set<string>();
  for (const [sc, row] of existingMap.entries()) {
    if (currentShortcodes.has(sc)) {
      const k = urlToObjectKey(row.thumbnail_url);
      if (k) activeObjectKeys.add(k);
    }
  }
  for (const r of phase1Records) {
    const k = urlToObjectKey(r.thumbnail_url as string | null);
    if (k) activeObjectKeys.add(k);
  }
  for (const r of childRecords) {
    const k = urlToObjectKey(r.thumbnail_url as string | null);
    if (k) activeObjectKeys.add(k);
  }

  const staleObjectKeys: string[] = [
    ...staleRows.map(r => urlToObjectKey(r.thumbnail_url))
      .filter((k): k is string => !!k && !activeObjectKeys.has(k)),
    ...staleRows.map(r => r.download_key).filter(Boolean) as string[],
  ];
  result.staleObjectKeys = staleObjectKeys;

  appendLog('dim', `  ${staleRows.length} stale → delete · ${staleObjectKeys.length} CDN object(s) to remove`);

  // Delete stale records — ON DELETE CASCADE removes any gallery children automatically
  for (let i = 0; i < staleRows.length; i += BATCH) {
    const batch    = staleRows.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    try {
      const res = await sbFetch(`${base}/assets?id=in.(${batch.map(r => r.id).join(',')})`, {
        method:  'DELETE',
        headers: { ...headers, Prefer: 'return=minimal' },
      });
      if (!res.ok) {
        appendLog('error', `  ✕  Delete batch ${batchNum}: ${await res.text()}`);
        result.errors += batch.length;
      } else {
        appendLog('dim', `  ✕  Deleted ${batch.length} stale record(s)`);
        result.deleted += batch.length;
      }
    } catch (e) {
      appendLog('error', `  ✕  Delete batch ${batchNum}: ${e}`);
      result.errors += batch.length;
    }
  }

  /* ═══════════════ Stable-identity groups (folder-anchored) ═══════════════
     Matched/written independently of the legacy pass above: keyed by
     `${stable_id}:${child_id}`, never by shortcode. A folder disappearing
     marks its rows `disconnected` (soft) rather than deleting them outright —
     unlike the legacy hard-delete above, since the entire point of this
     identity is to survive transient disk changes without orphaning
     ratings/comments/asset_events/approvals. */
  if (useStable && (stableSingles.length || stableGalleries.length)) {
    type StableRow = { id: string; stable_id: string; child_id: string | null; thumbnail_url: string | null; download_key?: string | null; parent_id: string | null; variant_of: string | null };
    const stableExistingMap = new Map<string, StableRow>(); // `${stable_id}:${child_id}` → row
    try {
      const rows = await fetchAllForClient<StableRow>(
        base, 'assets?status=neq.archived&stable_id=not.is.null', clientId,
        'id,stable_id,child_id,thumbnail_url,parent_id,variant_of', headers,
      );
      for (const r of rows) stableExistingMap.set(`${r.stable_id}:${r.child_id ?? ''}`, r);
    } catch (e) {
      appendLog('error', `  ✕  Could not fetch existing stable-identity records: ${e}`);
    }
    const existingByStableId = new Map<string, StableRow[]>();
    for (const row of stableExistingMap.values()) {
      (existingByStableId.get(row.stable_id) ?? existingByStableId.set(row.stable_id, []).get(row.stable_id)!).push(row);
    }

    const manifests: ManifestStates = new Map();
    const manifestState = (packageDir: string, stableId: string) => getManifestState(manifests, packageDir, stableId);

    const currentStableKeys = new Set<string>();
    const parentWrites: Array<{ key: string; record: Record<string, unknown> }> = [];
    // Two distinct relationships, per client feedback: a gallery (many related-but-distinct
    // files under OUT/<subfolder>/, e.g. 60 event photos) needs a grid/carousel — that's
    // `parent_id`, the same field/UI legacy clients already use. A variant (several files
    // sitting directly in OUT — the same deliverable in different renditions, e.g. format
    // or background options) needs a picker — that's `variant_of`. Conflating them made the
    // web portal show a 60-chip picker for what should be a photo grid.
    const childWrites: Array<{ key: string; record: Record<string, unknown>; parentKey: string; relation: 'variant_of' | 'parent_id' }> = [];
    // One readme.md per package dir, keyed off the primary's own stem/name so its tags can
    // be re-parsed to full VocabTag[] (buildRecord already reduces those to label strings).
    const readmeTargets: Array<{ packageDir: string; stableId: string; stem: string }> = [];

    // Multiple singles can share one package dir (e.g. a set of format variants with no
    // gallery subfolder) — per Task 3, they're variants of one logical asset, not separate
    // assets. Group by dir first so we can single out the primary (child_id 'c1') before
    // deciding which write path (parent vs. variant) each one takes.
    const singlesByDir = new Map<string, Array<{ stem: string; stableId: string }>>();
    for (const { stem, packageDir, stableId } of stableSingles) {
      (singlesByDir.get(packageDir) ?? singlesByDir.set(packageDir, []).get(packageDir)!).push({ stem, stableId });
    }

    for (const [packageDir, items] of singlesByDir) {
      const stableId = items[0].stableId;
      const state    = await manifestState(packageDir, stableId);

      // Multiple files that differ only by trailing version (v1-2-1, v1-3-3, v1-3-5, ...)
      // are version history of ONE asset, not variants — collapse to the highest, exactly
      // like the legacy shortcode path always has (there, they silently overwrote one
      // another in the same Map). Older versions are still tracked, just via
      // syncVersionHistory, not as separate stable-identity rows. Only files that remain
      // genuinely distinct after this pass are true variants.
      const highestStems = new Set(filterHighestVersions(items.map(i => i.stem)));
      // Also collapse duplicate stems: groupAssets emits one entry per FILE, so
      // extension pairs (foo.pdf + foo.png) repeat a stem — resolving the stem
      // twice yields two records with the same child id, and the second write
      // used to stamp variant_of onto the chosen primary itself, hiding the group.
      const seenStems = new Set<string>();
      const deduped = items.filter(i => {
        if (!highestStems.has(i.stem) || seenStems.has(i.stem)) return false;
        seenStems.add(i.stem);
        return true;
      });

      // Deterministic order for brand-new manifests (no prior child_id yet) — matches
      // migrate-identity.ts's alphabetical assignment so a fresh folder's primary is stable.
      const ordered  = [...deduped].sort((a, b) => a.stem.localeCompare(b.stem));

      const resolvedItems: Array<{ stem: string; childId: string; record: Record<string, unknown> }> = [];
      for (const { stem } of ordered) {
        const absPath  = identity!.filePaths.get(stem);
        const filename = absPath?.split('/').pop() ?? stem;
        const resolved = absPath
          ? await resolveChildId(state.manifest, filename, absPath, state.used)
          : { childId: nextChildId(state.used), sha256: '', dirty: true };
        if (resolved.dirty) { state.manifest.children[filename] = { child_id: resolved.childId, sha256: resolved.sha256 }; state.dirty = true; }

        const key    = `${stableId}:${resolved.childId}`;
        const record = buildRecord(stem, { stable_id: stableId, child_id: resolved.childId });
        // The old client_id+shortcode unique constraint still exists (legacy upserts rely on it
        // for their on_conflict arbiter) — suffix with the now-guaranteed-unique stable key so
        // two different stable-identity assets can never collide just because they render the
        // same display text (e.g. two variants, or two unrelated assets with the same name).
        record.shortcode = `${record.shortcode} __${key}`;
        currentStableKeys.add(key);
        resolvedItems.push({ stem, childId: resolved.childId, record });
      }

      const primary = resolvedItems.find(i => i.childId === 'c1') ?? resolvedItems[0];
      const primaryKey = `${stableId}:${primary.childId}`;

      // A real variant group (more than one surviving file): the primary's own name/tags are
      // just one variant's filename, which reads as noise on a "group" card (e.g. a generic
      // group ending up named "... — Accuracy"). Rename it to the tags shared by every variant,
      // and roll every variant's tags/entities/formats/angles up onto it (union) so filtering by
      // a tag that only lives on one variant still surfaces the group. Single-file "groups" keep
      // today's behavior — there's nothing to be generic about.
      if (resolvedItems.length > 1) {
        const allTags     = resolvedItems.map(i => i.record.tags as string[]);
        const sharedTags  = intersectStrings(allTags);
        if (sharedTags.length) primary.record.name = sharedTags.join(' ');
        primary.record.tags     = unionStrings(allTags);
        primary.record.entities = unionStrings(resolvedItems.map(i => i.record.entities as string[]));
        primary.record.formats  = unionStrings(resolvedItems.map(i => i.record.formats as string[]));
        primary.record.angles   = unionStrings(resolvedItems.map(i => i.record.angles as string[]));
      }

      parentWrites.push({ key: primaryKey, record: primary.record });
      readmeTargets.push({ packageDir, stableId, stem: primary.stem });
      for (const item of resolvedItems) {
        // Compare by child id, not object identity — a duplicate resolution of
        // the primary must never become a self-referencing variant write.
        if (item.childId === primary.childId) continue;
        childWrites.push({ key: `${stableId}:${item.childId}`, record: item.record, parentKey: primaryKey, relation: 'variant_of' });
      }

      // Re-parent any row that used to be this group's DB-level primary (parent_id/variant_of
      // both null) but isn't the primary chosen this run — e.g. its file vanished from disk, or
      // 'c1' just reclaimed primary status from a stand-in. Without this it stays disconnected
      // but still top-of-hierarchy forever: a phantom duplicate card sitting next to the real one.
      for (const row of existingByStableId.get(stableId) ?? []) {
        const rowKey = `${row.stable_id}:${row.child_id ?? ''}`;
        if (rowKey === primaryKey) continue;
        if (row.parent_id !== null || row.variant_of !== null) continue;
        if (currentStableKeys.has(rowKey)) continue; // already queued as an ordinary variant above
        childWrites.push({ key: rowKey, record: {}, parentKey: primaryKey, relation: 'variant_of' });
      }
    }

    for (const { group, packageDir, stableId } of stableGalleries) {
      const state = await manifestState(packageDir, stableId);
      const parentSlot = '__gallery_parent__';
      let parentChildId = state.manifest.children[parentSlot]?.child_id;
      if (!parentChildId) {
        parentChildId = nextChildId(state.used);
        state.manifest.children[parentSlot] = { child_id: parentChildId, sha256: '' };
        state.dirty = true;
      } else {
        state.used.add(parentChildId);
      }

      const firstStableChild       = group.childStems.length > 0 ? group.childStems[0] : null;
      const firstChildThumb        = firstStableChild ? (cdnUrls?.get(firstStableChild) ?? null) : null;
      const firstChildOriginalUrl  = firstStableChild ? (originalUrls?.get(firstStableChild) ?? null) : null;
      const firstChildCloudUrls    = firstStableChild ? (cloudUrls?.get(firstStableChild) ?? []) : [];
      const pp        = parseAssetForSupabase(group.name, vocab);
      const parentKey = `${stableId}:${parentChildId}`;
      currentStableKeys.add(parentKey);
      readmeTargets.push({ packageDir, stableId, stem: group.name });
      parentWrites.push({
        key: parentKey,
        record: {
          client_id: clientId, stable_id: stableId, child_id: parentChildId,
          shortcode: `${pp.shortcode} __${parentKey}`, name: pp.name, entities: pp.entities, formats: pp.formats,
          angles: pp.angles, tags: pp.tags, version: pp.version,
          status: 'published', perm: 'public', thumbnail_url: firstChildThumb,
          download_url: firstChildOriginalUrl, download_urls: firstChildCloudUrls,
        },
      });

      for (const childStem of group.childStems) {
        const absPath  = identity!.filePaths.get(childStem);
        const filename = absPath?.split('/').pop() ?? childStem;
        const resolved = absPath
          ? await resolveChildId(state.manifest, filename, absPath, state.used)
          : { childId: nextChildId(state.used), sha256: '', dirty: true };
        if (resolved.dirty) { state.manifest.children[filename] = { child_id: resolved.childId, sha256: resolved.sha256 }; state.dirty = true; }

        const cp      = parseAssetForSupabase(childStem, vocab);
        const childKey = `${stableId}:${resolved.childId}`;
        currentStableKeys.add(childKey);
        childWrites.push({
          key: childKey, parentKey, relation: 'parent_id',
          record: {
            client_id: clientId, stable_id: stableId, child_id: resolved.childId,
            shortcode: `${pp.shortcode}|${childStem} __${childKey}`, name: cp.name || childStem,
            entities: cp.entities.length ? cp.entities : pp.entities,
            formats:  cp.formats.length  ? cp.formats  : pp.formats,
            angles:   cp.angles.length   ? cp.angles   : pp.angles,
            tags:     cp.tags.length     ? cp.tags     : pp.tags,
            version:  cp.version || pp.version,
            status: 'published', perm: 'public', thumbnail_url: cdnUrls?.get(childStem) ?? null,
            download_url: originalUrls?.get(childStem) ?? null, download_urls: cloudUrls?.get(childStem) ?? [],
          },
        });
      }
    }

    // Persist manifest changes (new/renamed children) before touching the DB.
    for (const [dir, state] of manifests) {
      if (!state.dirty) continue;
      try { await writeManifest(dir, state.manifest); }
      catch (e) { appendLog('error', `  ✕  Manifest write failed for "${dir}": ${e}`); }
    }

    // De-dupe by key before writing — two items resolving to the same stable_id:child_id
    // within one run (e.g. a duplicate scan entry) must collapse to a single write, or the
    // second one would try to INSERT a row its sibling just created a moment ago.
    function dedupe<T extends { key: string }>(items: T[], label: string): T[] {
      const byKey = new Map<string, T>();
      for (const item of items) {
        if (byKey.has(item.key)) appendLog('warn', `  ⚠  Duplicate ${label} target ${item.key} this run — keeping first, dropping repeat`);
        else byKey.set(item.key, item);
      }
      return [...byKey.values()];
    }
    const dedupedParents = dedupe(parentWrites, 'parent/single');
    // Final guard: a key can't be both a primary and a child — the primary wins,
    // or the child write would PATCH a relation onto the primary's own row.
    const parentKeys = new Set(dedupedParents.map(p => p.key));
    const dedupedChildren = dedupe(childWrites, 'child').filter(c => {
      if (!parentKeys.has(c.key)) return true;
      appendLog('warn', `  ⚠  ${c.key} resolved as both primary and child — keeping the primary`);
      return false;
    });

    // PATCH leaves omitted fields untouched in Postgres — drop URL fields we have no
    // value for, so a run where an upload phase was cached or disabled can't wipe
    // URLs the DB already carries (thumbnail_url / the portal's download_url).
    function stripAbsentUrls(record: Record<string, unknown>): Record<string, unknown> {
      const out = { ...record };
      if (out.thumbnail_url == null) delete out.thumbnail_url;
      if (out.download_url == null) delete out.download_url;
      if (Array.isArray(out.download_urls) && out.download_urls.length === 0) delete out.download_urls;
      return out;
    }

    // Parents/singles first — children need the resolved parent uuid. `stableExistingMap`
    // is updated as we go so a key resolved more than once this run (if dedupe above ever
    // misses one, e.g. a stale/renamed key clash) still lands as an update, not a collision.
    const parentIdByKey = new Map<string, string>();
    for (const { key, record: rawRecord } of dedupedParents) {
      // A primary/gallery-parent row is always top-of-hierarchy — clear both relation
      // fields explicitly so a stale value from an earlier build (before galleries/variants
      // were split) can't linger (PATCH leaves omitted fields untouched in Postgres).
      const record = stripAbsentUrls({ ...rawRecord, parent_id: null, variant_of: null });
      const existingRow = stableExistingMap.get(key);
      try {
        if (existingRow) {
          const res = await sbFetch(`${base}/assets?id=eq.${existingRow.id}`, {
            method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify(record),
          });
          if (res.ok) { result.updated++; parentIdByKey.set(key, existingRow.id); }
          else { appendLog('error', `  ✕  Stable update failed for ${key}: ${await res.text()}`); result.errors++; }
        } else {
          const res = await sbFetch(`${base}/assets`, {
            method: 'POST', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify(record),
          });
          if (res.ok) {
            const created = await res.json<Array<{ id: string }>>();
            result.created++;
            if (created[0]?.id) {
              parentIdByKey.set(key, created[0].id);
              stableExistingMap.set(key, { id: created[0].id, stable_id: rawRecord.stable_id as string, child_id: rawRecord.child_id as string, thumbnail_url: (rawRecord.thumbnail_url as string | null) ?? null, parent_id: null, variant_of: null });
            }
          } else { appendLog('error', `  ✕  Stable insert failed for ${key}: ${await res.text()}`); result.errors++; }
        }
      } catch (e) { appendLog('error', `  ✕  Stable write error for ${key}: ${e}`); result.errors++; }
    }

    for (const { key, record, parentKey, relation } of dedupedChildren) {
      const parentId = parentIdByKey.get(parentKey);
      if (!parentId) { appendLog('error', `  ✕  No parent ID for ${key} — child skipped`); result.errors++; continue; }
      // Explicitly null the *other* relation field too — a row synced by an earlier build
      // (before galleries/variants were split apart) may still carry a stale value there,
      // and a PATCH that omits a field leaves its existing value untouched in Postgres.
      const otherRelation = relation === 'parent_id' ? 'variant_of' : 'parent_id';
      const withParent = stripAbsentUrls({ ...record, [relation]: parentId, [otherRelation]: null });
      const existingRow = stableExistingMap.get(key);
      try {
        if (existingRow) {
          const res = await sbFetch(`${base}/assets?id=eq.${existingRow.id}`, {
            method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify(withParent),
          });
          if (res.ok) result.updated++;
          else { appendLog('error', `  ✕  Stable child update failed for ${key}: ${await res.text()}`); result.errors++; }
        } else {
          const res = await sbFetch(`${base}/assets`, {
            method: 'POST', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify(withParent),
          });
          if (res.ok) {
            const created = await res.json<Array<{ id: string }>>();
            result.created++;
            if (created[0]?.id) stableExistingMap.set(key, { id: created[0].id, stable_id: record.stable_id as string, child_id: record.child_id as string, thumbnail_url: (record.thumbnail_url as string | null) ?? null, parent_id: (withParent.parent_id as string | null) ?? null, variant_of: (withParent.variant_of as string | null) ?? null });
          } else { appendLog('error', `  ✕  Stable child insert failed for ${key}: ${await res.text()}`); result.errors++; }
        }
      } catch (e) { appendLog('error', `  ✕  Stable child write error for ${key}: ${e}`); result.errors++; }
    }

    appendLog('success', `  ✓  Stable identity: ${parentWrites.length} parent/single · ${childWrites.length} child record(s) synced`);

    // readme.md — human/Obsidian-facing mirror of the DB, regenerated in full every run
    // (Task 5). Stats attach to the primary row only, matching Task 3's convention that
    // ratings/comments/downloads are tracked against the primary, not individual variants.
    if (readmeTargets.length) {
      const primaryIds = readmeTargets
        .map(t => parentIdByKey.get(`${t.stableId}:c1`))
        .filter((id): id is string => !!id);
      const statsMap = await fetchAssetStats(primaryIds, config);
      const vocabCtx = buildVocabContext(vocab);
      let written = 0;
      for (const t of readmeTargets) {
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
      appendLog('dim', `  readme.md written for ${written}/${readmeTargets.length} folder(s)`);
    }

    // Stale stable rows — soft-disconnect only; R2 cleanup stays a separate, explicit action.
    const staleStable = [...stableExistingMap.entries()]
      .filter(([key]) => !currentStableKeys.has(key))
      .map(([, row]) => row);
    if (staleStable.length) {
      for (let i = 0; i < staleStable.length; i += BATCH) {
        const batch = staleStable.slice(i, i + BATCH);
        try {
          const res = await sbFetch(`${base}/assets?id=in.(${batch.map(r => r.id).join(',')})`, {
            method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'disconnected' }),
          });
          if (!res.ok) appendLog('error', `  ✕  Stable stale-mark failed: ${await res.text()}`);
          else {
            appendLog('dim', `  ⦾  Marked ${batch.length} stable record(s) disconnected (folder/file no longer on disk)`);
            result.disconnected += batch.length;
          }
        } catch (e) { appendLog('error', `  ✕  Stable stale-mark error: ${e}`); }
      }
      result.staleObjectKeys.push(...staleStable.map(r => r.download_key).filter(Boolean) as string[]);
    }
  }

  appendLog('section',
    `━━━ SUPABASE DONE — ${result.created} new · ${result.updated} updated · ${result.disconnected} disconnected · ${result.deleted} deleted · ${result.errors} errors ━━━`,
  );
  return result;
}

/* ── Tag hierarchy sync ──────────────────────────────────────────────────── */

const SUBTYPE_LABELS: Record<string, string> = {
  company:     'Company',
  product:     'Product',
  customer:    'Customer',
  partner:     'Partner',
  event:       'Event',
  'sales-mktg': 'Sales & Marketing',
  content:     'Content',
  context:     'Context',
  document:    'Document',
  media:       'Media',
  asset:       'Asset',
};

const SLOT_SUBTYPE_ORDER: Record<string, string[]> = {
  entity: ['company', 'product', 'customer', 'partner', 'event'],
  angle:  ['sales-mktg', 'content', 'context'],
  format: ['document', 'media', 'asset'],
};

/**
 * Syncs vocabulary tag groups to the Supabase tags table.
 * Creates subtype group headers as parent tags (Company / Product / Customer …)
 * and links every leaf vocab tag to its parent. Idempotent — safe to call on
 * every pipeline run.
 */
export async function syncTagsFromVocabulary(
  vocab:     VocabularyData,
  clientId:  string,
  config:    SupabaseConfig,
  appendLog: (type: string, msg: string) => void,
): Promise<void> {
  appendLog('section', '━━━ TAG SYNC ━━━');
  const base    = `${config.url}/rest/v1`;
  const headers = makeHeaders(config.anonKey);

  type TagRow = { id: string; name: string; dimension: string; parent_id: string | null };

  // Fetch all existing tags for this client
  let existing: TagRow[] = [];
  try {
    const res = await sbFetch(
      `${base}/tags?client_id=eq.${clientId}&select=id,name,dimension,parent_id&order=sort_order`,
      { headers },
    );
    if (res.ok) existing = await res.json<TagRow[]>();
    else { appendLog('error', `  ✕  Could not fetch tags: ${await res.text()}`); return; }
  } catch (e) {
    appendLog('error', `  ✕  Tag fetch error: ${e}`); return;
  }

  const byKey = new Map<string, TagRow>(); // "dimension::name" → row
  for (const r of existing) byKey.set(`${r.dimension}::${r.name}`, r);

  const slots: Array<'entity' | 'format' | 'angle'> = ['entity', 'format', 'angle'];
  const parentIdMap = new Map<string, string>(); // "dimension::subtype" → id
  let parentCreated = 0, leafCreated = 0, leafUpdated = 0;

  // Pass 1 — ensure group header (parent) tags exist
  for (const slot of slots) {
    const slotVocabTags = vocab.tags.filter(t => t.slot === slot);
    const usedSubtypes  = [...new Set(slotVocabTags.map(t => t.subtype))];
    const ordered       = (SLOT_SUBTYPE_ORDER[slot] ?? []).filter(s => usedSubtypes.includes(s as never));

    for (let i = 0; i < ordered.length; i++) {
      const subtype = ordered[i];
      const label   = SUBTYPE_LABELS[subtype] ?? subtype;
      const key     = `${slot}::${label}`;

      if (byKey.has(key)) {
        parentIdMap.set(`${slot}::${subtype}`, byKey.get(key)!.id);
        continue;
      }
      try {
        const res = await sbFetch(`${base}/tags`, {
          method:  'POST',
          headers: { ...headers, Prefer: 'return=representation' },
          body:    JSON.stringify({ client_id: clientId, name: label, dimension: slot, parent_id: null, sort_order: (i + 1) * 1000 }),
        });
        if (res.ok) {
          const rows = await res.json<TagRow[]>();
          if (rows[0]?.id) { parentIdMap.set(`${slot}::${subtype}`, rows[0].id); parentCreated++; }
        } else appendLog('error', `  ✕  Group "${label}": ${await res.text()}`);
      } catch (e) { appendLog('error', `  ✕  Group "${label}": ${e}`); }
    }
  }

  // Pass 2 — ensure leaf tags exist and point to the correct parent
  for (const slot of slots) {
    const slotVocabTags = vocab.tags.filter(t => t.slot === slot);
    for (let i = 0; i < slotVocabTags.length; i++) {
      const tag      = slotVocabTags[i];
      const parentId = parentIdMap.get(`${slot}::${tag.subtype}`) ?? null;
      const key      = `${slot}::${tag.label}`;
      const row      = byKey.get(key);

      if (row) {
        if (row.parent_id !== parentId) {
          try {
            await sbFetch(`${base}/tags?id=eq.${row.id}`, {
              method:  'PATCH',
              headers: { ...headers, Prefer: 'return=minimal' },
              body:    JSON.stringify({ parent_id: parentId, sort_order: i }),
            });
            leafUpdated++;
          } catch { /* ignore */ }
        }
        continue;
      }

      try {
        const res = await sbFetch(`${base}/tags`, {
          method:  'POST',
          headers: { ...headers, Prefer: 'return=minimal' },
          body:    JSON.stringify({ client_id: clientId, name: tag.label, dimension: slot, parent_id: parentId, sort_order: i }),
        });
        if (res.ok) leafCreated++;
        else appendLog('error', `  ✕  Leaf "${tag.label}": ${await res.text()}`);
      } catch { /* ignore */ }
    }
  }

  appendLog('dim', `  ${parentCreated} groups created · ${leafCreated} leaf tags added · ${leafUpdated} updated`);
  appendLog('section', `━━━ TAG SYNC DONE ━━━`);
}

/* ── Version History sync ────────────────────────────────────────────────── */

export async function syncVersionHistory(
  versionMap: Map<string, AssetVersions>,
  clientId:   string,
  vocab:      VocabularyData,
  config:     SupabaseConfig,
  appendLog:  (type: string, msg: string) => void,
): Promise<void> {
  appendLog('section', '━━━ VERSION HISTORY SYNC ━━━');

  const base     = `${config.url}/rest/v1`;
  const headers  = makeHeaders(config.anonKey);
  const vocabCtx = buildVocabContext(vocab);
  const today    = new Date().toISOString().slice(0, 10);

  // Step 1: Fetch asset id+shortcode for this client
  appendLog('dim', '  Fetching asset IDs…');
  const shortcodeToId = new Map<string, string>(); // display shortcode → asset uuid
  try {
    const rows = await fetchAllForClient<{ id: string; shortcode: string }>(
      base, 'assets', clientId, 'id,shortcode', headers,
    );
    // Stable-identity rows carry a " __<hash>:<child>" suffix on shortcode (kept unique
    // per the identity key, since it's display-only there) — strip it back off so this
    // matches scanVersionMap's plain, version-stripped keys the same way a legacy row's
    // shortcode already does.
    for (const r of rows) shortcodeToId.set(r.shortcode.trim().replace(/ __[0-9a-f]{8}:c\d+$/, ''), r.id);
  } catch (e) {
    appendLog('error', `  ✕  Failed to fetch asset IDs: ${e}`);
    return;
  }
  appendLog('dim', `  ${shortcodeToId.size} asset(s) found`);

  // Step 2: Fetch existing VH rows for these assets
  const assetIds = [...shortcodeToId.values()];
  const existingVH = new Map<string, Map<string, { id: string; status: string }>>(); // assetId → version → record
  try {
    const rows = await fetchVHForAssets(base, assetIds, headers);
    for (const r of rows) {
      const byVer = existingVH.get(r.asset_id) ?? new Map();
      byVer.set(r.version.trim(), { id: r.id, status: r.status });
      existingVH.set(r.asset_id, byVer);
    }
  } catch (e) {
    appendLog('error', `  ✕  Failed to fetch version history: ${e}`);
    return;
  }
  const totalExisting = [...existingVH.values()].reduce((n, m) => n + m.size, 0);
  appendLog('dim', `  ${totalExisting} VH record(s) loaded`);

  const assetIdToShortcode = new Map([...shortcodeToId.entries()].map(([sc, id]) => [id, sc]));

  const toUpsert:     Record<string, unknown>[] = [];
  const toDisconnect: string[]                  = [];
  const toRemove:     string[]                  = [];

  // Step 3: Diff desired state vs existing
  for (const [sc, av] of versionMap) {
    const assetId = shortcodeToId.get(sc);
    if (!assetId) {
      appendLog('dim', `  ⚠  No Supabase asset for "${sc}" — VH skipped`);
      continue;
    }

    const desired = new Map<string, { status: 'Active' | 'History'; file: string }>();
    if (av.current) desired.set(av.current.version, { status: 'Active',   file: av.current.file });
    for (const h of av.history) desired.set(h.version, { status: 'History', file: h.file });

    const existingVersions = existingVH.get(assetId) ?? new Map();

    // Versions to create or update status on
    for (const [version, { status, file }] of desired) {
      const existing = existingVersions.get(version);
      if (!existing || existing.status !== status) {
        const parsed    = parseFilename(sc, vocabCtx);
        const nameParts = [
          ...parsed.tags.map(t => t.label),
          ...parsed.unknownTags.map(u => `[${u}]`),
        ];
        let name = nameParts.join(' ');
        if (parsed.description) name += ` — ${parsed.description}`;
        name = name.trim() || sc;

        toUpsert.push({
          asset_id:      assetId,
          version,
          version_label: version ? `${name} ${version}` : name,
          status,
          file_url:      `file://${file}`,
          date:          today,
        });
      }
    }

    // Versions in DB not in desired → Disconnected
    for (const [version, rec] of existingVersions) {
      if (!desired.has(version) && rec.status !== 'Disconnected') {
        toDisconnect.push(rec.id);
      }
    }
  }

  // Assets entirely gone from source → Removed
  for (const [assetId, byVersion] of existingVH) {
    const sc = assetIdToShortcode.get(assetId);
    if (!sc || !versionMap.has(sc)) {
      for (const [, rec] of byVersion) {
        if (rec.status !== 'Removed') toRemove.push(rec.id);
      }
    }
  }

  appendLog('info', `  ${toUpsert.length} to upsert · ${toDisconnect.length} to disconnect · ${toRemove.length} to remove`);

  // Step 4: Upsert
  for (let i = 0; i < toUpsert.length; i += BATCH) {
    const batch    = toUpsert.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    try {
      const res = await sbFetch(`${base}/version_history?on_conflict=asset_id,version`, {
        method:  'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body:    JSON.stringify(batch),
      });
      if (!res.ok) {
        appendLog('error', `  ✕  VH upsert batch ${batchNum}: ${await res.text()}`);
      } else {
        appendLog('success', `  ✓  VH batch ${batchNum}: ${batch.length} upserted`);
      }
    } catch (e) {
      appendLog('error', `  ✕  VH upsert batch ${batchNum}: ${e}`);
    }
  }

  // Step 5: Status patches (Disconnected, Removed)
  async function patchVHStatus(ids: string[], status: string, label: string) {
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      try {
        const res = await sbFetch(`${base}/version_history?id=in.(${batch.join(',')})`, {
          method:  'PATCH',
          headers: { ...headers, Prefer: 'return=minimal' },
          body:    JSON.stringify({ status }),
        });
        if (!res.ok) {
          appendLog('error', `  ✕  VH ${label}: ${await res.text()}`);
        } else {
          appendLog('dim', `  ↷  Marked ${batch.length} VH record(s) → ${status}`);
        }
      } catch (e) {
        appendLog('error', `  ✕  VH ${label}: ${e}`);
      }
    }
  }

  await patchVHStatus(toDisconnect, 'Disconnected', 'disconnect');
  await patchVHStatus(toRemove,     'Removed',      'remove');

  appendLog('section',
    `━━━ VH DONE — ${toUpsert.length} upserted · ${toDisconnect.length} disconnected · ${toRemove.length} removed ━━━`,
  );
}

/* ── Connection check (used by Settings UI) ──────────────────────────────── */

export async function checkSupabaseConnection(
  url:     string,
  anonKey: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await sbFetch(
      `${url.trim()}/rest/v1/clients?select=count&limit=0`,
      { headers: makeHeaders(anonKey.trim()) },
    );
    if (res.ok) return { ok: true, message: 'Connected — session authorized' };
    const body = await res.text();
    return { ok: false, message: `Error ${res.status}: ${body.slice(0, 120)}` };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}
