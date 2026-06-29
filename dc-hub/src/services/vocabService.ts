import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import type { VocabularyData } from '../domain/vocabulary';

/* We store vocabulary.json in the app's data directory.
   On first run, seed it from the bundled resource. */

let _vocabPath: string | null = null;

async function getVocabPath(): Promise<string> {
  if (_vocabPath) return _vocabPath;
  const dir = await appDataDir();
  _vocabPath = await join(dir, 'vocabulary.json');
  return _vocabPath;
}

/* Bundled seed data — the vocabulary from the Python POC is embedded here
   so the app works without an external file on first launch. */
async function getSeedVocabPath(): Promise<string> {
  /* In development, the vocab file is next to the repo root.
     In production it's bundled as a resource. We try both. */
  try {
    const { resolveResource } = await import('@tauri-apps/api/path');
    return await resolveResource('resources/vocabulary.json');
  } catch {
    /* Dev fallback — relative to app executable */
    return 'vocabulary.json';
  }
}

export async function loadVocabulary(): Promise<VocabularyData> {
  const path = await getVocabPath();

  /* Check if user's data copy exists */
  let fileExists = false;
  try { fileExists = await exists(path); } catch { fileExists = false; }

  if (!fileExists) {
    /* First run: try to read bundled seed */
    const seed = await loadSeedVocabulary();
    await saveVocabulary(seed);
    return seed;
  }

  const text = await readTextFile(path);
  return JSON.parse(text) as VocabularyData;
}

export async function saveVocabulary(data: VocabularyData): Promise<void> {
  const path = await getVocabPath();
  await writeTextFile(path, JSON.stringify(data, null, 2));
}

async function loadSeedVocabulary(): Promise<VocabularyData> {
  /* Try bundled resource path first */
  try {
    const seedPath = await getSeedVocabPath();
    const text = await readTextFile(seedPath);
    return JSON.parse(text) as VocabularyData;
  } catch {
    /* If resource loading fails, return an empty vocabulary */
    return {
      _schema_version: '2.1.0',
      _comment: 'DC Hub vocabulary',
      tags: [],
    };
  }
}
