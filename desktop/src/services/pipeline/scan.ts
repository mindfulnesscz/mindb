/* Source scanning — the one pass every later stage reads from.
 *
 * scanAllAssets walks the source tree once at the start of a run; thumbnails, CDN upload and the
 * Supabase sync all consume that single list. A file created after the scan is not seen this run.
 * 
 * The walk is concurrent (Promise.all over sibling dirs), so result ORDER IS NOT DETERMINISTIC.
 * Callers must not depend on it — compare sets, not arrays.
 * 
 * scanVersionMap is separate: it reads the versions/ subtree that the main scan deliberately
 * skips, to build version history for the portal.
 */

import { join } from '@tauri-apps/api/path';
import type { AppSettings } from '../../store/settingsStore';
import {
  type VocabularyData, buildVocabMap, parseFilename, extractStableId, isPreviewArtifact,
} from '@sotto/domain';
import { shouldSkip, isPackageFolder, isOutFolder, isPublishableFile } from './naming';
import { listDir, listDirResult } from './fs';
import type { VersionEntry, AssetVersions } from './types';

export async function scanAllAssets(
  root: string,
  s: AppSettings,
  onReadError?: (path: string, error: unknown) => void,
): Promise<string[]> {
  const results: string[] = [];

  async function walkForOut(dir: string) {
    const read = await listDirResult(dir);
    if (read.error) onReadError?.(dir, read.error);
    const entries = read.entries;
    const hasOut  = entries.some(e => e.isDirectory && isOutFolder(e.name, s));
    const dirs    = entries.filter(e => e.isDirectory && !shouldSkip(e.name, s) && !isPackageFolder(e.name, s));
    await Promise.all(dirs.map(async e => {
      const childPath = await join(dir, e.name);
      if (isOutFolder(e.name, s)) {
        await collectInOut(childPath);
      } else if (!hasOut) {
        await walkForOut(childPath);
      }
    }));
  }

  async function collectInOut(dir: string) {
    const read = await listDirResult(dir);
    if (read.error) onReadError?.(dir, read.error);
    const entries = read.entries;
    await Promise.all(entries.map(async e => {
      if (e.name.startsWith('.') || shouldSkip(e.name, s) || isPreviewArtifact(e.name)) return;
      if (e.isDirectory && e.name.toLowerCase() === 'versions') return; // versions/ handled separately in VH sync
      const childPath = await join(dir, e.name);
      if (e.isFile && isPublishableFile(e.name)) {
        results.push(childPath);
      } else if (e.isDirectory) {
        await collectInOut(childPath);
      }
    }));
  }

  await walkForOut(root);
  return results;
}


/* ── Version history scan ───────────────────────────────────────────────── */

function stripVersionSuffix(stem: string): string {
  return stem.replace(/\s+[vV]\d+(?:[-._]\d+)*\s*$/, '').trim();
}

function versionGt(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/i, '').split(/[._-]/).map(n => parseInt(n, 10) || 0);
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0, nb = pb[i] ?? 0;
    if (na !== nb) return na > nb;
  }
  return false;
}


export async function scanVersionMap(
  root:     string,
  vocab:    VocabularyData,
  settings: AppSettings,
): Promise<Map<string, AssetVersions>> {
  // Keyed `${stableId}:${shortcode}`, not by shortcode alone: display text repeats freely
  // across packages (and shortcode carries no identity), so a bare-shortcode key silently
  // merged two unrelated assets' version histories into whichever one was scanned last.
  const vmap     = new Map<string, AssetVersions>();
  const vocabCtx = buildVocabMap(vocab);

  /** stable_id of the package folder (OUT's parent) this file sits under, if any. */
  function stableIdFor(file: string): string | null {
    const parts = file.replace(/\\/g, '/').split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
      if (isOutFolder(parts[i], settings)) return extractStableId(parts[i - 1] ?? '');
    }
    return null;
  }

  function addEntry(file: string, name: string, isHistory: boolean) {
    if (!isPublishableFile(name) || isPreviewArtifact(name)) return;
    const stableId = stableIdFor(file);
    if (!stableId) return; // no folder identity — nothing in the DB to attach history to
    const dot       = name.lastIndexOf('.');
    const stem      = dot > 0 ? name.slice(0, dot) : name;
    const parsed    = parseFilename(stem, vocabCtx);
    const version   = parsed.version ?? '';
    const shortcode = stripVersionSuffix(stem);
    const key       = `${stableId}:${shortcode}`;
    const entry: VersionEntry = { file, stem, version, shortcode };
    const av = vmap.get(key) ?? { shortcode, current: null, history: [] };
    if (isHistory) {
      av.history.push(entry);
    } else {
      if (!av.current) {
        av.current = entry;
      } else if (versionGt(version, av.current.version)) {
        av.history.push(av.current);
        av.current = entry;
      } else {
        av.history.push(entry);
      }
    }
    vmap.set(key, av);
  }

  async function walkForVH(dir: string) {
    const entries = await listDir(dir);
    const hasOut  = entries.some(e => e.isDirectory && isOutFolder(e.name, settings));
    await Promise.all(
      entries
        .filter(e => e.isDirectory && !shouldSkip(e.name, settings) && !isPackageFolder(e.name, settings))
        .map(async e => {
          const childPath = await join(dir, e.name);
          if (isOutFolder(e.name, settings)) {
            await collectFromDir(childPath, false);
            const versPath = await join(childPath, 'versions');
            await collectFromDir(versPath, true).catch(() => {}); // OK if absent
          } else if (!hasOut) {
            await walkForVH(childPath);
          }
        })
    );
  }

  async function collectFromDir(dir: string, isHistory: boolean) {
    const entries = await listDir(dir);
    await Promise.all(entries.map(async e => {
      if (e.name.startsWith('.') || shouldSkip(e.name, settings) || isPreviewArtifact(e.name)) return;
      const childPath = await join(dir, e.name);
      if (e.isFile) {
        addEntry(childPath, e.name, isHistory);
      } else if (e.isDirectory && e.name.toLowerCase() !== 'versions') {
        await collectFromDir(childPath, isHistory);
      }
    }));
  }

  await walkForVH(root);
  return vmap;
}



