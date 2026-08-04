/* CDN identity resolution — absolute path → (stable_id, child_id).
 *
 * Runs once early in a pipeline run so the CDN stages can key objects by identity rather than by
 * filename. Keyed by ABSOLUTE PATH, plus a directory-scoped stem key for the thumbnail that several
 * extension variants of one stem legitimately share — a filename key collided across packages
 * holding the same filename and uploaded both files over one object key (F-5).
 * 
 * Touches the filesystem (manifests), so this stays desktop-side.
 */

import { extractStableId } from '@sotto/domain';
import { type ManifestStates, getManifestState, resolveChildId, writeManifest } from './manifest';

export function cdnStemKey(absPath: string): string {
  const norm = absPath.replace(/\\/g, '/');
  const dir  = norm.slice(0, norm.lastIndexOf('/') + 1);
  const file = norm.slice(dir.length);
  const dot  = file.lastIndexOf('.');
  return `${dir}${dot > 0 ? file.slice(0, dot) : file}`;
}

/** Resolves each collected asset's rename-proof stable identity (stable_id/child_id) for
 * CDN keying, without touching any Supabase record/DB logic — that stays entirely inside
 * `exportAssetsToSupabase`. Meant to run once, early, before CDN uploads, so those uploads
 * can key by this identity instead of the current filename. A file outside a hashed package
 * folder has no identity and is left out of the map; the CDN steps report those and skip
 * them rather than inventing a filename-based key.
 *
 * Keyed by ABSOLUTE PATH (plus a directory-scoped stem key for thumbnails) — never by bare
 * filename or stem, which collide across packages. */
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
    const state    = await getManifestState(manifests, packageDir, stableId);
    const resolved = await resolveChildId(state.manifest, filename, absPath, state.used);
    if (resolved.dirty) { state.manifest.children[filename] = { child_id: resolved.childId, sha256: resolved.sha256 }; state.dirty = true; }

    const identity = { stableId, childId: resolved.childId };
    // Per-file key: unique, so two packages holding the same filename keep distinct keys.
    result.set(absPath, identity);
    // Directory-scoped stem key for the shared-per-stem thumbnail. First writer wins so
    // extension variants can't flip the thumb key between runs.
    const stemKey = cdnStemKey(absPath);
    if (!result.has(stemKey)) result.set(stemKey, identity);
  }

  for (const [dir, state] of manifests) {
    if (!state.dirty) continue;
    try { await writeManifest(dir, state.manifest); } catch { /* best-effort — a later run will retry */ }
  }

  return result;
}

