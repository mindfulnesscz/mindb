/* Filesystem helpers shared by every stage.
 *
 * listDir swallows read errors on purpose: a permission-denied or vanished directory must not
 * abort a whole run. listDirResult preserves the error for destructive walks that must distinguish
 * an empty directory from an unreadable one.
 * 
 * isUnchanged is the copy/skip decision for every stage. It compares mtimes and treats a missing
 * destination as "changed", so a failed read always errs toward copying rather than skipping.
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
    /* Before the file/directory branch, so it covers the `<stem>-thumb/` previews FOLDER and not
       just the `-thumb.webp` sidecar. Checking only files here let the walk descend into a previews
       folder and collect `001.webp` as a publishable asset — page names deliberately carry no
       `-thumb`, so nothing downstream would have caught it. */
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

/* ── Unchanged check (mtime — dest missing/older → copy, dest newer-or-same → skip) ── */

export async function isUnchanged(src: string, dest: string): Promise<boolean> {
  try {
    const [ss, ds] = await Promise.all([stat(src), stat(dest)]);
    if (ss.mtime && ds.mtime) return ds.mtime.getTime() >= ss.mtime.getTime();
    return ss.size === ds.size; // mtime unavailable on this filesystem — fall back to size
  } catch { return false; } // dest missing (or unreadable) — not unchanged, copy it
}
