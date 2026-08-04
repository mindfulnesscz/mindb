/* Stage 2 — turn identified assets into the rows to write.
 *
 * This is where the product's two grouping rules live, and they are NOT interchangeable:
 *
 *   VARIANTS  — several files sitting directly in OUT are one deliverable in different renditions
 *               (format or background options). They get `variant_of` → the portal shows a picker.
 *   GALLERIES — a folder under OUT holds many related-but-distinct files (60 event photos). They
 *               get `parent_id` → the portal shows a grid.
 *
 * Conflating them once made the portal render a 60-chip picker for a photo grid.
 *
 * Two collapses happen before anything is written:
 *   - files differing only by trailing version are ONE asset's history, so only the highest
 *     becomes a row (older ones are tracked by syncVersionHistory);
 *   - extension pairs of one stem (foo.pdf + foo.png) repeat a stem, and resolving it twice used
 *     to stamp variant_of onto the primary's own row, hiding the group.
 *
 * Reads and writes `.dchub.json` manifests, so this stage touches the filesystem.
 */

import { stripStableId, filterHighestVersions, type VocabularyData } from '@sotto/domain';
import type { CloudUrlEntry } from '../pipeline/types';
import { parseAssetForSupabase, unionStrings, intersectStrings } from './rowMapping';
import {
  type ManifestStates, getManifestState, resolveChildId, resolveGalleryParentChildId,
  writeManifest,
} from './manifest';
import type { ExportPlan, ChildWrite, ParentWrite, ReadmeTarget, StableRow } from './exportTypes';
import type { IdentifiedAssets } from './exportIdentify';

/**
 * Access level for a row the pipeline CREATES. Deliberately not `public`.
 *
 * Until 2026-07-31 every export path hardcoded `perm: 'public'`, overriding the column's own
 * `client` default on every write — so the whole library was discoverable by anonymous portal
 * visitors, regardless of intent. `client` means "the client this asset belongs to, plus staff";
 * anything genuinely world-readable is promoted deliberately in the portal.
 *
 * This is a CREATE-time default only. `perm` is portal-owned once the row exists — see
 * stripPortalOwnedFields in ./exportWrite, without which a pipeline run would drag an editor's
 * deliberate promotion back down (and, once level is encoded in the R2 object key, move the
 * bytes with it).
 */
export const PIPELINE_DEFAULT_PERM = 'client';

/** Lifecycle state for a row the pipeline creates. Also create-time only, same reasoning. */
export const PIPELINE_DEFAULT_STATUS = 'published';

export interface PlanInput {
  identified: IdentifiedAssets;
  clientId: string;
  vocab: VocabularyData;
  existingByStableId: Map<string, StableRow[]>;
  cdnUrls?: Map<string, string>;
  pageCounts?: Map<string, { total: number; rendered: number }>;
  originalUrls?: Map<string, string>;
  cloudUrls?: Map<string, CloudUrlEntry[]>;
  appendLog: (type: string, msg: string) => void;
}

