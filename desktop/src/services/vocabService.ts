import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import type { VocabularyData, VocabTag, Slot, Subtype } from '../domain/vocabulary';
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
    _schema_version: '3.0.0',
    _comment: comment,
    tags: [],
    legacy_aliases: {},
  };
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

function inferSubtype(dimension: string, shortcode: string, metaSubtype?: string): Subtype {
  if (metaSubtype) return metaSubtype as Subtype;
  if (dimension === 'entity') {
    if (shortcode.startsWith('p-')) return 'product';
    if (shortcode.startsWith('c-')) return 'customer';
    if (shortcode.startsWith('x-')) return 'partner';
    if (shortcode.startsWith('e-')) return 'event';
    return 'company';
  }
  if (dimension === 'angle') return 'content';
  return 'document';
}

interface DbTagRow {
  id: string;
  name: string;
  dimension: string;
  parent_id: string | null;
  shortcode: string | null;
  sort_order: number;
  meta: Record<string, unknown> | null;
}

/** Map DB tags → flat vocabulary used by filenameTranslator (shortcoded leaves). */
export function tagsToVocabulary(rows: DbTagRow[]): VocabularyData {
  const tags: VocabTag[] = [];

  for (const row of rows) {
    const shortcode = (row.shortcode ?? '').trim();
    if (!shortcode) continue; // groups / labels without filename codes stay portal-only

    const meta = row.meta ?? {};
    const slot = row.dimension as Slot;
    if (!['entity', 'angle', 'format'].includes(slot)) continue;

    tags.push({
      shortcode,
      slot,
      subtype: inferSubtype(slot, shortcode, typeof meta.subtype === 'string' ? meta.subtype : undefined),
      label: row.name,
      obsidian_tag: typeof meta.obsidian_tag === 'string' ? meta.obsidian_tag : row.name.toLowerCase().replace(/\s+/g, '-'),
      icon: typeof meta.icon === 'string' ? meta.icon : '',
    });
  }

  tags.sort((a, b) => a.shortcode.localeCompare(b.shortcode));

  return {
    _schema_version: '3.0.0',
    _comment: `Synced from public.tags (${rows.length} rows, ${tags.length} with shortcodes). Parent groups without shortcodes are portal-only.`,
    tags,
    legacy_aliases: {},
  };
}

async function fetchTagsFromDb(clientId: string): Promise<VocabularyData | null> {
  const env = activeEnvironment();
  if (!env?.supabaseUrl || !env.anonKey) return null;

  try {
    const headers = makeHeaders(env.anonKey);
    const url =
      `${env.supabaseUrl.replace(/\/+$/, '')}/rest/v1/tags` +
      `?client_id=eq.${clientId}&select=id,name,dimension,parent_id,shortcode,sort_order,meta&order=sort_order.asc`;
    const res = await sbFetch(url, { headers });
    if (!res.ok) {
      console.warn('tags fetch failed', res.status, await res.text());
      return null;
    }
    const rows = await res.json<DbTagRow[]>();
    return tagsToVocabulary(rows);
  } catch (e) {
    console.warn('tags fetch error', e);
    return null;
  }
}

/** Prefer DB tags for the active client; fall back to local cache. No bundled seed for clients. */
export async function loadVocabulary(clientId: string | null): Promise<VocabularyData> {
  if (clientId) {
    const fromDb = await fetchTagsFromDb(clientId);
    if (fromDb) {
      await saveVocabularyCache(fromDb, clientId).catch(console.warn);
      return fromDb;
    }
  }

  const path = await getVocabPath(clientId);
  const fileExists = await exists(path).catch(() => false);
  if (fileExists) {
    const text = await readTextFile(path).catch(() => null);
    if (text) {
      const parsed = parseSafe(text);
      if (parsed) return parsed;
    }
  }

  return emptyVocab(
    clientId
      ? 'No tags in database yet — create a client with a taxonomy template (or edit tags in the portal).'
      : 'Select a client to load taxonomy from the database.',
  );
}

/** Local cache only — source of truth is public.tags in Supabase (web TagsAdmin). */
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

/** @deprecated Bundled JSON is no longer the client seed — use DB templates. */
export function getSeedVocabulary(): VocabularyData {
  return emptyVocab('Deprecated — use taxonomy templates in Supabase.');
}
