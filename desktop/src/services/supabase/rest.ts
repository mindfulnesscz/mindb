import { invoke } from '@tauri-apps/api/core';
import { getAccessToken } from '../authService';

/** PostgREST write batch size. Large enough to keep round-trips low, small enough to stay
 *  under URL/body limits when keys are inlined. */
export const BATCH = 500;

export interface SupabaseConfig {
  url:     string;
  anonKey: string;
}

interface SbRustResponse { status: number; ok: boolean; body: string }

/**
 * Requests run as the signed-in user: the anon key identifies the project, the session JWT
 * authorizes — RLS staff policies are the write boundary.
 *
 * ASYNC on purpose. It asks auth for a token that is valid *now* rather than reading a cached
 * string, because a Supabase access token lives one hour and a desktop session easily outlives
 * that. Reading the cache is what made a second pipeline run fail with
 * "Storage grant refused (401): Not authenticated".
 */
export async function makeHeaders(
  anonKey: string,
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const token = await getAccessToken();
  if (!token) throw new Error('Not signed in — Supabase sync requires an active session.');
  return {
    apikey:         anonKey,
    Authorization:  `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

type SbOptions = { method?: string; headers: Record<string, string>; body?: string };

async function rustRequest(url: string, options: SbOptions): Promise<SbRustResponse> {
  return await invoke<SbRustResponse>('supabase_request', {
    url,
    method:  options.method ?? 'GET',
    headers: options.headers,
    body:    options.body,
  });
}

/**
 * Proxy fetch through Rust — native networking, no webview CORS surface.
 *
 * Retries ONCE on 401 with a force-refreshed token. Headers are built once per operation while a
 * pipeline run can take minutes, so a long run can cross the token's expiry mid-flight; without
 * this, the requests after that moment fail while the ones before succeeded. The retry is bounded
 * to a single attempt so a genuinely revoked session still surfaces as 401 rather than looping.
 */
export async function sbFetch(
  url:     string,
  options: SbOptions,
): Promise<{ ok: boolean; status: number; text(): Promise<string>; json<T>(): Promise<T> }> {
  let r = await rustRequest(url, options);

  if (r.status === 401 && options.headers.Authorization) {
    const fresh = await getAccessToken({ forceRefresh: true });
    if (fresh) {
      r = await rustRequest(url, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${fresh}` },
      });
    }
  }

  return {
    ok:     r.ok,
    status: r.status,
    text:   async () => r.body,
    json:   async <T>() => JSON.parse(r.body) as T,
  };
}

export async function fetchAllForClient<T>(
  base:     string,
  path:     string,
  clientId: string,
  select:   string,
  headers:  Record<string, string>,
): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  let page = 0;
  const sep = path.includes('?') ? '&' : '?';
  while (true) {
    const url = `${base}/${path}${sep}client_id=eq.${clientId}&select=${select}&limit=${PAGE}&offset=${page * PAGE}`;
    const res = await sbFetch(url, { headers });
    if (!res.ok) throw new Error(await res.text());
    const batch = await res.json() as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    page++;
  }
  return rows;
}
