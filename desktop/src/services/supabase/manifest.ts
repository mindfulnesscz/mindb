/* .dchub.json manifest — the on-disk half of folder identity.
 *
 * The manifest maps each file in a package folder to a stable `child_id`. Together with the
 * folder's ` __<hash>` suffix that pair is an asset's permanent address: its Supabase row, its CDN
 * object key, and every rating/comment hanging off it.
 * 
 * The matching ORDER in resolveChildId is the whole design (see its comment): manifest filename →
 * content hash (a renamed file keeps its id) → version lineage (a version bump keeps its id) → a
 * fresh id. Getting that order wrong strands DB rows as phantoms and orphans CDN objects.
 */

import { readFile, readTextFile, writeTextFile, exists as fsExists } from '@tauri-apps/plugin-fs';
import { parseVersion, compareVersions } from '@dc-hub/domain';

/* ── Folder-based stable identity: manifest + content-hash matching ────────
   See CLAUDE_CODE_PROMPT_identity-migration.md. A migrated client's asset
   folders carry a ` __<hash>` suffix (@dc-hub/domain stableId); the manifest below
   maps individual filenames inside that folder to a stable child_id, so
   renames don't create new DB rows. */

export interface DchubManifest {
  stable_id:  string;
  children:   Record<string, { child_id: string; sha256: string }>;
  updated_at: string;
}

const MANIFEST_FILENAME = '.dchub.json';

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function readManifest(packageDir: string): Promise<DchubManifest | null> {
  const path = `${packageDir}/${MANIFEST_FILENAME}`;
  try {
    if (!(await fsExists(path))) return null;
    return JSON.parse(await readTextFile(path)) as DchubManifest;
  } catch { return null; }
}

export async function writeManifest(packageDir: string, manifest: DchubManifest): Promise<void> {
  const path = `${packageDir}/${MANIFEST_FILENAME}`;
  await writeTextFile(path, JSON.stringify({ ...manifest, updated_at: new Date().toISOString() }, null, 2));
}

export function nextChildId(used: Set<string>): string {
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
export function versionLineageChildId(manifest: DchubManifest, filename: string): string | null {
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
export function unclaimedScaffoldSlot(manifest: DchubManifest): { childId: string; key: string } | null {
  for (const [name, entry] of Object.entries(manifest.children)) {
    if (name.startsWith(GALLERY_SLOT_PREFIX)) continue;
    if (/\.[A-Za-z0-9]{1,8}$/.test(name)) continue; // real file, not the placeholder
    return { childId: entry.child_id, key: name };
  }
  return null;
}

/** Matching order per Task 4: manifest filename → content-hash (renamed file) →
 * version lineage (version bump of a known asset) → brand-new. */
export async function resolveChildId(
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

export const GALLERY_SLOT_PREFIX = '__gallery__:';

/**
 * Gallery parents are keyed by folder path (`__gallery__:Selected`). A rename
 * would otherwise mint a new child_id and leave the old parent holding the
 * pictures, so an orphaned slot in the same package is reused before a fresh id
 * is allocated.
 */
export function resolveGalleryParentChildId(
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

export type ManifestStates = Map<string, { manifest: DchubManifest; used: Set<string>; dirty: boolean }>;

/** Reads (or initializes) the manifest state for a package dir, caching it in `manifests`
 * for the rest of the run. Shared by `exportAssetsToSupabase` and `resolveCdnIdentity` so
 * both agree on the exact same child_id assignments — whichever runs first persists them
 * to the `.dchub.json` manifest on disk, and the other reads that back via the byName fast
 * path in `resolveChildId`, rather than resolving independently. */
export async function getManifestState(manifests: ManifestStates, packageDir: string, stableId: string) {
  let state = manifests.get(packageDir);
  if (!state) {
    const existing = await readManifest(packageDir);
    const manifest  = existing ?? { stable_id: stableId, children: {}, updated_at: '' };
    state = { manifest, used: new Set(Object.values(manifest.children).map(c => c.child_id)), dirty: false };
    manifests.set(packageDir, state);
  }
  return state;
}

/**
 * The map key for a per-STEM lookup — one thumbnail is shared by every extension variant of
 * a stem (`foo.pdf` and `foo.png` show the same `foo-thumb.webp`).
 *
 * Scoped to the file's directory, never the bare stem: display names repeat freely across
 * packages (two packages can each hold a `plyn.pdf`), and a bare-stem key lets the second
 * entry overwrite the first — after which BOTH files resolve to the second's identity. See
 * the note at the top of @dc-hub/domain assetGrouping, which fixed that for grouping; this map
 * had the same defect (F-5).
 */
