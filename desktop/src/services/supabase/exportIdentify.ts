/* Stage 1 — resolve folder identity, and refuse to guess.
 *
 * Every asset lives in a package folder carrying a ` __<hash>` suffix written by the Vocabulary
 * scaffold. Anything without one has no permanent key to sync by, so it is REPORTED rather than
 * guessed at — a guessed key orphans the row on the first rename.
 * 
 * The duplicate-hash guard is the other half: the same hash claimed by two folders means a
 * duplicated folder or a moved asset, and writing either would corrupt the other's row. Both
 * are skipped for the run.
 */

import { extractStableId, type GalleryGroup, type SingleAsset } from '@sotto/domain';

export interface IdentifiedAssets {
  stableSingles: Array<SingleAsset & { stableId: string }>;
  stableGalleries: Array<{ group: GalleryGroup; packageDir: string; stableId: string }>;
  /** Names with no identity — the caller reports these and counts them as errors. */
  unhashed: string[];
  /** Hashes claimed by more than one folder; everything using them is skipped. */
  conflicted: Set<string>;
}

export function identifyAssets(
  singles: SingleAsset[],
  galleries: GalleryGroup[],
): IdentifiedAssets {
  const stableSingles: IdentifiedAssets['stableSingles'] = [];
  const stableGalleries: IdentifiedAssets['stableGalleries'] = [];
  const unhashed: string[] = [];

  const hashOwners = new Map<string, Set<string>>(); // stableId → package dirs claiming it
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
  for (const group of galleries) {
    const sid = extractStableId(group.packageDir.split('/').pop() ?? '');
    if (sid) { stableGalleries.push({ group, packageDir: group.packageDir, stableId: sid }); claim(sid, group.packageDir); }
    else unhashed.push(group.name);
  }

  const conflicted = new Set([...hashOwners].filter(([, dirs]) => dirs.size > 1).map(([sid]) => sid));

  return {
    stableSingles: stableSingles.filter(s => !conflicted.has(s.stableId)),
    stableGalleries: stableGalleries.filter(g => !conflicted.has(g.stableId)),
    unhashed,
    conflicted,
  };
}
