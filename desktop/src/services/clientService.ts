/* Clients — DB-first.
 *
 * The database owns client identity (name, accent, identity_migrated,
 * cloud destination definitions); the desktop READS the list per environment
 * after sign-in, filtered by client_members (admins see everything). This
 * machine only stores what is machine-local: folder paths, R2 credentials
 * (until the Control API phase), OAuth tokens, logo, and the last active
 * client — keyed by `${environmentId}:${clientUuid}` in client-local.json.
 *
 * Legacy clients.json (the old desktop-owned client list) migrates on first
 * load: connection values became environments (environmentService), local
 * fields land in a name-keyed pending pool and are adopted — including the
 * vocab-<id>.json re-key — the first time a DB client with that name appears.
 */
import { readTextFile, writeTextFile, exists, mkdir, copyFile } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { makeClient } from '../domain/client';
import type { Client, CloudDestination } from '../domain/client';
import type { VocabularyData } from '../domain/vocabulary';
import type { Environment } from './environmentService';
import { useEnvironmentStore } from '../store/environmentStore';
import { getAuthClient } from './authService';
import { fetchCloudDestinationDefs, saveCloudDestinationDefs } from './supabaseService';

/* ── Machine-local per-(environment, client) config ─────────────────────── */

export interface LocalClientConfig {
  logoDataUrl:        string | null;
  sourceFolder:       string;
  targetFolder:       string;
  vaultFolder:        string;
  cloudDestinations:  CloudDestination[];
  r2Endpoint:         string;
  r2AccessKeyId:      string;
  r2SecretKey:        string;
  r2Bucket:           string;
  r2PublicDomain:     string;
  lastCreationFolder: string;
}

interface PendingLocalConfig extends LocalClientConfig {
  /** the legacy clients.json id — used to re-key the vocab file on adoption */
  legacyClientId: string | null;
}

interface PersistedLocal {
  version:       2;
  /** `${envId}:${clientUuid}` → machine-local config */
  entries:       Record<string, LocalClientConfig>;
  /** legacy configs waiting for a DB client with a matching name: `${envId}:${lowercased name}` */
  pendingByName: Record<string, PendingLocalConfig>;
  /** last active client per environment */
  activeByEnv:   Record<string, string>;
  migratedFromClientsJson: boolean;
}

const EMPTY_LOCAL: LocalClientConfig = {
  logoDataUrl: null, sourceFolder: '', targetFolder: '', vaultFolder: '',
  cloudDestinations: [], r2Endpoint: '', r2AccessKeyId: '', r2SecretKey: '',
  r2Bucket: '', r2PublicDomain: '', lastCreationFolder: '',
};

async function localPath(): Promise<string> {
  return await join(await appDataDir(), 'client-local.json');
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    if (!(await exists(path))) return null;
    return JSON.parse(await readTextFile(path)) as T;
  } catch {
    return null;
  }
}

let localMemo: PersistedLocal | null = null;

async function loadLocal(): Promise<PersistedLocal> {
  if (localMemo) return localMemo;
  const existing = await readJsonIfExists<PersistedLocal>(await localPath());
  if (existing) {
    localMemo = {
      version: 2,
      entries:       existing.entries       ?? {},
      pendingByName: existing.pendingByName ?? {},
      activeByEnv:   existing.activeByEnv   ?? {},
      migratedFromClientsJson: existing.migratedFromClientsJson ?? false,
    };
    return localMemo;
  }
  localMemo = { version: 2, entries: {}, pendingByName: {}, activeByEnv: {}, migratedFromClientsJson: false };
  return localMemo;
}

async function saveLocal(): Promise<void> {
  if (!localMemo) return;
  const dir = await appDataDir();
  try { await mkdir(dir, { recursive: true }); } catch { /* exists */ }
  await writeTextFile(await localPath(), JSON.stringify(localMemo, null, 2));
}

function pickLocalFields(c: Partial<Client>): LocalClientConfig {
  return {
    logoDataUrl:        c.logoDataUrl        ?? null,
    sourceFolder:       c.sourceFolder       ?? '',
    targetFolder:       c.targetFolder       ?? '',
    vaultFolder:        c.vaultFolder        ?? '',
    cloudDestinations:  c.cloudDestinations  ?? [],
    r2Endpoint:         c.r2Endpoint         ?? '',
    r2AccessKeyId:      c.r2AccessKeyId      ?? '',
    r2SecretKey:        c.r2SecretKey        ?? '',
    r2Bucket:           c.r2Bucket           ?? '',
    r2PublicDomain:     c.r2PublicDomain     ?? '',
    lastCreationFolder: c.lastCreationFolder ?? '',
  };
}

/** One-time migration of the legacy clients.json local fields into the
 * name-keyed pending pool for every environment (URLs may repeat across
 * clients, so entries attach to the environment matching their URL). */
