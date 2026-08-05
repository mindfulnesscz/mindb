/* Filesystem helpers, and the settings-shaped naming adapters.
 *
 * `isUnchanged` compares SIZE only, unlike the pipeline's mtime comparison: a file copied into the
 * vault gets a fresh mtime, so mtime would report every attachment as changed on every run.
 */

import {
  readDir, stat,
} from '@tauri-apps/plugin-fs';
import type { DirEntry } from '@tauri-apps/plugin-fs';
import type { AppSettings } from '../../store/settingsStore';
import {
  isOutFolder as namingIsOutFolder, isPackageFolder as namingIsPackageFolder,
} from '@dc-hub/domain';

export async function listDir(path: string): Promise<DirEntry[]> {
  try { return await readDir(path); } catch { return []; }
}

export function shouldSkip(name: string, s: AppSettings): boolean {
  if (name.startsWith('~$') || name.includes('[99]')) return true;
  return s.excludeMark ? name.includes(s.excludeMark) : false;
}

export function isOutFolder(name: string, s: AppSettings): boolean {
  return namingIsOutFolder(name, {
    packagePrefix: s.packagePrefix,
    outFolder:     s.outFolder,
    excludeMark:   s.excludeMark,
  });
}

export function isPackageFolder(name: string, s: AppSettings): boolean {
  return namingIsPackageFolder(name, {
    packagePrefix: s.packagePrefix,
    outFolder:     s.outFolder,
    excludeMark:   s.excludeMark,
  });
}

export async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

export async function isUnchanged(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    return sa.size === sb.size;
  } catch { return false; }
}
