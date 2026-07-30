/* Environments — which backend the desktop talks to.
 *
 * An environment is a connection: Supabase URL + anon key. Everything the
 * desktop does — sign-in, reads, pipeline sync — runs as the signed-in user
 * under RLS; no privileged key exists here (authentication-plan Phase 3).
 * Clients are NOT stored here — they live in each environment's database
 * and are fetched per sign-in (clientService).
 *
 * Persisted to environments.json. On first run, migrates from:
 *   - auth-server.json  (the Phase-B login gate's single server config)
 */
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';

export interface Environment {
  id:          string;
  name:        string;   // e.g. "Production", "Staging", "Local"
  supabaseUrl: string;
  anonKey:     string;
}

export interface PersistedEnvironments {
  activeId: string | null;
  list:     Environment[];
}

const FILE = 'environments.json';

async function filePath(): Promise<string> {
  return await join(await appDataDir(), FILE);
}

const LOCAL_PORTAL = 'http://localhost:5173';
const STAGING_PORTAL = 'https://staging.hub.disruptcollective.com';
const PRODUCTION_PORTAL = 'https://hub.disruptcollective.com';

/** Known Supabase project refs → hosted portal origins (deployment.mdx). */
const PORTAL_BY_SUPABASE_REF: Record<string, string> = {
  tvrxnwbhzborkkkdeyuk: STAGING_PORTAL,
  knbxyaplaoenrxrpgwcg: PRODUCTION_PORTAL,
};

function supabaseProjectRef(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;
  try {
    const host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase();
    const m = host.match(/^([a-z0-9]+)\.supabase\.co$/i);
    return m?.[1] ?? null;
  } catch {
    const m = raw.match(/([a-z0-9]+)\.supabase\.co/i);
    return m?.[1]?.toLowerCase() ?? null;
  }
}

/** Portal origin for "Manage in portal" — follows the active Supabase environment. */
export function portalUrlForEnvironment(env: Environment | null | undefined): string {
  const url = (env?.supabaseUrl ?? '').trim();
  if (!url || /127\.0\.0\.1|localhost/i.test(url)) return LOCAL_PORTAL;

  // Prefer the project ref from the URL — never trust env display names alone.
  // (An env mislabelled "Production (…)" would otherwise open the production portal.)
  const ref = supabaseProjectRef(url);
  if (ref && PORTAL_BY_SUPABASE_REF[ref]) return PORTAL_BY_SUPABASE_REF[ref];

  const name = (env?.name ?? '').trim().toLowerCase();
  if (name.includes('staging') || /(^|\s)stage(\s|$)/.test(name)) return STAGING_PORTAL;
  if (name === 'production' || name === 'prod') return PRODUCTION_PORTAL;

  // Unknown hosted project — staging-first (safer than opening production admin).
  return STAGING_PORTAL;
}

/** Guard the anon-key fields against privileged keys. The desktop must never
 * hold one (authentication-plan): sb_secret_* is Supabase's secret API key,
 * and a JWT with role service_role bypasses RLS entirely. Returns a
 * user-facing error, or null when the key is acceptable. */
export function validateAnonKey(key: string): string | null {
  const k = key.trim();
  if (!k) return null; // emptiness is handled by required-field checks
  if (k.startsWith('sb_secret_')) {
    return 'That is the SECRET key — it must never be entered in this app. Use the publishable key (sb_publishable_…) from Supabase → Settings → API Keys.';
  }
  if (k.startsWith('eyJ')) {
    try {
      const payload = JSON.parse(atob(k.split('.')[1] ?? ''));
      if (payload?.role === 'service_role') {
        return 'That is the service_role key — it bypasses all security and must never be entered in this app. Use the anon/publishable key instead.';
      }
    } catch { /* not a decodable JWT — let the server reject it on sign-in */ }
  }
  return null;
}

export function makeEnvironment(partial: Partial<Environment> = {}): Environment {
  return {
    id:          crypto.randomUUID(),
    name:        '',
    supabaseUrl: '',
    anonKey:     '',
    ...partial,
  };
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    if (!(await exists(path))) return null;
    return JSON.parse(await readTextFile(path)) as T;
  } catch {
    return null;
  }
}

/** Loads environments from disk. When none exist, the login screen creates the first one —
 * there is no config to inherit from anywhere else. */
export async function loadEnvironments(): Promise<PersistedEnvironments> {
  const existing = await readJsonIfExists<PersistedEnvironments>(await filePath());
  if (!existing) return { activeId: null, list: [] };
  // Re-shape strictly: files written before Phase 3 carried a serviceKey —
  // dropping unknown fields here scrubs it from disk on the next save.
  const list = (existing.list ?? []).map(e => makeEnvironment({
    id: e.id, name: e.name, supabaseUrl: e.supabaseUrl, anonKey: e.anonKey,
  }));
  return { activeId: existing.activeId ?? null, list };
}

export async function saveEnvironments(data: PersistedEnvironments): Promise<void> {
  const dir = await appDataDir();
  try { await mkdir(dir, { recursive: true }); } catch { /* exists */ }
  await writeTextFile(await filePath(), JSON.stringify(data, null, 2));
}