export async function planExport(input: PlanInput): Promise<ExportPlan> {
  const {
    identified: { stableSingles, stableGalleries },
    clientId, vocab, existingByStableId, cdnUrls, originalUrls, cloudUrls, pageCounts, appendLog,
  } = input;

  // `stem` drives taxonomy parsing (display text); `absPath` keys the CDN URL maps, which must
  // never be looked up by name — two packages can hold the same filename and the second would
  // otherwise claim the first's URLs (F-5).
  function buildRecord(stem: string, absPath: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
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
      status:        PIPELINE_DEFAULT_STATUS,
      perm:          PIPELINE_DEFAULT_PERM,
      thumbnail_url: cdnUrls?.get(absPath) ?? null,
      download_url:  originalUrls?.get(absPath) ?? null,
      /* Page-preview counts for documents. Null for everything else, and stripped before an UPDATE
         (see stripAbsentUrls) so a run with thumbnails disabled cannot blank a count the portal is
         already rendering from. */
      preview_page_count: pageCounts?.get(absPath)?.rendered ?? null,
      preview_page_total: pageCounts?.get(absPath)?.total ?? null,
      // cloudUrls carries its own composite destId:stem key — see runCloudExport.
      download_urls: cloudUrls?.get(stem) ?? [],
      ...extra,
    };
  }

  const manifests: ManifestStates = new Map();
  const manifestState = (packageDir: string, stableId: string) => getManifestState(manifests, packageDir, stableId);

  const currentStableKeys = new Set<string>();
  const parentWrites: ParentWrite[] = [];
  const childWrites: ChildWrite[] = [];
  const readmeTargets: ReadmeTarget[] = [];

  // Multiple singles can share one package dir (a set of format variants with no gallery
  // subfolder) — they are variants of one logical asset, not separate assets. Group by dir first
  // so the primary (child_id 'c1') can be singled out before choosing each write path.
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
        const record = buildRecord(stem, absPath, { stable_id: stableId, child_id: resolved.childId });
        currentStableKeys.add(key);
        resolvedItems.push({ stem, childId: resolved.childId, record });
      }

      const primary = resolvedItems.find(i => i.childId === 'c1') ?? resolvedItems[0];
      const primaryKey = `${stableId}:${primary.childId}`;

      /* A NEW rendition joining an EXISTING set takes that set's level, not the create-time
         default. Without this, adding a print variant to an asset an editor had promoted to
         `public` would insert it at `client` — a set whose members disagree, which reads in the
         portal as a variant picker that half-works. Existing rows are unaffected either way:
         stripPortalOwnedFields drops `perm` from every PATCH.

         Gallery children need no equivalent here — a database trigger forces them to their
         parent's level whatever this stage sends (20260731130000). */
      const existingPrimaryPerm = (existingByStableId.get(stableId) ?? [])
        .find(row => `${row.stable_id}:${row.child_id}` === primaryKey)?.perm;
      if (existingPrimaryPerm) {
        for (const item of resolvedItems) item.record.perm = existingPrimaryPerm;
      }

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
      readmeTargets.push({
        packageDir, stableId, stem: primary.stem,
        perm:   primary.record.perm   as string,
        status: primary.record.status as string,
      });
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

      const firstChild             = group.children[0] ?? null;
      const firstChildThumb        = firstChild ? (cdnUrls?.get(firstChild.absPath) ?? null) : null;
      const firstChildOriginalUrl  = firstChild ? (originalUrls?.get(firstChild.absPath) ?? null) : null;
      const firstChildCloudUrls    = firstChild ? (cloudUrls?.get(firstChild.stem) ?? []) : [];
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
      const galleryParentRecord = {
        client_id: clientId, stable_id: stableId, child_id: parentChildId,
        shortcode: pp.shortcode || pkg?.shortcode || leafFolder,
        name: displayName,
        entities: uniq([...(pkg?.entities ?? []), ...pp.entities]),
        formats:  uniq([...(pkg?.formats ?? []),  ...pp.formats]),
        angles:   uniq([...(pkg?.angles ?? []),   ...pp.angles]),
        tags:     uniq([...(pkg?.tags ?? []),     ...pp.tags]),
        version: pp.version || pkg?.version || '1-0-0',
        status: PIPELINE_DEFAULT_STATUS, perm: PIPELINE_DEFAULT_PERM,
        thumbnail_url: firstChildThumb,
        download_url: firstChildOriginalUrl, download_urls: firstChildCloudUrls,
      };
      readmeTargets.push({
        packageDir, stableId, stem: group.name,
        perm: galleryParentRecord.perm, status: galleryParentRecord.status,
      });
      parentWrites.push({ key: parentKey, record: galleryParentRecord });

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
            status: PIPELINE_DEFAULT_STATUS, perm: PIPELINE_DEFAULT_PERM,
            thumbnail_url: cdnUrls?.get(absPath) ?? null,
            download_url: originalUrls?.get(absPath) ?? null,
            download_urls: cloudUrls?.get(fileStem) ?? [],
          },
        });
      }
      }
    }


  // Persist manifest changes (new/renamed children) before anything touches the DB, so a failed
  // write never loses an id the next run would re-mint differently.
  for (const [dir, state] of manifests) {
    if (!state.dirty) continue;
    try { await writeManifest(dir, state.manifest); }
    catch (e) { appendLog('error', `  ✕  Manifest write failed for "${dir}": ${e}`); }
  }

  return { parentWrites, childWrites, readmeTargets, currentStableKeys };
}
