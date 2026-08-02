/* Walking the source tree for the OUT folders worth a note.
 *
 * A GALLERY folder becomes ONE note with a contact sheet rather than a note per image — a 60-photo
 * shoot would otherwise bury every other asset in the vault.
 */

import {
  readDir,
} from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import type { AppSettings } from '../../store/settingsStore';
import {
  parseFilename, isVideoFile, type VocabMap,
} from '@dc-hub/domain';
import {
  relativeTo, pathParts, isPublishable,
} from './paths';
import {
  listDir, shouldSkip, isOutFolder, isPackageFolder,
} from './fs';
import {
  isInsideVault, scopeFor,
} from './scope';

export const IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.webp','.gif','.tif','.tiff','.bmp']);

/* A folder is a gallery when it holds displayable media. Video counts — a folder of cuts is as much
   a gallery as a folder of stills, and before this it got no vault note at all.
 *
 * Video is tested separately rather than being added to IMAGE_EXTS, which is used elsewhere as
 * literally "is this an image" and would start quietly lying. */
export async function isGalleryFolder(path: string, vocab: VocabMap): Promise<boolean> {
  try {
    const parsed = parseFilename(path.split('/').pop()!, vocab);
    if (parsed.error) return false;
    const entries = await readDir(path);
    return entries.some(e => {
      if (!e.isFile || e.name.startsWith('.')) return false;
      const ext = '.' + (e.name.split('.').pop() || '').toLowerCase();
      return IMAGE_EXTS.has(ext) || isVideoFile(e.name);
    });
  } catch { return false; }
}

export interface OutDirInfo {
  outPath:    string;
  isOrphan:   boolean;
  noteBase:   string;
  projRel:    string;
  clusterKey: string[];
  sortKey:    string[];
}

export async function collectOutDirInfos(
  source: string,
  damRoot: string,
  anchors: string[],
  s: AppSettings,
): Promise<OutDirInfo[]> {
  const results: OutDirInfo[] = [];

  async function walk(dir: string) {
    const name = dir.split('/').pop() ?? '';
    if (shouldSkip(name, s) || isPackageFolder(name, s) || isInsideVault(dir, s)) return;
    const entries = await listDir(dir);
    const outEntry = entries.find(e => e.isDirectory && isOutFolder(e.name, s));
    if (outEntry) {
      const outPath  = await join(dir, outEntry.name);
      const scope    = scopeFor(dir, anchors);
      const noteBase = scope ? await join(damRoot, scope.split('/').pop()!) : damRoot;
      const projRel  = scope ? relativeTo(dir, scope) : relativeTo(dir, source);
      const parts    = pathParts(projRel);
      const n        = parts.length;
      results.push({
        outPath, isOrphan: false, noteBase, projRel,
        clusterKey: parts.slice(0, Math.min(Math.max(n - 1, 0), 2)),
        sortKey:    parts,
      });
      return; // don't descend into siblings
    }
    const hasFiles = entries.some(e =>
      e.isFile && isPublishable(e.name) && !e.name.includes('-thumb') && !shouldSkip(e.name, s)
    );
    if (hasFiles) {
      const scope    = scopeFor(dir, anchors);
      const noteBase = scope ? await join(damRoot, scope.split('/').pop()!) : damRoot;
      const projRel  = scope ? relativeTo(dir, scope) : relativeTo(dir, source);
      const parts    = pathParts(projRel);
      const n        = parts.length;
      results.push({
        outPath: dir, isOrphan: true, noteBase, projRel,
        clusterKey: parts.slice(0, Math.min(Math.max(n - 1, 0), 2)),
        sortKey:    parts,
      });
    }
    for (const e of entries) {
      if (e.isDirectory && !shouldSkip(e.name, s) && !isPackageFolder(e.name, s)) {
        await walk(await join(dir, e.name));
      }
    }
  }

  for (const e of await listDir(source)) {
    if (e.isDirectory && !shouldSkip(e.name, s)) {
      await walk(await join(source, e.name));
    }
  }
  return results;
}
