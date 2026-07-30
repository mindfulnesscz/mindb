/* Connection check for the Settings UI.
 *
 * Deliberately minimal: proves the URL + anon key reach a project and that the session
 * authorises a read. Anything richer belongs in the Settings view, not here.
 */

import { makeHeaders, sbFetch } from './rest';

/* ── Connection check (used by Settings UI) ──────────────────────────────── */

export async function checkSupabaseConnection(
  url:     string,
  anonKey: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await sbFetch(
      `${url.trim()}/rest/v1/clients?select=count&limit=0`,
      { headers: await makeHeaders(anonKey.trim()) },
    );
    if (res.ok) return { ok: true, message: 'Connected — session authorized' };
    const body = await res.text();
    return { ok: false, message: `Error ${res.status}: ${body.slice(0, 120)}` };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}
