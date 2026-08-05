import { invoke } from '@tauri-apps/api/core';
import type { CloudDestination, CloudToken } from '../domain/client';

interface StoredCloudCredentials {
  version:       1;
  token:         CloudToken | null;
  clientSecret?: string;
}

function account(entryKey: string, destinationId: string): string {
  return `${entryKey}:${destinationId}`;
}

function credentialsFromDestination(destination: CloudDestination): StoredCloudCredentials | null {
  if (destination.config.type === 'local') return null;
  const clientSecret = destination.config.type === 'gdrive'
    ? destination.config.clientSecret
    : undefined;
  if (!destination.config.token && !clientSecret) return null;
  return { version: 1, token: destination.config.token, ...(clientSecret ? { clientSecret } : {}) };
}

export function stripDestinationCredentials(destination: CloudDestination): CloudDestination {
  if (destination.config.type === 'local') return destination;
  const config = { ...destination.config, token: null };
  if (config.type === 'gdrive') config.clientSecret = '';
  return { ...destination, config };
}

function withCredentials(
  destination: CloudDestination,
  credentials: StoredCloudCredentials | null,
): CloudDestination {
  if (destination.config.type === 'local' || !credentials) return destination;
  if (destination.config.type === 'gdrive') {
    return {
      ...destination,
      config: {
        ...destination.config,
        token: credentials.token,
        clientSecret: credentials.clientSecret ?? '',
      },
    };
  }
  return { ...destination, config: { ...destination.config, token: credentials.token } };
}

async function readCredentials(
  entryKey: string,
  destinationId: string,
): Promise<StoredCloudCredentials | null> {
  const secret = await invoke<string | null>('keychain_get_secret', {
    account: account(entryKey, destinationId),
  });
  if (!secret) return null;
  const parsed = JSON.parse(secret) as Partial<StoredCloudCredentials>;
  if (parsed.version !== 1 || (parsed.token !== null && typeof parsed.token !== 'object')) {
    throw new Error('Cloud credentials in the OS keychain have an unsupported format.');
  }
  return {
    version: 1,
    token: parsed.token ?? null,
    ...(typeof parsed.clientSecret === 'string' ? { clientSecret: parsed.clientSecret } : {}),
  };
}

export async function saveDestinationCredentials(
  entryKey: string,
  destination: CloudDestination,
): Promise<void> {
  if (destination.config.type === 'local') return;
  const credentials = credentialsFromDestination(destination);
  if (!credentials) {
    await deleteDestinationCredentials(entryKey, destination.id);
    return;
  }
  await invoke('keychain_set_secret', {
    account: account(entryKey, destination.id),
    secret: JSON.stringify(credentials),
  });
}

export async function loadDestinationCredentials(
  entryKey: string,
  destination: CloudDestination,
): Promise<CloudDestination> {
  if (destination.config.type === 'local') return destination;
  const inline = credentialsFromDestination(destination);
  if (inline) {
    await saveDestinationCredentials(entryKey, destination);
    return destination;
  }
  return withCredentials(destination, await readCredentials(entryKey, destination.id));
}

export async function deleteDestinationCredentials(
  entryKey: string,
  destinationId: string,
): Promise<void> {
  await invoke('keychain_delete_secret', {
    account: account(entryKey, destinationId),
  });
}

export function destinationHasInlineCredentials(destination: CloudDestination): boolean {
  return credentialsFromDestination(destination) !== null;
}
