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
 *   - clients.json      (legacy per-client supabaseUrl/anon-key pairs)
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

function guessName(url: string): string {
  if (url.includes('127.0.0.1') || url.includes('localhost')) return 'Local';
  const host = url.replace(/^https?:\/\//, '').split('.')[0];
  return host ? `Production (${host.slice(0, 8)})` : 'Production';
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

/** Loads environments, running the one-time migration from auth-server.json
 * and legacy clients.json when environments.json doesn't exist yet. */
export async function loadEnvironments(): Promise<PersistedEnvironments> {
  const path = await filePath();
  const existing = await readJsonIfExists<PersistedEnvironments>(path);
  if (existing) {
    // Re-shape strictly: files written before Phase 3 carried a serviceKey —
    // dropping unknown fields here scrubs it from disk on the next save.
    const list = (existing.list ?? []).map(e => makeEnvironment({
      id: e.id, name: e.name, supabaseUrl: e.supabaseUrl, anonKey: e.anonKey,
    }));
    return { activeId: existing.activeId ?? null, list };
  }

  const dir = await appDataDir();
  const list: Environment[] = [];
  const byUrl = new Map<string, Environment>();

  // Legacy clients.json → one environment per distinct Supabase URL.
  type LegacyClient = { name?: string; supabaseUrl?: string; supabaseAnonKey?: string; supabaseServiceKey?: string };
  const legacy = await readJsonIfExists<{ clients?: LegacyClient[] }>(await join(dir, 'clients.json'));
  for (const c of legacy?.clients ?? []) {
    const url = (c.supabaseUrl ?? '').trim().replace(/\/+$/, '');
    if (!url) continue;
    const found = byUrl.get(url);
    if (found) {
      if (!found.anonKey && c.supabaseAnonKey) found.anonKey = c.supabaseAnonKey;
      continue;
    }
    const env = makeEnvironment({
      name:        guessName(url),
      supabaseUrl: url,
      anonKey:     c.supabaseAnonKey ?? '',
    });
    byUrl.set(url, env);
    list.push(env);
  }

  // Phase-B auth-server.json → merge into a matching env or create one.
  const authServer = await readJsonIfExists<{ url?: string; anonKey?: string }>(await join(dir, 'auth-server.json'));
  if (authServer?.url && authServer.anonKey) {
    const url = authServer.url.trim().replace(/\/+$/, '');
    const found = byUrl.get(url);
    if (found) {
      if (!found.anonKey) found.anonKey = authServer.anonKey;
    } else {
      const env = makeEnvironment({ name: guessName(url), supabaseUrl: url, anonKey: authServer.anonKey });
      byUrl.set(url, env);
      list.push(env);
    }
  }

  const data: PersistedEnvironments = { activeId: list[0]?.id ?? null, list };
  if (list.length) await saveEnvironments(data);
  return data;
}

export async function saveEnvironments(data: PersistedEnvironments): Promise<void> {
  const dir = await appDataDir();
  try { await mkdir(dir, { recursive: true }); } catch { /* exists */ }
  await writeTextFile(await filePath(), JSON.stringify(data, null, 2));
}
