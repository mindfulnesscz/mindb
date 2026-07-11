import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { makeClient } from '../domain/client';
import type { Client, CloudDestination } from '../domain/client';
import type { VocabularyData } from '../domain/vocabulary';
import { resolveClientId, fetchCloudDestinationDefs, saveCloudDestinationDefs } from './supabaseService';

export interface PersistedClients {
  clients:        Client[];
  activeClientId: string | null;
}

let _path: string | null = null;

async function getPath(): Promise<string> {
  if (_path) return _path;
  const dir = await appDataDir();
  _path = await join(dir, 'clients.json');
  return _path;
}

export async function loadClients(): Promise<PersistedClients> {
  const path = await getPath();
  let fileExists = false;
  try { fileExists = await exists(path); } catch { fileExists = false; }
  if (!fileExists) return { clients: [], activeClientId: null };
  const text = await readTextFile(path);
  const data = JSON.parse(text) as PersistedClients;
  // Apply makeClient defaults so new fields always exist on legacy saved clients
  data.clients = data.clients.map(c => makeClient(c));
  return data;
}

export async function saveClients(data: PersistedClients): Promise<void> {
  const dir  = await appDataDir();
  const path = await getPath();
  await mkdir(dir, { recursive: true });
  await writeTextFile(path, JSON.stringify(data, null, 2));
}

/* ── Cloud destination sync — Supabase holds the shared definition, this
   machine's local cache holds tokens. See CLOUD_DESTINATIONS.md. ────────── */

/**
 * Reconciles this machine's local destinations against the shared Supabase list.
 * - Remote empty, local non-empty: Supabase hasn't been seeded yet — keep local as-is
 *   (the caller pushes it up next), rather than wiping local destinations to nothing.
 * - Remote non-empty: Supabase is authoritative for every field except each entry's
 *   OAuth token, which is preserved from the matching local destination (by id) if
 *   present. Local-only destinations not present remotely were deleted elsewhere
 *   and are dropped; remote-only destinations are added locally with no token yet.
 */
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

/** Pulls shared destination definitions from Supabase and merges with this machine's
 * tokens. Returns null if Supabase isn't configured for this client or the fetch fails. */
export async function pullCloudDestinations(client: Client): Promise<CloudDestination[] | null> {
  if (!client.supabaseUrl || !client.supabaseServiceKey) return null;
  const sbConfig = { url: client.supabaseUrl, serviceKey: client.supabaseServiceKey };
  const remoteId = await resolveClientId(client.name, client.brandColor, sbConfig, () => {});
  if (!remoteId) return null;
  const remote = await fetchCloudDestinationDefs(remoteId, sbConfig);
  return mergeCloudDestinations(client.cloudDestinations, remote);
}

/** Pushes this machine's destination definitions (tokens stripped) up to Supabase. */
export async function pushCloudDestinations(client: Client): Promise<void> {
  if (!client.supabaseUrl || !client.supabaseServiceKey) return;
  const sbConfig = { url: client.supabaseUrl, serviceKey: client.supabaseServiceKey };
  const remoteId = await resolveClientId(client.name, client.brandColor, sbConfig, () => {});
  if (!remoteId) return;
  await saveCloudDestinationDefs(remoteId, client.cloudDestinations, sbConfig);
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

export async function importClientBundle(): Promise<{ client: Client; vocabulary: VocabularyData } | null> {
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

  return {
    client:     { ...bundle.client, id: crypto.randomUUID() },
    vocabulary: bundle.vocabulary,
  };
}
