/* Cloud destination definitions — shared across the team via Supabase.
 *
 * Definitions are shared; OAuth TOKENS are machine-local secrets and are stripped before upload
 * (stripToken). That split is the reason this is not simply a JSON column round-trip.
 */

import type { CloudDestination } from '../../domain/client';
import { normalizeDestination, resolveExportShape } from '../../domain/client';
import type { SupabaseConfig } from './rest';
import { makeHeaders, sbFetch } from './rest';

/* ── Cloud destination definitions — shared across the team via Supabase.
   Tokens never leave the machine that holds them; only the shape (client ID,
   tenant ID, remote path, role, etc.) syncs. ──────────────────────────────── */

/** Strips the OAuth token from a destination's config before it's written to Supabase. */
export function stripToken(dest: CloudDestination): CloudDestination {
  const shape = resolveExportShape(dest);
  const base = { ...dest, exportLayout: shape.exportLayout, includePackages: shape.includePackages };
  if (base.config.type === 'local') {
    return { ...base, config: { type: 'local', path: '' } };
  }
  const config = { ...base.config, token: null };
  if (config.type === 'gdrive') config.clientSecret = '';
  return { ...base, config };
}

export async function fetchCloudDestinationDefs(
  clientId: string,
  config:   SupabaseConfig,
): Promise<CloudDestination[]> {
  const base    = `${config.url}/rest/v1`;
  const headers = await makeHeaders(config.anonKey);
  try {
    const res = await sbFetch(
      `${base}/clients?id=eq.${clientId}&select=cloud_destinations&limit=1`,
      { headers },
    );
    if (!res.ok) return [];
    const rows = await res.json() as Array<{ cloud_destinations: CloudDestination[] | null }>;
    const raw = rows[0]?.cloud_destinations ?? [];
    return raw.map(d => normalizeDestination(d));
  } catch {
    return [];
  }
}

export async function saveCloudDestinationDefs(
  clientId:     string,
  destinations: CloudDestination[],
  config:       SupabaseConfig,
): Promise<void> {
  const base    = `${config.url}/rest/v1`;
  const headers = await makeHeaders(config.anonKey);
  await sbFetch(`${base}/clients?id=eq.${clientId}`, {
    method:  'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body:    JSON.stringify({ cloud_destinations: destinations.map(stripToken) }),
  });
}