async function migrateLegacyClients(environments: Environment[]): Promise<void> {
  const local = await loadLocal();
  if (local.migratedFromClientsJson) return;
  type LegacyClient = Partial<Client> & { id?: string; name?: string; supabaseUrl?: string };
  const legacy = await readJsonIfExists<{ clients?: LegacyClient[] }>(
    await join(await appDataDir(), 'clients.json'),
  );
  for (const c of legacy?.clients ?? []) {
    if (!c.name) continue;
    const url = (c.supabaseUrl ?? '').trim().replace(/\/+$/, '');
    const env = environments.find(e => e.supabaseUrl === url) ?? environments[0];
    if (!env) continue;
    const key = `${env.id}:${c.name.trim().toLowerCase()}`;
    if (!local.pendingByName[key]) {
      local.pendingByName[key] = { ...pickLocalFields(c), legacyClientId: c.id ?? null };
    }
  }
  local.migratedFromClientsJson = true;
  await saveLocal();
}

/* ── DB clients ──────────────────────────────────────────────────────────── */

interface DbClientRow {
  id:                 string;
  name:               string;
  accent:             string | null;
  identity_migrated:  boolean | null;
}

/** Fetches the clients this user may operate in the ACTIVE environment, using
 * the signed-in session (never the service key). Admins see all clients;
 * everyone else sees their client_members assignments. */
