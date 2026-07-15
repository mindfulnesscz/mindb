import { invoke } from '@tauri-apps/api/core';
import { getCurrentAccessToken } from '../authService';

export interface SupabaseConfig {
  url:     string;
  anonKey: string;
}

interface SbRustResponse { status: number; ok: boolean; body: string }

/** Requests run as the signed-in user: the anon key identifies the project,
 * the session JWT authorizes — RLS staff policies are the write boundary. */
export function makeHeaders(anonKey: string, extra?: Record<string, string>): Record<string, string> {
  const token = getCurrentAccessToken();
  if (!token) throw new Error('Not signed in — Supabase sync requires an active session.');
  return {
    apikey:         anonKey,
    Authorization:  `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/** Proxy fetch through Rust — native networking, no webview CORS surface. */
export async function sbFetch(
  url:     string,
  options: { method?: string; headers: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; text(): Promise<string>; json<T>(): Promise<T> }> {
  const r = await invoke<SbRustResponse>('supabase_request', {
    url,
    method:  options.method ?? 'GET',
    headers: options.headers,
    body:    options.body,
  });
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
