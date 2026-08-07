/* Filesystem helpers shared by every stage.
 *
 * listDir swallows read errors on purpose: a permission-denied or vanished directory must not
 * abort a whole run. listDirResult preserves the error for destructive walks that must distinguish
 * an empty directory from an unreadable one.
 * 
 * isUnchanged is the copy/skip decision for every stage. It compares size as well as mtimes and
 * treats a missing destination as "changed", so a failed read always errs toward copying.
 * It is metadata-only BY DESIGN — see the comment on the function before adding any content read.
 */

import { readDir, stat, type DirEntry } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import type { AppSettings } from '../../store/settingsStore';
import { shouldSkip, isPackageFolder, isPublishableFile } from './naming';
import { isPreviewArtifact } from '@sotto/domain';

export async function listDir(path: string): Promise<DirEntry[]> {
  try {
    return await readDir(path);
  } catch {
    return [];
  }
}

export interface DirectoryRead {
  entries: DirEntry[];
  error: unknown | null;
}

/** A directory read that preserves the difference between "empty" and "unreadable". */
export async function listDirResult(path: string): Promise<DirectoryRead> {
  try {
    return { entries: await readDir(path), error: null };
  } catch (error) {
    return { entries: [], error };
  }
}

/* ── Collect publishable files from a directory ─────────────────────────── */

export async function collectFiles(dir: string, s: AppSettings, directOnly = false): Promise<string[]> {
  const results: string[] = [];
  const entries = await listDir(dir);
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (shouldSkip(e.name, s)) continue;
    /* Before the file/directory branch, so it covers the `thumbnails/` FOLDER and not just the
       sidecars inside it. Checking only files here let the walk descend into a previews folder and
       collect `001.webp` as a publishable asset — page names carry no marker of any kind, so
       nothing downstream would have caught it. */
    if (isPreviewArtifact(e.name)) continue;
    const childPath = await join(dir, e.name);
    if (e.isFile && isPublishableFile(e.name)) {
      results.push(childPath);
    } else if (e.isDirectory && !directOnly && !isPackageFolder(e.name, s)) {
      const sub = await collectFiles(childPath, s, false);
      results.push(...sub);
    }
  }
  return results;
}

/* ── Unchanged check (size + mtime quick check — metadata only, NEVER reads content) ── */

/**
 * Same size and a destination at least as new as the source counts as unchanged.
 *
 * This must never open either file. Source trees live in cloud storage (Dropbox via macOS File
 * Provider), where online-only files are dataless placeholders and ANY read forces a full
 * download. The byte-compare that used to sit behind the stat gate (`files_equal` in Rust) ran on
 * exactly the unchanged path — copyFile does not preserve mtime, so the destination is always
 * newer and the gate never short-circuited — which made every no-change export read the entire
 * library and pull every online-only file onto disk.
 *
 * The accepted trade-off is the restored-backup edge case: a same-size content swap whose mtime
 * went BACKWARDS now reads as unchanged. A real restore is repaired by touching the sources or
 * deleting the target copies. Characterized in pipelineCollect.characterization.test.ts.
 */
export async function isUnchanged(src: string, dest: string): Promise<boolean> {
  try {
    const [ss, ds] = await Promise.all([stat(src), stat(dest)]);
    if (ss.size !== ds.size) return false;
    if (!ss.mtime || !ds.mtime) return false; // cannot prove equality — err toward copying
    return ds.mtime.getTime() >= ss.mtime.getTime();
  } catch { return false; } // dest missing (or unreadable) — not unchanged, copy it
}
