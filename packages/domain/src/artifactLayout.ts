/* Where render artifacts live — the one rule, in the one place.
 *
 *   > A `thumbnails/` folder sits BESIDE the files it serves — never nested per asset, never
 *   > named per asset.
 *
 * So it lands in `OUT/` for the files directly under OUT, and inside the gallery folder for
 * gallery children — the same split `groupAssets` makes. Inside it:
 *
 *   <stem>-thumb.webp          the thumbnail (for a document, its title page)
 *   .<stem>-thumb.webp.json    that thumbnail's render cache — hidden, written by render.rs
 *   <stem>/                    a document's per-page previews: 001.webp, 002.webp, .pages.json
 *
 * LOCATION is what makes something an artifact, not its name. `isPreviewArtifact` excludes the
 * folder as a UNIT, so everything under it is excluded without needing a naming convention of its
 * own — which is what finally covers the page files, whose names (`001.webp`) deliberately carry no
 * marker at all. The `-thumb` suffix survives in the filenames only as a safety net for libraries
 * still in the pre-3.2.2 layout; dropping it is a separate, later decision.
 *
 * There is NO special case for a package holding one asset. It gets a `thumbnails/` folder too. A
 * rule with exceptions is exactly what made the previous convention impossible to change safely
 * across its ~8 call sites.
 *
 * Platform-free by contract: string helpers over POSIX-style paths. The caller owns the filesystem.
 */

/** The folder holding every render artifact that serves the assets beside it. */
export const THUMBNAILS_DIR = 'thumbnails';

/** Per-page previews record their render inputs here. Hidden — it is a cache, not metadata. */
export const PAGES_MANIFEST = '.pages.json';

/** What the same file was called before 3.2.2. Still on disk in an unmigrated library. */
export const LEGACY_PAGES_MANIFEST = 'pages.json';

const THUMB_SUFFIX = '-thumb';
const THUMB_EXT = '.webp';
const THUMB_CACHE_EXT = '.json';

function withoutTrailingSlash(dir: string): string {
  return dir.replace(/\/+$/, '');
}

/**
 * A generated render artifact sitting beside an asset.
 *
 * Apply this to EVERY directory entry a walker sees, before branching on file-vs-directory: the
 * `thumbnails/` folder has to be refused as a unit, or the walk descends into it and collects
 * `001.webp` as a publishable asset. That is not hypothetical — the page names carry no marker, so
 * nothing downstream catches them, and they would be published as assets, synced to the DAM and
 * given thumbnails of their own.
 *
 * The `-thumb` substring test is the LEGACY half: it keeps an unmigrated library's loose sidecars
 * and `<stem>-thumb/` previews folders excluded until the migration moves them. Location is the
 * rule; the substring is the safety net.
 */
export function isPreviewArtifact(name: string): boolean {
  return name === THUMBNAILS_DIR || name.includes(THUMB_SUFFIX);
}

/**
 * The same question asked of a relative PATH rather than one directory entry.
 *
 * An export boundary holds a path, not a walk position — and the artifact is usually a segment in
 * the middle of it (`Selected/thumbnails/Deck v2/001.webp`), never the filename. Testing the leaf
 * alone is how a page preview reaches a client's folder.
 */
export function isArtifactPath(relPath: string): boolean {
  return relPath.split('/').filter(Boolean).some(isPreviewArtifact);
}

/** `<stem>-thumb.webp` — the sidecar's name, which the move deliberately does not change. */
export function thumbName(stem: string): string {
  return `${stem}${THUMB_SUFFIX}${THUMB_EXT}`;
}

/** The artifacts folder serving the assets in `assetDir`. */
export function artifactDir(assetDir: string): string {
  return `${withoutTrailingSlash(assetDir)}/${THUMBNAILS_DIR}`;
}

/** Where the thumbnail for `<assetDir>/<stem>.<ext>` belongs. */
export function thumbPathFor(assetDir: string, stem: string): string {
  return `${artifactDir(assetDir)}/${thumbName(stem)}`;
}

/** Where the per-page previews for `<assetDir>/<stem>.<ext>` belong. */
export function pagesDirFor(assetDir: string, stem: string): string {
  return `${artifactDir(assetDir)}/${stem}`;
}

/** The previews manifest inside a page-previews folder. */
export function pagesManifestPath(pagesDir: string): string {
  return `${withoutTrailingSlash(pagesDir)}/${PAGES_MANIFEST}`;
}

/* ── Migrating a pre-3.2.2 library ──────────────────────────────────────── */

export interface LegacyArtifactMove {
  /** The entry's name as it sits in the asset folder today. */
  from: string;
  /** Where it belongs, relative to that same asset folder. */
  to: string;
  kind: 'thumbnail' | 'thumbnail-cache' | 'pages';
}

/**
 * Classify one directory entry of an asset folder as an artifact left by the old layout.
 *
 * Deliberately shape-matched rather than cross-checked against a sibling source file: an artifact
 * whose source has since been renamed still belongs in `thumbnails/`, and leaving it loose is what
 * a client would see. `null` means "not an artifact" — the caller must move nothing.
 */
export function legacyArtifactMove(name: string, isDirectory: boolean): LegacyArtifactMove | null {
  if (name === THUMBNAILS_DIR) return null;

  if (isDirectory) {
    if (!name.endsWith(THUMB_SUFFIX)) return null;
    // `Deck v2-thumb/` → `thumbnails/Deck v2/`. The suffix was only ever there to make the folder
    // inherit the `-thumb` exclusion; inside `thumbnails/` it has nothing left to do.
    const stem = name.slice(0, -THUMB_SUFFIX.length);
    return { from: name, to: `${THUMBNAILS_DIR}/${stem}`, kind: 'pages' };
  }

  // Order matters: the cache ends `-thumb.webp.json`, so it must be tested before the thumbnail.
  if (name.endsWith(`${THUMB_SUFFIX}${THUMB_EXT}${THUMB_CACHE_EXT}`)) {
    const visible = name.startsWith('.') ? name.slice(1) : name;
    return { from: name, to: `${THUMBNAILS_DIR}/.${visible}`, kind: 'thumbnail-cache' };
  }
  if (name.endsWith(`${THUMB_SUFFIX}${THUMB_EXT}`)) {
    return { from: name, to: `${THUMBNAILS_DIR}/${name}`, kind: 'thumbnail' };
  }
  return null;
}
