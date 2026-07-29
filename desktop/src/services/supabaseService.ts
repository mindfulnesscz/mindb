import { readFile, readTextFile, writeTextFile, exists as fsExists } from '@tauri-apps/plugin-fs';
import { parseFilename, buildVocabMap } from '../domain/filenameTranslator';
import type { CloudDestination } from '../domain/client';
import { normalizeDestination, resolveExportShape } from '../domain/client';
import { extractStableId, stripStableId } from '../domain/stableId';
import { filterHighestVersions, parseVersion, compareVersions } from '../domain/version';
import type { VocabularyData } from '../domain/vocabulary';
import type { GalleryGroup, SingleAsset } from '../domain/assetGrouping';
import type { AssetVersions, CloudUrlEntry } from './pipelineService';
import { writeReadme } from './readmeService';
import type { AssetStatsSnapshot } from './readmeService';
import type { SupabaseConfig } from './supabase/rest';
import { makeHeaders, sbFetch, fetchAllForClient } from './supabase/rest';
export type { SupabaseConfig } from './supabase/rest';
export { requestR2Grant, type R2Grant } from './supabase/r2Grant';
export { processRenameTasks } from './supabase/renameTasks';

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface SupabaseExportResult {
  created:        number;
  updated:        number;
  disconnected:   number; // stable-identity rows soft-marked disconnected this run
  errors:         number;
  staleObjectKeys: string[]; // R2 object keys that should be deleted (thumbnails + originals)
}

/** Existing stable_ids for a client — used to collision-check a freshly generated one
 * before scaffolding a new asset folder (see VocabularyView.tsx). */
