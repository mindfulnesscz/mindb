/* Draft asset creation — the Vocabulary 'create folder' flow.
 *
 * Writes a placeholder row so a freshly scaffolded folder has a DB identity before any file
 * exists. The extensionless placeholder it reserves is what resolveChildId's scaffold-adoption
 * branch later hands to the real file.
 */

import type { SupabaseConfig } from './rest';
import { makeHeaders, sbFetch } from './rest';

/* ── Asset creation flow (Task 6) ────────────────────────────────────────── */

export interface DraftAssetInput {
  clientId:        string;
  stableId:        string;
  name:            string;
  entities:        string[];
  angles:          string[];
  formats:         string[];
  tags:            string[];
  primaryEntityId: string | null;
  primaryAngleId:  string | null;
  primaryFormatId: string | null;
}

/** Looks up a tag's Supabase row id by its rendered label — primary_*_id columns are
 * uuid FKs into `tags`, not the vocabulary's own shortcode string. Requires that client's
 * vocabulary has already been synced at least once (syncTagsFromVocabulary); returns null
 * (not an error) if the tag isn't in Supabase yet, since the FK columns are nullable. */
export async function resolveTagId(
  clientId:  string,
  dimension: 'entity' | 'angle' | 'format',
  label:     string,
  config:    SupabaseConfig,
): Promise<string | null> {
  const base    = `${config.url}/rest/v1`;
  const headers = await makeHeaders(config.anonKey);
  try {
    const res = await sbFetch(
      `${base}/tags?client_id=eq.${clientId}&dimension=eq.${dimension}&name=eq.${encodeURIComponent(label)}&select=id&limit=1`,
      { headers },
    );
    if (!res.ok) return null;
    const rows = await res.json<Array<{ id: string }>>();
    return rows[0]?.id ?? null;
  } catch { return null; }
}

/** Inserts a `draft` status row for a freshly scaffolded asset folder — child_id is always
 * 'c1' since a brand-new asset has no variants yet. Throws with the actual Supabase error
 * text on failure rather than swallowing it — the caller already surfaces exceptions. */
export async function createDraftAsset(input: DraftAssetInput, config: SupabaseConfig): Promise<string> {
  const base    = `${config.url}/rest/v1`;
  const headers = await makeHeaders(config.anonKey);
  const shortcode = input.name;
  const res = await sbFetch(`${base}/assets`, {
    method:  'POST',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify({
      client_id: input.clientId, stable_id: input.stableId, child_id: 'c1',
      shortcode, name: input.name,
      entities: input.entities, angles: input.angles, formats: input.formats, tags: input.tags,
      status: 'draft', perm: 'internal',
      primary_entity_id: input.primaryEntityId,
      primary_angle_id:  input.primaryAngleId,
      primary_format_id: input.primaryFormatId,
    }),
  });
  if (!res.ok) throw new Error(`Supabase insert failed: ${await res.text()}`);
  const created = await res.json<Array<{ id: string }>>();
  if (!created[0]?.id) throw new Error('Supabase insert returned no row.');
  return created[0].id;
}

