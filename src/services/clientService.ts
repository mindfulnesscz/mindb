import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { makeClient } from '../domain/client';
import type { Client } from '../domain/client';
import type { VocabularyData } from '../domain/vocabulary';

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
