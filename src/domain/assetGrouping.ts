/* Groups scanned OUT-folder file paths into single assets vs. gallery groups (files
   nested one level under OUT share a parent folder and form one logical asset).

   Also resolves each group's "package dir" — the OUT folder's parent, which is where a
   folder-based stable identity hash (see domain/stableId.ts) lives once assigned. Assets
   with no OUT ancestor at all (legacy/orphan layout) fall back to their direct parent. */

export interface GalleryGroup {
  name:       string    // folder name — parsed for metadata (entity/format/angle/tags)
  childStems: string[]  // file stems inside the folder
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

export function groupAssets(
  paths: string[],
  outFolderName: string,
): GroupedAssets {
  const singles: string[] = [];
  const folderMap = new Map<string, string[]>(); // folderName → childStems[]
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
    const stem       = relative[relative.length - 1].replace(/\.[^.]+$/, '');
    // Package dir: OUT's parent when an OUT ancestor exists, else the file's direct parent (orphan).
    const packageDir = outIdx >= 0 ? parts.slice(0, outIdx).join('/') : parts.slice(0, -1).join('/');

    filePaths.set(stem, absPath);

    if (relative.length === 1) {
      singles.push(stem);
      packageDirs.set(stem, packageDir);
      if (outIdx < 0) orphanKeys.add(stem);
    } else {
      const folderName = relative[0]; // immediate child folder of OUT
      const existing = folderMap.get(folderName) ?? [];
      folderMap.set(folderName, [...existing, stem]);
      packageDirs.set(folderName, packageDir);
      if (outIdx < 0) orphanKeys.add(folderName);
    }
  }

  const galleries: GalleryGroup[] = [];
  for (const [name, childStems] of folderMap) {
    galleries.push({ name, childStems });
  }
  return { singles, galleries, packageDirs, filePaths, orphanKeys };
}
