/* Groups scanned OUT-folder file paths into single assets vs. gallery groups.

   A gallery is any nested folder under OUT that contains publishable files.
   The gallery name is the full relative path under OUT (excluding the filename),
   so `Selected/a.jpg` and `All/a.jpg` become two galleries — and so do nested
   `Galleries/Selected/…` vs `Galleries/All/…`.

   Also resolves each group's "package dir" — the OUT folder's parent, which is where a
   folder-based stable identity hash (see domain/stableId.ts) lives once assigned. Assets
   with no OUT ancestor at all (legacy/orphan layout) fall back to their direct parent. */

export interface GalleryGroup {
  name:       string    // folder path under OUT — parsed for metadata (entity/format/angle/tags)
  childStems: string[]  // unique file stems inside the folder (path-qualified when needed)
}

export interface GroupedAssets {
  singles:     string[];
  galleries:   GalleryGroup[];
  /** single stem, or gallery folder name → absolute path of its package dir (OUT's parent, or direct parent if orphaned) */
  packageDirs: Map<string, string>;
  /** any stem (single or gallery child) → absolute file path, for content-hash fallback lookups */
  filePaths:   Map<string, string>;
  /** single stems / gallery names with no OUT ancestor at all — legacy/orphan layout, packageDir is just the direct parent (may be a shared folder, not asset-specific) */
  orphanKeys:  Set<string>;
}

/** Stem key unique within a package: plain filename stem, or `folder/…/stem` when nested. */
function childStemKey(relativeDir: string, fileStem: string): string {
  return relativeDir ? `${relativeDir}/${fileStem}` : fileStem;
}

export function groupAssets(
  paths: string[],
  outFolderName: string,
): GroupedAssets {
  const singles: string[] = [];
  const folderMap = new Map<string, string[]>(); // galleryPath → childStemKeys[]
  const packageDirs = new Map<string, string>();
  const filePaths   = new Map<string, string>();
  const orphanKeys  = new Set<string>();

  for (const absPath of paths) {
    const parts = absPath.replace(/\\/g, '/').split('/');
    // Find the OUT folder segment (last match in case of nested project structures)
    let outIdx = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].toLowerCase() === outFolderName.toLowerCase()) { outIdx = i; break; }
    }
    const relative   = outIdx >= 0 ? parts.slice(outIdx + 1) : [parts[parts.length - 1]];
    const fileName   = relative[relative.length - 1];
    const stem       = fileName.replace(/\.[^.]+$/, '');
    // Package dir: OUT's parent when an OUT ancestor exists, else the file's direct parent (orphan).
    const packageDir = outIdx >= 0 ? parts.slice(0, outIdx).join('/') : parts.slice(0, -1).join('/');

    if (relative.length === 1) {
      filePaths.set(stem, absPath);
      singles.push(stem);
      packageDirs.set(stem, packageDir);
      if (outIdx < 0) orphanKeys.add(stem);
    } else {
      // Gallery = every directory segment under OUT except the file itself.
      // `Selected/a.jpg` → "Selected"; `Galleries/All/a.jpg` → "Galleries/All"
      const galleryPath = relative.slice(0, -1).join('/');
      const key = childStemKey(galleryPath, stem);
      filePaths.set(key, absPath);
      const existing = folderMap.get(galleryPath) ?? [];
      folderMap.set(galleryPath, [...existing, key]);
      packageDirs.set(galleryPath, packageDir);
      if (outIdx < 0) orphanKeys.add(galleryPath);
    }
  }

  const galleries: GalleryGroup[] = [];
  for (const [name, childStems] of folderMap) {
    galleries.push({ name, childStems });
  }
  return { singles, galleries, packageDirs, filePaths, orphanKeys };
}
