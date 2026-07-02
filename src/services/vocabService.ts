import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import type { VocabularyData, VocabTag } from '../domain/vocabulary';

import SEED_VOCAB from '../assets/vocabulary.json';

const _pathCache = new Map<string, string>();

async function getVocabPath(clientId: string | null): Promise<string> {
  const key = clientId ?? '__seed__';
  if (_pathCache.has(key)) return _pathCache.get(key)!;
  const dir = await appDataDir();
  const filename = clientId ? `vocab-${clientId}.json` : 'vocab-seed.json';
  const path = await join(dir, filename);
  _pathCache.set(key, path);
  return path;
}

function migrateTags(tags: VocabTag[]): VocabTag[] {
  return tags.map(t => t.subtype === ('image-var' as string) ? { ...t, subtype: 'asset' as VocabTag['subtype'] } : t);
}

function parseSafe(text: string): VocabularyData | null {
  try {
    const parsed = JSON.parse(text) as VocabularyData;
    if (parsed && Array.isArray(parsed.tags)) {
      parsed.tags = migrateTags(parsed.tags);
      return parsed;
    }
  } catch { /* fall through */ }
  return null;
}

export function getSeedVocabulary(): VocabularyData {
  return SEED_VOCAB as VocabularyData;
}

export async function loadVocabulary(clientId: string | null): Promise<VocabularyData> {
  const path = await getVocabPath(clientId);
  const fileExists = await exists(path).catch(() => false);

  if (fileExists) {
    const text = await readTextFile(path).catch(() => null);
    if (text) {
      const parsed = parseSafe(text);
      if (parsed) return parsed;
    }
  }

  if (!clientId) {
    /* Seed not yet written — try to migrate the old global vocabulary.json */
    const dir = await appDataDir();
    const oldPath = await join(dir, 'vocabulary.json');
    const oldExists = await exists(oldPath).catch(() => false);
    if (oldExists) {
      const text = await readTextFile(oldPath).catch(() => null);
      if (text) {
        const parsed = parseSafe(text);
        if (parsed) {
          saveVocabulary(parsed, null).catch(console.warn);
          return parsed;
        }
      }
    }
    /* No old file — write bundled seed to appDataDir so it becomes editable */
    const seed = getSeedVocabulary();
    saveVocabulary(seed, null).catch(console.warn);
    return seed;
  }

  /* Client has no vocab yet — seed it from the user's seed file */
  const seed = await loadVocabulary(null);
  saveVocabulary(seed, clientId).catch(console.warn);
  return seed;
}

export async function saveVocabulary(data: VocabularyData, clientId: string | null): Promise<void> {
  try {
    const dir  = await appDataDir();
    const path = await getVocabPath(clientId);
    await mkdir(dir, { recursive: true });
    await writeTextFile(path, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('vocabService: could not persist vocabulary:', e);
  }
}
