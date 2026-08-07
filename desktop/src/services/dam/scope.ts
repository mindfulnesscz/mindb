/* Which folders the build covers, and where each note's cluster belongs.
 *
 * `isInsideVault` guards against self-consumption: notes are `.md` files and `isPublishable` accepts
 * them, so a vault nested inside the source folder would make each run treat the previous run's notes
 * as assets — writing notes about notes, one level deeper every time.
 */

import { joinPath } from '../pipeline/paths';
import type { AppSettings } from '../../store/settingsStore';
import {
  listDir, shouldSkip, isPackageFolder,
} from './fs';

/* A vault nested inside the source folder (e.g. source "CLIENT", vault
   "CLIENT/10 Vault") makes this step feed on its own output: notes are `.md`
   files, `isPublishable` accepts them, so the next run treats every note folder
   as an orphan OUT dir and writes notes about notes — one level deeper per run.
   Never scan the vault, whether or not it sits under the source. */
export function isInsideVault(dir: string, s: AppSettings): boolean {
  const vault = (s.vaultFolder ?? '').replace(/\/+$/, '');
  if (!vault) return false;
  const path = dir.replace(/\/+$/, '');
  return path === vault || path.startsWith(vault + '/');
}

export async function findPackageAnchors(root: string, s: AppSettings): Promise<string[]> {
  const anchors: string[] = [];
  async function walk(dir: string) {
    const name = dir.split('/').pop() ?? '';
    if (shouldSkip(name, s) || isInsideVault(dir, s)) return;
    const entries = await listDir(dir);
    if (entries.some(e => e.isDirectory && isPackageFolder(e.name, s))) {
      anchors.push(dir);
    }
    for (const e of entries) {
      if (e.isDirectory && !isPackageFolder(e.name, s) && !shouldSkip(e.name, s)) {
        await walk(joinPath(dir, e.name));
      }
    }
  }
  await walk(root);
  return anchors.sort((a, b) => a.split('/').length - b.split('/').length);
}

export function scopeFor(projDir: string, anchors: string[]): string | null {
  let best: string | null = null;
  for (const anchor of anchors) {
    const prefix = anchor.endsWith('/') ? anchor : anchor + '/';
    if (projDir.startsWith(prefix) || projDir === anchor) {
      if (!best || anchor.split('/').length < best.split('/').length) best = anchor;
    }
  }
  return best;
}
