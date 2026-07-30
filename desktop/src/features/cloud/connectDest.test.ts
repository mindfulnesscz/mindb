/* Connecting a destination: the provider branch, the device-code wait, cancellation.
 *
 * The OneDrive flow is the one that needs pinning. It polls for up to fifteen minutes, so it can
 * outlive the screen that started it — and a token that arrives after the operator cancelled must be
 * DISCARDED, not written into the form. The failure is silent and specific: a destination shows as
 * connected to an account nobody chose to connect.
 *
 * The identity check matters for the same reason. A token with no account attached leaves the list
 * saying "Connected" without saying to what, and a delivery can land in a staff member's personal
 * drive instead of the client's.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DestConfig, CloudToken } from '../../domain/client';

const cloud = {
  connectDropbox:           vi.fn(),
  checkDropboxConnection:   vi.fn(),
  refreshDropboxToken:      vi.fn(),
  startOneDriveDeviceCode:  vi.fn(),
  pollOneDriveToken:        vi.fn(),
  checkOneDriveConnection:  vi.fn(),
  refreshOneDriveToken:     vi.fn(),
  connectGDrive:            vi.fn(),
  checkGDriveConnection:    vi.fn(),
  refreshGDriveToken:       vi.fn(),
  delay:                    vi.fn(async () => {}),
};
vi.mock('../../services/cloudService', () => cloud);

const { connectDestination, refreshDestinationToken } = await import('./connectDest');

const token = (over: Partial<CloudToken> = {}): CloudToken => ({
  accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, ...over,
} as CloudToken);

const dropbox = { type: 'dropbox', clientId: 'db-app', token: null } as unknown as DestConfig;
const gdrive  = { type: 'gdrive', clientId: 'gd-app', clientSecret: 'gd-secret', token: null } as unknown as DestConfig;
const onedrive = { type: 'onedrive', clientId: 'od-app', tenantId: 'tenant-1', token: null } as unknown as DestConfig;

const deviceCode = (over = {}) => ({
  deviceCode: 'dev-code', userCode: 'ABCD-1234',
  verificationUri: 'https://microsoft.com/devicelogin',
  expiresIn: 900, interval: 5, ...over,
});

const signal = () => ({ cancelled: false });

beforeEach(() => {
  for (const fn of Object.values(cloud)) fn.mockReset();
  cloud.delay.mockImplementation(async () => {});
  cloud.checkDropboxConnection.mockResolvedValue({ email: 'db@x.com', displayName: 'DB User' });
  cloud.checkOneDriveConnection.mockResolvedValue({ email: 'od@x.com', displayName: 'OD User' });
  cloud.checkGDriveConnection.mockResolvedValue({ email: 'gd@x.com', displayName: 'GD User' });
});

describe('connectDestination — provider routing', () => {
  it('runs the Dropbox PKCE flow and attaches the account', async () => {
    cloud.connectDropbox.mockResolvedValue(token());
    const r = await connectDestination(dropbox, { signal: signal() });

    expect(cloud.connectDropbox).toHaveBeenCalledWith('db-app');
    expect(r).toMatchObject({ email: 'db@x.com', displayName: 'DB User' });
    expect(cloud.startOneDriveDeviceCode).not.toHaveBeenCalled();
    expect(cloud.connectGDrive).not.toHaveBeenCalled();
  });

  it('runs the Google flow with the client secret and attaches the account', async () => {
    cloud.connectGDrive.mockResolvedValue(token());
    const r = await connectDestination(gdrive, { signal: signal() });

    expect(cloud.connectGDrive).toHaveBeenCalledWith('gd-app', 'gd-secret');
    expect(r?.email).toBe('gd@x.com');
    expect(cloud.checkGDriveConnection).toHaveBeenCalledWith('at');
  });

  it('does nothing for a local destination — there is no account to connect', async () => {
    await expect(connectDestination({ type: 'local', path: '/out' } as DestConfig, { signal: signal() }))
      .resolves.toBeNull();
    expect(cloud.connectDropbox).not.toHaveBeenCalled();
  });

  it('lets a provider error surface — that is a failure, not a cancellation', async () => {
    cloud.connectDropbox.mockRejectedValue(new Error('user denied access'));
    await expect(connectDestination(dropbox, { signal: signal() })).rejects.toThrow(/user denied access/);
  });
});

describe('connectDestination — the OneDrive device-code wait', () => {
  it('hands the code to the UI BEFORE it starts polling', async () => {
    // The operator has to read the code off the screen; showing it after the wait is useless.
    const order: string[] = [];
    cloud.startOneDriveDeviceCode.mockResolvedValue(deviceCode());
    cloud.pollOneDriveToken.mockImplementation(async () => { order.push('poll'); return token(); });

    await connectDestination(onedrive, {
      signal: signal(),
      onDeviceCode: info => { order.push(`code:${info.userCode}`); },
    });

    expect(order).toEqual(['code:ABCD-1234', 'poll']);
  });

  it('keeps polling while the user is still signing in', async () => {
    cloud.startOneDriveDeviceCode.mockResolvedValue(deviceCode());
    cloud.pollOneDriveToken
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(token({ accessToken: 'od-at' }));

    const r = await connectDestination(onedrive, { signal: signal() });

    expect(cloud.pollOneDriveToken).toHaveBeenCalledTimes(3);
    expect(r?.accessToken).toBe('od-at');
    expect(r?.email).toBe('od@x.com');
  });

  it('waits one interval LONGER than Microsoft asks — polling too fast earns slow_down', async () => {
    cloud.startOneDriveDeviceCode.mockResolvedValue(deviceCode({ interval: 5 }));
    cloud.pollOneDriveToken.mockResolvedValue(token());

    await connectDestination(onedrive, { signal: signal() });
    expect(cloud.delay).toHaveBeenCalledWith(6000);
  });

  it('stops and returns null the moment it is cancelled mid-wait', async () => {
    // Cancel arrives during the sleep — the poll after it must not run at all.
    const sig = signal();
    cloud.startOneDriveDeviceCode.mockResolvedValue(deviceCode());
    cloud.delay.mockImplementation(async () => { sig.cancelled = true; });
    cloud.pollOneDriveToken.mockResolvedValue(token());

    await expect(connectDestination(onedrive, { signal: sig })).resolves.toBeNull();
    expect(cloud.pollOneDriveToken).not.toHaveBeenCalled();
  });

  it('DISCARDS a token that arrives after cancellation', async () => {
    // The dangerous case: authorization succeeded, but the operator already backed out. Returning the
    // token would connect a destination they abandoned — and skip the account check besides.
    const sig = signal();
    cloud.startOneDriveDeviceCode.mockResolvedValue(deviceCode());
    cloud.pollOneDriveToken.mockImplementation(async () => { sig.cancelled = true; return token(); });

    await expect(connectDestination(onedrive, { signal: sig })).resolves.toBeNull();
    expect(cloud.checkOneDriveConnection).not.toHaveBeenCalled();
  });

  it('gives up with a clear message when the code expires', async () => {
    // expiresIn 0 ⇒ the deadline has already passed, so the loop never polls.
    cloud.startOneDriveDeviceCode.mockResolvedValue(deviceCode({ expiresIn: 0 }));

    await expect(connectDestination(onedrive, { signal: signal() }))
      .rejects.toThrow(/timed out or was cancelled/i);
    expect(cloud.pollOneDriveToken).not.toHaveBeenCalled();
  });

  it('passes the tenant id through — single-tenant apps reject /common', async () => {
    cloud.startOneDriveDeviceCode.mockResolvedValue(deviceCode());
    cloud.pollOneDriveToken.mockResolvedValue(token());

    await connectDestination(onedrive, { signal: signal() });

    expect(cloud.startOneDriveDeviceCode).toHaveBeenCalledWith('od-app', 'tenant-1');
    expect(cloud.pollOneDriveToken).toHaveBeenCalledWith('od-app', 'tenant-1', 'dev-code', 5, expect.anything());
  });
});

describe('refreshDestinationToken', () => {
  it('refreshes through the provider that issued the token', async () => {
    cloud.refreshDropboxToken.mockResolvedValue({ accessToken: 'new' });
    await refreshDestinationToken({ ...dropbox, token: token() } as DestConfig);

    expect(cloud.refreshDropboxToken).toHaveBeenCalledWith('db-app', 'rt');
    expect(cloud.refreshOneDriveToken).not.toHaveBeenCalled();
    expect(cloud.refreshGDriveToken).not.toHaveBeenCalled();
  });

  it('sends a OneDrive token to Microsoft with its tenant', async () => {
    cloud.refreshOneDriveToken.mockResolvedValue({ accessToken: 'new' });
    await refreshDestinationToken({ ...onedrive, token: token() } as DestConfig);
    expect(cloud.refreshOneDriveToken).toHaveBeenCalledWith('od-app', 'tenant-1', 'rt');
  });

  it('sends a Drive token to Google with the client secret', async () => {
    cloud.refreshGDriveToken.mockResolvedValue({ accessToken: 'new' });
    await refreshDestinationToken({ ...gdrive, token: token() } as DestConfig);
    expect(cloud.refreshGDriveToken).toHaveBeenCalledWith('gd-app', 'gd-secret', 'rt');
  });

  it('refuses when there is nothing to refresh', async () => {
    await expect(refreshDestinationToken(dropbox)).rejects.toThrow(/not connected/i);
    await expect(refreshDestinationToken({ type: 'local', path: '/x' } as DestConfig)).rejects.toThrow(/not connected/i);
  });
});