export async function fetchExistingStableIds(
  clientId: string,
  config:   SupabaseConfig,
): Promise<Set<string>> {
  const base    = `${config.url}/rest/v1`;
  const headers = makeHeaders(config.anonKey);
  const rows = await fetchAllForClient<{ stable_id: string }>(
    base, 'assets', clientId, 'stable_id', headers,
  );
  return new Set(rows.map(r => r.stable_id));
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

/* fetch helpers live in supabase/rest.ts */

/* ── Version history pagination ──────────────────────────────────────────── */

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

/* resolveClientId (lookup-or-create by name) is gone: clients are DB-first —
   the desktop picks a client the database already knows, so its UUID is the
   identity everywhere. Creation lives in the client picker (admin, RLS-gated). */

/* ── Cloud destination definitions — shared across the team via Supabase.
   Tokens never leave the machine that holds them; only the shape (client ID,
   tenant ID, remote path, role, etc.) syncs. ──────────────────────────────── */

/** Strips the OAuth token from a destination's config before it's written to Supabase. */
function stripToken(dest: CloudDestination): CloudDestination {
  const shape = resolveExportShape(dest);
  const base = { ...dest, exportLayout: shape.exportLayout, includePackages: shape.includePackages };
  if (base.config.type === 'local') {
    return { ...base, config: { type: 'local', path: '' } };
  }
  const config = { ...base.config, token: null };
  if (config.type === 'gdrive') config.clientSecret = '';
  return { ...base, config };
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
    const raw = rows[0]?.cloud_destinations ?? [];
    return raw.map(d => normalizeDestination(d));
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
  const shortcode = input.name;
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
  const ctx    = buildVocabMap(vocab);
  const parsed = parseFilename(assetStem, ctx);

  const shortcode  = stripVersionSuffix(assetStem);
  const entityTags = parsed.tags.filter(t => t.slot === 'entity');
  const formatTags = parsed.tags.filter(t => t.slot === 'format');
  const angleTags  = parsed.tags.filter(t => t.slot === 'angle');

  // Preserve filename order; drop duplicate labels (same shortcode twice, or
  // two shortcodes sharing one display name across slots).
  const nameParts: string[] = [];
  const seenLabels = new Set<string>();
  for (const t of parsed.tags) {
    if (seenLabels.has(t.label)) continue;
    seenLabels.add(t.label);
    nameParts.push(t.label);
  }
  for (const u of parsed.unknownTags) {
    const token = `[${u}]`;
    if (seenLabels.has(token)) continue;
    seenLabels.add(token);
    nameParts.push(token);
  }
  let name = nameParts.join(' ');
  if (parsed.description) name += ` — ${parsed.description}`;

  const uniqLabels = (tags: typeof parsed.tags) =>
    [...new Set(tags.map(t => t.label).filter(Boolean))];

  return {
    shortcode,
    name:       name.trim() || shortcode,
    entities:   uniqLabels(entityTags),
    formats:    uniqLabels(formatTags),
    angles:     uniqLabels(angleTags),
    tags:       [...seenLabels].filter(l => !l.startsWith('[')),
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
  let best: { childId: string; version: [number, number, number]; entryName: string | null } | null = null;
  for (const [name, entry] of Object.entries(manifest.children)) {
    const p = parseVersion(name);
    if (!p) continue;
    if (p.base.toLowerCase() !== parsed.base.toLowerCase()) continue;
    // An extensionless entry is the Vocabulary scaffold's placeholder (GeneratorView writes
    // `OUT/<stem>` with no extension precisely so the scanner ignores it) holding the
    // reserved 'c1'. Requiring an exact extension match would never let the real file claim
    // that id: it would mint c2 and leave the draft DB row stranded as a phantom primary.
    // Such a slot is claimable exactly once — otherwise a set of format variants sharing one
    // base (foo v1-0-0.png + foo v1-0-0.pdf) would all resolve to the same child id and the
    // duplicates would be dropped as self-variants of the primary. Retiring the key below is
    // what enforces that; `used` can't, since it is pre-seeded with every id in the manifest.
    const placeholder = !p.ext;
    if (!placeholder && p.ext.toLowerCase() !== parsed.ext.toLowerCase()) continue;
    if (!best || compareVersions(p.version, best.version) > 0) {
      best = { childId: entry.child_id, version: p.version, entryName: placeholder ? name : null };
    }
  }
  if (!best) return null;
  // Retire the placeholder key now that a real filename owns the id — the caller records the
  // real filename, and leaving both would let a later run hand the same id to another file.
  if (best.entryName) delete manifest.children[best.entryName];
  return best.childId;
}

/** The scaffold's reserved placeholder slot (extensionless key, empty-content sha) that no
 * real file has claimed yet — a gallery parent can adopt it so turning a freshly scaffolded
 * asset into a gallery keeps the draft row instead of orphaning it. */
function unclaimedScaffoldSlot(manifest: DchubManifest): { childId: string; key: string } | null {
  for (const [name, entry] of Object.entries(manifest.children)) {
    if (name.startsWith(GALLERY_SLOT_PREFIX)) continue;
    if (/\.[A-Za-z0-9]{1,8}$/.test(name)) continue; // real file, not the placeholder
    return { childId: entry.child_id, key: name };
  }
  return null;
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

const GALLERY_SLOT_PREFIX = '__gallery__:';

/**
 * Gallery parents are keyed by folder path (`__gallery__:Selected`). A rename
 * would otherwise mint a new child_id and leave the old parent holding the
 * pictures, so an orphaned slot in the same package is reused before a fresh id
 * is allocated.
 */
function resolveGalleryParentChildId(
  state: { manifest: DchubManifest; used: Set<string>; dirty: boolean },
  galleryPath: string,
  currentPathsInPackage: Set<string>,
): string {
  const parentSlot = `${GALLERY_SLOT_PREFIX}${galleryPath}`;
  const currentSlots = new Set(
    [...currentPathsInPackage].map(p => `${GALLERY_SLOT_PREFIX}${p}`),
  );
  const orphans = Object.entries(state.manifest.children).filter(
    ([k]) => k.startsWith(GALLERY_SLOT_PREFIX) && !currentSlots.has(k),
  );

  // One live gallery + one orphaned path slot ⇒ folder rename (also heals a prior
  // bad run that minted an empty parent under the new path while children stayed
  // on the old parent id).
  if (currentPathsInPackage.size === 1 && orphans.length === 1) {
    const [oldKey, entry] = orphans[0];
    const exact = state.manifest.children[parentSlot]?.child_id;
    if (exact && exact !== entry.child_id) delete state.manifest.children[parentSlot];
    state.manifest.children[parentSlot] = { child_id: entry.child_id, sha256: '' };
    delete state.manifest.children[oldKey];
    state.dirty = true;
    state.used.add(entry.child_id);
    return entry.child_id;
  }

  const exact = state.manifest.children[parentSlot]?.child_id;
  if (exact) {
    state.used.add(exact);
    return exact;
  }

  // Multi-gallery package: one renamed folder among several.
  const unresolved = [...currentPathsInPackage].filter(
    p => !state.manifest.children[`${GALLERY_SLOT_PREFIX}${p}`],
  );
  if (orphans.length === 1 && unresolved.length === 1 && unresolved[0] === galleryPath) {
    const [oldKey, entry] = orphans[0];
    state.manifest.children[parentSlot] = { child_id: entry.child_id, sha256: '' };
    delete state.manifest.children[oldKey];
    state.dirty = true;
    state.used.add(entry.child_id);
    return entry.child_id;
  }

  // Scaffolded-then-galleried: the Vocabulary placeholder reserved 'c1' for a single file,
  // but the deliverable turned out to be a folder of them. Adopt that slot for the parent so
  // the existing draft row becomes the gallery instead of a stranded phantom next to it.
  if (currentPathsInPackage.size === 1) {
    const scaffold = unclaimedScaffoldSlot(state.manifest);
    if (scaffold) {
      state.manifest.children[parentSlot] = { child_id: scaffold.childId, sha256: '' };
      delete state.manifest.children[scaffold.key];
      state.dirty = true;
      state.used.add(scaffold.childId);
      return scaffold.childId;
    }
  }

  const parentChildId = nextChildId(state.used);
  state.manifest.children[parentSlot] = { child_id: parentChildId, sha256: '' };
  state.dirty = true;
  return parentChildId;
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
 * `exportAssetsToSupabase`. Meant to run once, early, before CDN uploads, so those uploads
 * can key by this identity instead of the current filename. A file outside a hashed package
 * folder has no identity and is left out of the map; the CDN steps report those and skip
 * them rather than inventing a filename-based key. */
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
      const want = outFolderName.replace(/^\[\d+\]\s*/, '').trim().toLowerCase();
      const got  = parts[i].replace(/^\[\d+\]\s*/, '').trim().toLowerCase();
      if (got === want || got === 'out') { outIdx = i; break; }
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
  singles:      SingleAsset[],
  clientId:     string,
  vocab:        VocabularyData,
  config:       SupabaseConfig,
  appendLog:    (type: string, msg: string) => void,
  cdnUrls?:      Map<string, string>,
  cloudUrls?:    Map<string, CloudUrlEntry[]>,
  galleries?:    GalleryGroup[],
  originalUrls?: Map<string, string>,
): Promise<SupabaseExportResult> {
  const result: SupabaseExportResult = { created: 0, updated: 0, disconnected: 0, errors: 0, staleObjectKeys: [] };
  const base    = `${config.url}/rest/v1`;
  const headers = makeHeaders(config.anonKey);

  const allGalleries = galleries ?? [];

  /* ── Resolve each item's folder identity ──────────────────────────────────
     Every asset lives in a package folder carrying a ` __<hash>` suffix, written by
     the Vocabulary scaffold. Anything without one has no identity to sync by and is
     reported rather than guessed at. */
  const stableSingles:   Array<SingleAsset & { stableId: string }> = [];
  const stableGalleries: Array<{ group: GalleryGroup; packageDir: string; stableId: string }> = [];
  const unhashed: string[] = [];

  const hashOwners = new Map<string, Set<string>>(); // stableId → package dirs claiming it this run
  const claim = (sid: string, dir: string) => {
    const owners = hashOwners.get(sid) ?? new Set<string>();
    owners.add(dir);
    hashOwners.set(sid, owners);
  };
  for (const single of singles) {
    const sid = extractStableId(single.packageDir.split('/').pop() ?? '');
    if (sid) { stableSingles.push({ ...single, stableId: sid }); claim(sid, single.packageDir); }
    else unhashed.push(single.stem);
  }
  for (const group of allGalleries) {
    const sid = extractStableId(group.packageDir.split('/').pop() ?? '');
    if (sid) { stableGalleries.push({ group, packageDir: group.packageDir, stableId: sid }); claim(sid, group.packageDir); }
    else unhashed.push(group.name);
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

  const totalReceived = singles.length + allGalleries.reduce((n, g) => n + 1 + g.children.length, 0);
  appendLog('section', '━━━ SUPABASE EXPORT ━━━');
  appendLog('dim', `  ${singles.length} flat + ${allGalleries.length} galler${allGalleries.length === 1 ? 'y' : 'ies'} (${totalReceived} total)`);
  for (const name of unhashed) {
    appendLog('error', `  ✕  "${name}" sits in a folder with no " __<hash>" suffix — create it through Vocabulary → Create folder so it gets an identity. Skipped.`);
    result.errors += 1;
  }

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

  /* ═══════════════ Sync ═══════════════
     Rows are matched by `${stable_id}:${child_id}` — the package folder's hash plus
     the manifest's per-file id — never by shortcode, so renaming a file or retitling
     an asset keeps its row. A folder disappearing marks its rows `disconnected`
     (soft) rather than deleting them, so transient disk changes never orphan
     ratings/comments/asset_events/approvals. */
  if (stableSingles.length || stableGalleries.length) {
    type StableRow = { id: string; stable_id: string; child_id: string; thumbnail_url: string | null; download_key?: string | null; parent_id: string | null; variant_of: string | null };
    const stableExistingMap = new Map<string, StableRow>(); // `${stable_id}:${child_id}` → row
    try {
      const rows = await fetchAllForClient<StableRow>(
        base, 'assets?status=neq.archived', clientId,
        'id,stable_id,child_id,thumbnail_url,parent_id,variant_of', headers,
      );
      for (const r of rows) stableExistingMap.set(`${r.stable_id}:${r.child_id}`, r);
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
    // `parent_id`. A variant (several files
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
    const singlesByDir = new Map<string, Array<{ stem: string; absPath: string; stableId: string }>>();
    for (const { stem, absPath, packageDir, stableId } of stableSingles) {
      (singlesByDir.get(packageDir) ?? singlesByDir.set(packageDir, []).get(packageDir)!).push({ stem, absPath, stableId });
    }

    for (const [packageDir, items] of singlesByDir) {
      const stableId = items[0].stableId;
      const state    = await manifestState(packageDir, stableId);

      // Multiple files that differ only by trailing version (v1-2-1, v1-3-3, v1-3-5, ...)
      // are version history of ONE asset, not variants — collapse to the highest. Older
      // versions are still tracked, just via syncVersionHistory, not as separate rows.
      // Only files that remain genuinely distinct after this pass are true variants.
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
      for (const { stem, absPath } of ordered) {
        const filename = absPath.split('/').pop()!;
        const resolved = await resolveChildId(state.manifest, filename, absPath, state.used);
        if (resolved.dirty) { state.manifest.children[filename] = { child_id: resolved.childId, sha256: resolved.sha256 }; state.dirty = true; }

        const key    = `${stableId}:${resolved.childId}`;
        const record = buildRecord(stem, { stable_id: stableId, child_id: resolved.childId });
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
        const rowKey = `${row.stable_id}:${row.child_id}`;
        if (rowKey === primaryKey) continue;
        if (row.parent_id !== null || row.variant_of !== null) continue;
        if (currentStableKeys.has(rowKey)) continue; // already queued as an ordinary variant above
        childWrites.push({ key: rowKey, record: {}, parentKey: primaryKey, relation: 'variant_of' });
      }
    }

    // Group by package so gallery-folder renames can reuse orphaned parent slots.
    const galleriesByPackage = new Map<string, typeof stableGalleries>();
    for (const entry of stableGalleries) {
      const list = galleriesByPackage.get(entry.packageDir) ?? [];
      list.push(entry);
      galleriesByPackage.set(entry.packageDir, list);
    }

    for (const [, packageGalleries] of galleriesByPackage) {
      const pathsInPackage = new Set(packageGalleries.map(g => g.group.name));
      for (const { group, packageDir, stableId } of packageGalleries) {
      const state = await manifestState(packageDir, stableId);
      const parentChildId = resolveGalleryParentChildId(state, group.name, pathsInPackage);

      const firstChild             = group.children[0]?.stem ?? null;
      const firstChildThumb        = firstChild ? (cdnUrls?.get(firstChild) ?? null) : null;
      const firstChildOriginalUrl  = firstChild ? (originalUrls?.get(firstChild) ?? null) : null;
      const firstChildCloudUrls    = firstChild ? (cloudUrls?.get(firstChild) ?? []) : [];
      // Nested gallery paths (Galleries/Selected) — parse the leaf folder for tags/name.
      const leafFolder = group.name.includes('/') ? group.name.slice(group.name.lastIndexOf('/') + 1) : group.name;
      const pp         = parseAssetForSupabase(leafFolder, vocab);
      // Package folder (OUT's parent) carries the searchable description — prefix it so
      // "Figurative Gallery Sculpture — Studio Retouches" stays findable as one concept.
      const packageFolder = stripStableId(packageDir.split('/').pop() ?? '');
      const pkg           = packageFolder ? parseAssetForSupabase(packageFolder, vocab) : null;
      const galleryLabel  = (pp.name || leafFolder).trim();
      const packageLabel  = (pkg?.name || '').trim();
      const displayName   = packageLabel && galleryLabel && packageLabel !== galleryLabel
        ? `${packageLabel} — ${galleryLabel}`
        : (packageLabel || galleryLabel);
      const uniq = (arr: string[]) => [...new Set(arr.filter(Boolean))];
      const parentKey = `${stableId}:${parentChildId}`;
      currentStableKeys.add(parentKey);
      readmeTargets.push({ packageDir, stableId, stem: group.name });
      parentWrites.push({
        key: parentKey,
        record: {
          client_id: clientId, stable_id: stableId, child_id: parentChildId,
          shortcode: pp.shortcode || pkg?.shortcode || leafFolder,
          name: displayName,
          entities: uniq([...(pkg?.entities ?? []), ...pp.entities]),
          formats:  uniq([...(pkg?.formats ?? []),  ...pp.formats]),
          angles:   uniq([...(pkg?.angles ?? []),   ...pp.angles]),
          tags:     uniq([...(pkg?.tags ?? []),     ...pp.tags]),
          version: pp.version || pkg?.version || '1-0-0',
          status: 'published', perm: 'public', thumbnail_url: firstChildThumb,
          download_url: firstChildOriginalUrl, download_urls: firstChildCloudUrls,
        },
      });

      for (const child of group.children) {
        const absPath  = child.absPath;
        const filename = absPath.split('/').pop()!;
        const resolved = await resolveChildId(state.manifest, filename, absPath, state.used);
        if (resolved.dirty) { state.manifest.children[filename] = { child_id: resolved.childId, sha256: resolved.sha256 }; state.dirty = true; }

        const fileStem = child.stem;
        const cp      = parseAssetForSupabase(fileStem, vocab);
        const childKey = `${stableId}:${resolved.childId}`;
        currentStableKeys.add(childKey);
        childWrites.push({
          key: childKey, parentKey, relation: 'parent_id',
          record: {
            client_id: clientId, stable_id: stableId, child_id: resolved.childId,
            shortcode: `${pp.shortcode}|${fileStem}`, name: cp.name || fileStem,
            entities: cp.entities.length ? cp.entities : pp.entities,
            formats:  cp.formats.length  ? cp.formats  : pp.formats,
            angles:   cp.angles.length   ? cp.angles   : pp.angles,
            tags:     cp.tags.length     ? cp.tags     : pp.tags,
            version:  cp.version || pp.version,
            status: 'published', perm: 'public', thumbnail_url: cdnUrls?.get(fileStem) ?? null,
            download_url: originalUrls?.get(fileStem) ?? null,
            download_urls: cloudUrls?.get(fileStem) ?? [],
          },
        });
      }
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
      const vocabCtx = buildVocabMap(vocab);
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
    `━━━ SUPABASE DONE — ${result.created} new · ${result.updated} updated · ${result.disconnected} disconnected · ${result.errors} errors ━━━`,
  );
  return result;
}

/* ── Tag hierarchy sync ──────────────────────────────────────────────────── */

interface DbTagSyncRow {
  id: string;
  name: string;
  key: string | null;
  dimension: string;
  parent_id: string | null;
  shortcode: string | null;
  sort_order: number;
}

function slugifyKeyPart(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '');
}

/** Parent taxonomy key for a leaf: strip last key segment, or invent from parentGroup name. */
function parentKeyForLeaf(tag: { key: string; slot: string; parentGroup: string | null }): string | null {
  if (!tag.parentGroup?.trim()) return null;
  const parts = tag.key.split('.').filter(Boolean);
  if (parts.length >= 2) return parts.slice(0, -1).join('.');
  return `${tag.slot}.${slugifyKeyPart(tag.parentGroup)}`;
}

/** Publish local leaf vocabulary → public.tags.
 * Parent groups are portal-managed — this only upserts/deletes shortcoded leaves.
 * Requires a signed-in staff session (RLS).
 */
export async function syncTagsFromVocabulary(
  vocab:     VocabularyData,
  clientId:  string,
  config:    SupabaseConfig,
  appendLog: (type: string, msg: string) => void,
): Promise<{ created: number; updated: number; deleted: number }> {
  appendLog('section', '━━━ TAG SYNC (local → portal) ━━━');
  const base    = `${config.url.replace(/\/+$/, '')}/rest/v1`;
  const headers = makeHeaders(config.anonKey);

  let existing: DbTagSyncRow[] = [];
  try {
    existing = await fetchAllForClient<DbTagSyncRow>(
      base, 'tags', clientId,
      'id,name,key,dimension,parent_id,shortcode,sort_order',
      headers,
    );
  } catch (e) {
    appendLog('error', `  ✕  Could not fetch tags: ${e}`);
    throw e;
  }
  appendLog('dim', `  ${existing.length} existing tag row(s)`);

  const byKey = new Map<string, DbTagSyncRow>();
  const byShortcode = new Map<string, DbTagSyncRow>();
  for (const r of existing) {
    if (r.key) byKey.set(r.key, r);
    if (r.shortcode) byShortcode.set(r.shortcode, r);
  }

  const slots: Array<'entity' | 'angle' | 'format'> = ['entity', 'angle', 'format'];
  let created = 0;
  let updated = 0;
  let deleted = 0;

  async function insertTag(body: Record<string, unknown>): Promise<DbTagSyncRow | null> {
    const res = await sbFetch(`${base}/tags`, {
      method:  'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      appendLog('error', `  ✕  Insert failed: ${await res.text()}`);
      return null;
    }
    const rows = await res.json<DbTagSyncRow[]>();
    return rows[0] ?? null;
  }

  async function patchTag(id: string, body: Record<string, unknown>): Promise<boolean> {
    const res = await sbFetch(`${base}/tags?id=eq.${id}`, {
      method:  'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      appendLog('error', `  ✕  Update ${id}: ${await res.text()}`);
      return false;
    }
    return true;
  }

  // Pass 1 — resolve existing portal parent groups (never create/edit groups from desktop)
  const parentIdByGroupKey = new Map<string, string>(); // `${slot}::${parentGroupName}` → id

  for (const row of existing) {
    const isRootGroup = !row.parent_id && !(row.shortcode ?? '').trim();
    if (!isRootGroup) continue;
    parentIdByGroupKey.set(`${row.dimension}::${row.name}`, row.id);
  }

  for (const slot of slots) {
    for (const leaf of vocab.tags.filter(t => t.slot === slot && t.parentGroup)) {
      const name = leaf.parentGroup!.trim();
      const mapKey = `${slot}::${name}`;
      if (parentIdByGroupKey.has(mapKey)) continue;
      // Try match by derived key from leaf path
      const gKey = parentKeyForLeaf(leaf);
      if (gKey && byKey.get(gKey)) {
        parentIdByGroupKey.set(mapKey, byKey.get(gKey)!.id);
        continue;
      }
      appendLog('dim', `  ⚠  Parent group "${name}" (${slot}) not in portal — leaf "${leaf.shortcode}" will be ungrouped`);
    }
  }

  // Pass 2 — shortcoded leaves only (groups stay portal-managed)
  const desiredShortcodes = new Set<string>();
  const desiredKeys = new Set<string>();

  for (const slot of slots) {
    const leaves = vocab.tags.filter(t => t.slot === slot);
    for (let i = 0; i < leaves.length; i++) {
      const tag = leaves[i];
      const shortcode = tag.shortcode.trim();
      if (!shortcode) continue;
      desiredShortcodes.add(shortcode);
      const key = tag.key.trim() || `${slot}.${slugifyKeyPart(tag.label)}`;
      desiredKeys.add(key);

      const parentId = tag.parentGroup
        ? (parentIdByGroupKey.get(`${slot}::${tag.parentGroup.trim()}`) ?? null)
        : null;

      const existingLeaf =
        byKey.get(key) ??
        byShortcode.get(shortcode) ??
        null;

      if (existingLeaf) {
        const patch: Record<string, unknown> = {};
        if (existingLeaf.name !== tag.label) patch.name = tag.label;
        if ((existingLeaf.key ?? null) !== key) patch.key = key;
        if ((existingLeaf.shortcode ?? null) !== shortcode) patch.shortcode = shortcode;
        if (existingLeaf.parent_id !== parentId) patch.parent_id = parentId;
        if (existingLeaf.dimension !== slot) patch.dimension = slot;
        if (existingLeaf.sort_order !== i) patch.sort_order = i;

        if (Object.keys(patch).length) {
          const oldShortcode = existingLeaf.shortcode;
          if (await patchTag(existingLeaf.id, patch)) {
            updated++;
            if (
              patch.shortcode !== undefined &&
              oldShortcode &&
              patch.shortcode !== oldShortcode
            ) {
              try {
                await sbFetch(`${base}/rename_tasks`, {
                  method:  'POST',
                  headers: { ...headers, Prefer: 'return=minimal' },
                  body: JSON.stringify({
                    client_id: clientId,
                    task_type: 'tag_rename',
                    payload: {
                      tag_id: existingLeaf.id,
                      old_shortcode: oldShortcode,
                      new_shortcode: shortcode,
                    },
                  }),
                });
              } catch (e) {
                appendLog('dim', `  ⚠  rename_task enqueue failed: ${e}`);
              }
            }
            Object.assign(existingLeaf, patch, { key, shortcode, parent_id: parentId, dimension: slot });
            byKey.set(key, existingLeaf);
            byShortcode.set(shortcode, existingLeaf);
          }
        }
        continue;
      }

      const row = await insertTag({
        client_id:  clientId,
        name:       tag.label,
        key,
        dimension:  slot,
        parent_id:  parentId,
        shortcode,
        sort_order: i,
      });
      if (row) {
        created++;
        byKey.set(key, row);
        byShortcode.set(shortcode, row);
        existing.push(row);
      }
    }
  }

  // Pass 3 — delete shortcoded DB leaves no longer in local vocab
  for (const row of existing) {
    const sc = (row.shortcode ?? '').trim();
    if (!sc) continue;
    const k = (row.key ?? '').trim();
    if (desiredShortcodes.has(sc) || (k && desiredKeys.has(k))) continue;
    try {
      const res = await sbFetch(`${base}/tags?id=eq.${row.id}`, {
        method: 'DELETE',
        headers: { ...headers, Prefer: 'return=minimal' },
      });
      if (res.ok) {
        deleted++;
        if (sc) {
          try {
            await sbFetch(`${base}/rename_tasks`, {
              method:  'POST',
              headers: { ...headers, Prefer: 'return=minimal' },
              body: JSON.stringify({
                client_id: clientId,
                task_type: 'tag_delete',
                payload: { tag_id: row.id, shortcode: sc },
              }),
            });
          } catch { /* non-fatal */ }
        }
      } else {
        appendLog('error', `  ✕  Delete "${row.name}": ${await res.text()}`);
      }
    } catch (e) {
      appendLog('error', `  ✕  Delete "${row.name}": ${e}`);
    }
  }

  appendLog('dim', `  ${created} created · ${updated} updated · ${deleted} deleted`);
  appendLog('section', '━━━ TAG SYNC DONE ━━━');
  return { created, updated, deleted };
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
  const vocabCtx = buildVocabMap(vocab);
  const today    = new Date().toISOString().slice(0, 10);

  // Step 1: Fetch asset identities for this client. Keyed `${stable_id}:${shortcode}` to
  // match scanVersionMap — the folder hash scopes the display text to one package, so two
  // assets rendering the same name can't collapse onto a single history.
  appendLog('dim', '  Fetching asset IDs…');
  const assetKeyToId = new Map<string, string>();
  try {
    const rows = await fetchAllForClient<{ id: string; shortcode: string; stable_id: string }>(
      base, 'assets', clientId, 'id,shortcode,stable_id', headers,
    );
    for (const r of rows) assetKeyToId.set(`${r.stable_id}:${r.shortcode.trim()}`, r.id);
  } catch (e) {
    appendLog('error', `  ✕  Failed to fetch asset IDs: ${e}`);
    return;
  }
  appendLog('dim', `  ${assetKeyToId.size} asset(s) found`);

  // Step 2: Fetch existing VH rows for these assets
  const assetIds = [...assetKeyToId.values()];
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

  const assetIdToKey = new Map([...assetKeyToId.entries()].map(([key, id]) => [id, key]));

  const toUpsert:     Record<string, unknown>[] = [];
  const toDisconnect: string[]                  = [];
  const toRemove:     string[]                  = [];

  // Step 3: Diff desired state vs existing
  for (const [key, av] of versionMap) {
    const sc      = av.shortcode;
    const assetId = assetKeyToId.get(key);
    if (!assetId) {
      appendLog('dim', `  ⚠  No Supabase asset for "${sc}" (${key}) — VH skipped`);
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
    const key = assetIdToKey.get(assetId);
    if (!key || !versionMap.has(key)) {
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