async function fetchDbClients(role: string): Promise<DbClientRow[]> {
  const auth = getAuthClient();
  if (!auth) throw new Error('Not signed in');
  const select = 'id,name,accent,identity_migrated';
  if (role === 'admin') {
    const { data, error } = await auth.from('clients').select(select).order('name');
    if (error) throw new Error(error.message);
    return (data ?? []) as DbClientRow[];
  }
  const { data, error } = await auth
    .from('client_members')
    .select(`clients(${select})`);
  if (error) throw new Error(error.message);
  // supabase-js types the embedded to-one relation as an array; it's an object at runtime
  return ((data ?? []) as unknown as Array<{ clients: DbClientRow | null }>)
    .map(r => r.clients)
    .filter((c): c is DbClientRow => !!c)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function mergeClient(env: Environment, row: DbClientRow, local: LocalClientConfig): Client {
  return makeClient({
    id:                 row.id,
    name:               row.name,
    brandColor:         row.accent || '#161616',
    identityMigrated:   !!row.identity_migrated,
    supabaseUrl:        env.supabaseUrl,
    supabaseAnonKey:    env.anonKey,
    supabaseServiceKey: env.serviceKey,
    ...local,
  });
}

export interface LoadedClients {
  clients:        Client[];
  activeClientId: string | null;
}

/** The main entry: DB clients for this environment + user, merged with this
 * machine's local config (adopting legacy name-keyed configs on first sight,
 * including the vocab-file re-key). */
export async function loadClientsForEnvironment(
  env: Environment,
  role: string,
  allEnvironments: Environment[],
): Promise<LoadedClients> {
  await migrateLegacyClients(allEnvironments);
  const local = await loadLocal();
  const rows = await fetchDbClients(role);

  let dirty = false;
  const clients: Client[] = [];
  for (const row of rows) {
    const key = `${env.id}:${row.id}`;
    let cfg = local.entries[key];
    if (!cfg) {
      const pendingKey = `${env.id}:${row.name.trim().toLowerCase()}`;
      const pending = local.pendingByName[pendingKey];
      if (pending) {
        const { legacyClientId, ...fields } = pending;
        cfg = fields;
        local.entries[key] = cfg;
        delete local.pendingByName[pendingKey];
        dirty = true;
        if (legacyClientId) await adoptVocabFile(legacyClientId, row.id);
      } else {
        cfg = { ...EMPTY_LOCAL };
      }
    }
    clients.push(mergeClient(env, row, cfg));
  }
  if (dirty) await saveLocal();

  const remembered = local.activeByEnv[env.id] ?? null;
  const activeClientId = clients.some(c => c.id === remembered)
    ? remembered
    : (clients.length === 1 ? clients[0].id : null);
  return { clients, activeClientId };
}

/** Re-keys a legacy vocab-<localId>.json to the client's DB uuid so the
 * per-client vocabulary survives the identity change. Copy, not move —
 * the legacy file stays as a harmless backup. */
async function adoptVocabFile(legacyId: string, dbId: string): Promise<void> {
  try {
    const dir = await appDataDir();
    const from = await join(dir, `vocab-${legacyId}.json`);
    const to   = await join(dir, `vocab-${dbId}.json`);
    if ((await exists(from)) && !(await exists(to))) await copyFile(from, to);
  } catch { /* best-effort — worst case the client starts from the seed vocab */ }
}

/** Persists the machine-local slice of a merged Client. */
export async function saveLocalClient(envId: string, client: Client): Promise<void> {
  const local = await loadLocal();
  local.entries[`${envId}:${client.id}`] = pickLocalFields(client);
  await saveLocal();
}

export async function saveActiveClient(envId: string, clientId: string | null): Promise<void> {
  const local = await loadLocal();
  if (clientId) local.activeByEnv[envId] = clientId;
  else delete local.activeByEnv[envId];
  await saveLocal();
}

/** Back-compat persistence for views that call `saveClients` after a store
 * update: writes each merged client's machine-local slice for the ACTIVE
 * environment plus the active selection. DB-owned fields (name, accent,
 * identity_migrated) are managed through the DB, not this file. */
export async function saveClients(data: { clients: Client[]; activeClientId: string | null }): Promise<void> {
  const envId = useEnvironmentStore.getState().activeEnvId;
  if (!envId) return;
  const local = await loadLocal();
  for (const c of data.clients) local.entries[`${envId}:${c.id}`] = pickLocalFields(c);
  if (data.activeClientId) local.activeByEnv[envId] = data.activeClientId;
  await saveLocal();
}

/* ── DB writes (admin, via the user session — RLS enforces the role) ─────── */

export async function createDbClient(name: string, accent: string): Promise<DbClientRow> {
  const auth = getAuthClient();
  if (!auth) throw new Error('Not signed in');
  const { data, error } = await auth
    .from('clients')
    .insert({ name: name.trim(), accent })
    .select('id,name,accent,identity_migrated')
    .single();
  if (error) throw new Error(error.message);
  return data as DbClientRow;
}

export async function updateDbClient(id: string, patch: { name?: string; accent?: string }): Promise<void> {
  const auth = getAuthClient();
  if (!auth) throw new Error('Not signed in');
  const { error } = await auth.from('clients').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
}

/* ── Cloud destination sync — Supabase holds the shared definition, this
   machine's local cache holds tokens. See CLOUD_DESTINATIONS.md. ────────── */

export function mergeCloudDestinations(
  local:  CloudDestination[],
  remote: CloudDestination[],
): CloudDestination[] {
  if (!remote.length) return local;

  const localById = new Map(local.map(d => [d.id, d]));
  return remote.map(def => {
    if (def.config.type === 'local') return def;
    const existing = localById.get(def.id);
    const existingToken = existing && existing.config.type !== 'local' ? existing.config.token : null;
    return { ...def, config: { ...def.config, token: existingToken } };
  });
}

/** Pulls shared destination definitions from Supabase and merges with this
 * machine's tokens. The client id IS the DB row id now — no name resolution. */
export async function pullCloudDestinations(client: Client): Promise<CloudDestination[] | null> {
  if (!client.supabaseUrl || !client.supabaseServiceKey) return null;
  const sbConfig = { url: client.supabaseUrl, serviceKey: client.supabaseServiceKey };
  const remote = await fetchCloudDestinationDefs(client.id, sbConfig);
  return mergeCloudDestinations(client.cloudDestinations, remote);
}

/** Pushes this machine's destination definitions (tokens stripped) up to Supabase. */
export async function pushCloudDestinations(client: Client): Promise<void> {
  if (!client.supabaseUrl || !client.supabaseServiceKey) return;
  const sbConfig = { url: client.supabaseUrl, serviceKey: client.supabaseServiceKey };
  await saveCloudDestinationDefs(client.id, client.cloudDestinations, sbConfig);
}

/* ── Export / Import ──────────────────────────────────────────────────────── */

export interface ClientExport {
  _type:       'dc-hub-client-export';
  _version:    '1.0';
  client:      Client;
  vocabulary:  VocabularyData;
}

export async function exportClientBundle(
  client: Client,
  vocabulary: VocabularyData,
): Promise<void> {
  const bundle: ClientExport = {
    _type: 'dc-hub-client-export',
    _version: '1.0',
    client,
    vocabulary,
  };
  const defaultName = `${client.name.trim().replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-')}-dc-hub.json`;
  const path = await saveDialog({
    defaultPath: defaultName,
    filters: [{ name: 'DC Hub Client', extensions: ['json'] }],
  });
  if (!path) return;
  await writeTextFile(path as string, JSON.stringify(bundle, null, 2));
}

/** Imports a bundle's machine-local fields + vocabulary for an EXISTING DB
 * client matched by name in the given environment (clients are DB-first —
 * imports no longer create them). Returns the matched client id, or null
 * when no DB client with that name exists in this environment's list. */
export async function importClientBundle(
  envId: string,
  knownClients: Client[],
): Promise<{ clientId: string; vocabulary: VocabularyData } | null> {
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: 'DC Hub Client', extensions: ['json'] }],
  });
  if (!selected) return null;

  const text   = await readTextFile(selected as string);
  const bundle = JSON.parse(text) as Partial<ClientExport>;

  if (bundle._type !== 'dc-hub-client-export' || !bundle.client || !bundle.vocabulary) {
    throw new Error('Not a valid DC Hub client export file.');
  }

  const name = (bundle.client.name ?? '').trim().toLowerCase();
  const match = knownClients.find(c => c.name.trim().toLowerCase() === name);
  if (!match) {
    throw new Error(
      `No client named "${bundle.client.name}" exists in this environment — create it first (admin), then re-import.`,
    );
  }

  const local = await loadLocal();
  local.entries[`${envId}:${match.id}`] = pickLocalFields(bundle.client);
  await saveLocal();
  return { clientId: match.id, vocabulary: bundle.vocabulary };
}
