import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeStub } from '../test/invokeStub';
import type { CloudDestination, CloudToken } from '../domain/client';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => invokeStub.invoke(cmd, args),
}));

const {
  loadDestinationCredentials,
  saveDestinationCredentials,
  stripDestinationCredentials,
} = await import('./credentialService');

const token: CloudToken = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: 123,
  email: 'operator@example.com',
  displayName: 'Operator',
};

function gdrive(overrides: Partial<CloudDestination['config']> = {}): CloudDestination {
  return {
    id: 'destination-id',
    name: 'Google Drive',
    role: 'internal',
    minRole: 'member',
    exportLayout: 'folders',
    includePackages: false,
    generateLink: false,
    showInPortal: true,
    allowRevealLocal: false,
    enabled: true,
    config: {
      type: 'gdrive',
      clientId: 'google-client',
      clientSecret: 'google-secret',
      sharedDriveId: '',
      remotePath: '/delivery',
      token,
      ...overrides,
    },
  };
}

beforeEach(() => invokeStub.reset());

describe('cloud credential keychain persistence', () => {
  it('strips tokens and client secrets from the destination written to JSON', () => {
    const destination = gdrive();
    const stripped = stripDestinationCredentials(destination);

    expect(stripped.config).toMatchObject({ token: null, clientSecret: '' });
    expect(destination.config).toMatchObject({ token, clientSecret: 'google-secret' });
  });

  it('writes one versioned secret under the environment/client/destination account', async () => {
    await saveDestinationCredentials('env-id:client-id', gdrive());

    const args = invokeStub.argsFor('keychain_set_secret');
    expect(args).toHaveLength(1);
    expect(args[0].account).toBe('env-id:client-id:destination-id');
    expect(JSON.parse(args[0].secret as string)).toEqual({
      version: 1,
      token,
      clientSecret: 'google-secret',
    });
  });

  it('migrates inline legacy credentials before returning them', async () => {
    const destination = gdrive();

    expect(await loadDestinationCredentials('env:client', destination)).toBe(destination);
    expect(invokeStub.argsFor('keychain_set_secret')).toHaveLength(1);
    expect(invokeStub.argsFor('keychain_get_secret')).toHaveLength(0);
  });

  it('hydrates a secret-free destination from the OS keychain', async () => {
    invokeStub.replies.set('keychain_get_secret', JSON.stringify({
      version: 1,
      token,
      clientSecret: 'from-keychain',
    }));

    const hydrated = await loadDestinationCredentials(
      'env:client',
      gdrive({ token: null, clientSecret: '' }),
    );

    expect(hydrated.config).toMatchObject({ token, clientSecret: 'from-keychain' });
  });

  it('removes the keychain entry when credentials are cleared', async () => {
    await saveDestinationCredentials('env:client', gdrive({ token: null, clientSecret: '' }));

    expect(invokeStub.argsFor('keychain_delete_secret')).toEqual([
      { account: 'env:client:destination-id' },
    ]);
  });
});
