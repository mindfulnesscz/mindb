import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import type { VocabularyData, VocabTag, Slot } from '../domain/vocabulary';
import { activeEnvironment } from '../store/environmentStore';
import { makeHeaders, sbFetch } from './supabase/rest';

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

function emptyVocab(comment: string): VocabularyData {
  return {
    _schema_version: '4.0.0',
    _comment: comment,
    tags: [],
    legacy_aliases: {},
  };
}

/** Migrate legacy local-cache shapes (subtype / obsidian_tag) → parentGroup / key. */
function migrateTags(tags: VocabTag[]): VocabTag[] {
  return tags.map(t => {
    const legacy = t as VocabTag & { subtype?: string; obsidian_tag?: string };
    return {
      shortcode: legacy.shortcode,
      slot: legacy.slot,
      parentGroup: legacy.parentGroup ?? (legacy.subtype ?? null),
      label: legacy.label,
      key: legacy.key || legacy.obsidian_tag || legacy.label.toLowerCase().replace(/\s+/g, '-'),
      icon: legacy.icon ?? '',
    };
  });
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

interface DbTagRow {
  id: string;
  name: string;
  key?: string | null;
  dimension: string;
  parent_id: string | null;
  shortcode: string | null;
  sort_order: number;
}

/** Map DB tags → flat vocabulary used by filenameTranslator (shortcoded leaves). */
export function tagsToVocabulary(rows: DbTagRow[]): VocabularyData {
  const byId = new Map(rows.map(r => [r.id, r]));
  const tags: VocabTag[] = [];
  const parentGroups: VocabularyData['parentGroups'] = [];

  for (const row of rows) {
    const slot = row.dimension as Slot;
    if (!['entity', 'angle', 'format'].includes(slot)) continue;

    const shortcode = (row.shortcode ?? '').trim();
    // Parent groups: top-level, no shortcode (portal-managed)
    if (!row.parent_id && !shortcode) {
      parentGroups.push({
        name: row.name,
        key: (row.key ?? '').trim() || row.name.toLowerCase().replace(/\s+/g, '-'),
        slot,
      });
      continue;
    }

    if (!shortcode) continue; // nested non-leaf nodes unused for now

    const parent = row.parent_id ? byId.get(row.parent_id) : undefined;
    const key = (row.key ?? '').trim() || row.name.toLowerCase().replace(/\s+/g, '-');

    tags.push({
      shortcode,
      slot,
      parentGroup: parent?.name ?? null,
      label: row.name,
      key,
      icon: '',
    });
  }

  tags.sort((a, b) => {
    const g = (a.parentGroup ?? '').localeCompare(b.parentGroup ?? '');
    if (g !== 0) return g;
    return a.shortcode.localeCompare(b.shortcode);
  });

  parentGroups.sort((a, b) => a.slot.localeCompare(b.slot) || a.name.localeCompare(b.name));

  return {
    _schema_version: '4.0.0',
    _comment: `Synced from public.tags (${rows.length} rows, ${parentGroups.length} groups, ${tags.length} leaves).`,
    tags,
    parentGroups,
    legacy_aliases: {},
  };
}

async function fetchTagsFromDb(clientId: string): Promise<VocabularyData | null> {
  const env = activeEnvironment();
  if (!env?.supabaseUrl || !env.anonKey) return null;

  try {
    const headers = makeHeaders(env.anonKey);
    const base =
      `${env.supabaseUrl.replace(/\/+$/, '')}/rest/v1/tags` +
      `?client_id=eq.${clientId}&order=sort_order.asc`;

    // Prefer key column; fall back if migration not applied yet.
    let res = await sbFetch(
      `${base}&select=id,name,key,dimension,parent_id,shortcode,sort_order`,
      { headers },
    );
    if (!res.ok) {
      const errText = await res.text();
      const missingKey = /column .*key.* does not exist/i.test(errText) || res.status === 400;
      if (missingKey) {
        console.warn('tags.key missing — fetching without key column');
        res = await sbFetch(
          `${base}&select=id,name,dimension,parent_id,shortcode,sort_order`,
          { headers },
        );
      }
      if (!res.ok) {
        console.warn('tags fetch failed', res.status, missingKey ? await res.text() : errText);
        return null;
      }
    }
    const rows = await res.json<DbTagRow[]>();
    return tagsToVocabulary(rows);
  } catch (e) {
    console.warn('tags fetch error', e);
    return null;
  }
}

async function readLocalCache(clientId: string | null): Promise<VocabularyData | null> {
  const path = await getVocabPath(clientId);
  const fileExists = await exists(path).catch(() => false);
  if (!fileExists) return null;
  const text = await readTextFile(path).catch(() => null);
  if (!text) return null;
  return parseSafe(text);
}

/**
 * Load vocabulary for a client.
 * - Default: fetch from DB (portal is SoT), refresh local cache.
 * - preferLocal: keep unpublished local edits (dirty cache with tags).
 * - forceFromDb: always pull portal, ignore local.
 */
export async function loadVocabulary(
  clientId: string | null,
  opts: { forceFromDb?: boolean; preferLocal?: boolean } = {},
): Promise<VocabularyData> {
  const forceFromDb = opts.forceFromDb ?? false;
  const preferLocal = opts.preferLocal ?? false;

  if (clientId && !forceFromDb) {
    const local = await readLocalCache(clientId);
    // Keep unpublished local edits across reloads / client switches.
    if (preferLocal || local?._unpublished) {
      if (local && local.tags.length > 0) return local;
    }
  }

  if (clientId) {
    const fromDb = await fetchTagsFromDb(clientId);
    if (fromDb) {
      await saveVocabularyCache({ ...fromDb, _unpublished: false }, clientId).catch(console.warn);
      return { ...fromDb, _unpublished: false };
    }
  }

  // DB unavailable — fall back to any local cache (including empty).
  const local = await readLocalCache(clientId);
  if (local) return local;

  return emptyVocab(
    clientId
      ? 'No tags yet — import taxonomy in the portal, or add tags here and Publish.'
      : 'Select a client to load taxonomy.',
  );
}

/** Local cache — Publish (syncTagsFromVocabulary) writes to public.tags. */
export async function saveVocabulary(data: VocabularyData, clientId: string | null): Promise<void> {
  return saveVocabularyCache(data, clientId);
}

async function saveVocabularyCache(data: VocabularyData, clientId: string | null): Promise<void> {
  try {
    const dir  = await appDataDir();
    const path = await getVocabPath(clientId);
    try { await mkdir(dir, { recursive: true }); } catch { /* exists */ }
    await writeTextFile(path, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('vocab cache write failed', e);
  }
}

/** @deprecated Bundled JSON is no longer the client seed — use portal taxonomy import. */
export function getSeedVocabulary(): VocabularyData {
  return emptyVocab('Deprecated — import taxonomy JSON in the portal.');
}
