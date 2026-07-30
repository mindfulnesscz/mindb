/* Token refresh — the dispatcher, and each provider's exchange.
 *
 * `refreshCloudToken` is called with whatever destination config a client happens to hold, and it is
 * the ONE place that must know about all three providers. Dispatching to the wrong one sends a
 * client's credentials to the wrong vendor's token endpoint and fails a delivery run at the last
 * step — after the files are already staged. So the dispatch is pinned per provider.
 *
 * Each provider is also pinned on what it puts on the wire, because the token endpoints reject
 * silently-wrong requests with a 400 that surfaces to the operator as "refresh failed" and nothing
 * more: Dropbox refreshes without a secret, Google requires one, and OneDrive goes through Rust and
 * needs the tenant id (single-tenant registrations reject `/common` with AADSTS50059).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFetchStub, type FetchStub } from '../../test/fetchStub';
import { invokeStub } from '../../test/invokeStub';

vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args: Record<string, unknown>) => invokeStub.invoke(cmd, args) }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));

const { refreshCloudToken } = await import('../cloudService');
const { refreshDropboxToken } = await import('./dropbox');
const { refreshGDriveToken } = await import('./gdrive');
const { refreshOneDriveToken } = await import('./onedrive');

const DROPBOX_TOKEN = /api\.dropboxapi\.com\/oauth2\/token/;
const GOOGLE_TOKEN  = /oauth2\.googleapis\.com\/token/;

let stub: FetchStub;

const token = (over: Record<string, unknown> = {}) => ({
  accessToken: 'old-access', refreshToken: 'the-refresh-token', expiresAt: 0, ...over,
});

beforeEach(() => {
  invokeStub.reset();
  stub = installFetchStub();
  stub.route(DROPBOX_TOKEN, { json: { access_token: 'db-new', expires_in: 14400 } });
  stub.route(GOOGLE_TOKEN,  { json: { access_token: 'gd-new', expires_in: 3600 } });
  invokeStub.replies.set('onedrive_refresh_token', {
    accessToken: 'od-new', refreshToken: 'od-rotated', expiresIn: 3600,
  });
});
afterEach(() => stub.restore());

describe('refreshCloudToken — dispatch', () => {
  it('sends a dropbox destination to Dropbox and nowhere else', async () => {
    await refreshCloudToken({ type: 'dropbox', clientId: 'db-app', token: token() });

    expect(stub.matching(DROPBOX_TOKEN)).toHaveLength(1);
    expect(stub.matching(GOOGLE_TOKEN)).toHaveLength(0);
    expect(invokeStub.argsFor('onedrive_refresh_token')).toHaveLength(0);
  });

  it('sends a gdrive destination to Google, passing the client secret through', async () => {
    await refreshCloudToken({ type: 'gdrive', clientId: 'gd-app', clientSecret: 'gd-secret', token: token() });

    expect(stub.one(GOOGLE_TOKEN).form()).toMatchObject({
      client_id: 'gd-app', client_secret: 'gd-secret', refresh_token: 'the-refresh-token',
    });
    expect(stub.matching(DROPBOX_TOKEN)).toHaveLength(0);
  });

  it('sends a onedrive destination through Rust, not through fetch', async () => {
    // The Microsoft exchange lives in Rust because it needs the client secret for confidential
    // registrations; the webview never sees it.
    await refreshCloudToken({ type: 'onedrive', clientId: 'od-app', tenantId: 'tenant-guid', token: token() });

    expect(invokeStub.argsFor('onedrive_refresh_token')).toEqual([
      { clientId: 'od-app', tenantId: 'tenant-guid', refreshToken: 'the-refresh-token' },
    ]);
    expect(stub.calls).toHaveLength(0);
  });

  it('defaults a missing tenant to "common" rather than sending undefined', async () => {
    await refreshCloudToken({ type: 'onedrive', clientId: 'od-app', token: token() });
    expect(invokeStub.argsFor('onedrive_refresh_token')[0].tenantId).toBe('common');
  });

  it('refuses a destination with no refresh token instead of calling out with an empty one', async () => {
    await expect(refreshCloudToken({ type: 'dropbox', clientId: 'x', token: null }))
      .rejects.toThrow(/no refresh token/i);
    await expect(refreshCloudToken({ type: 'dropbox', clientId: 'x', token: token({ refreshToken: '' }) }))
      .rejects.toThrow(/no refresh token/i);

    expect(stub.calls).toHaveLength(0);
  });

  it('refuses an unknown provider by name, so a typo in a destination is diagnosable', async () => {
    await expect(refreshCloudToken({ type: 'sharepoint', clientId: 'x', token: token() }))
      .rejects.toThrow(/unknown provider: sharepoint/i);
  });
});

describe('refreshDropboxToken', () => {
  it('posts a urlencoded refresh_token grant with the app id and NO secret', async () => {
    // Dropbox PKCE apps have no secret; sending one is a 400.
    await refreshDropboxToken('db-app', 'the-refresh-token');
    const call = stub.one(DROPBOX_TOKEN);

    expect(call.method).toBe('POST');
    expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(call.form()).toEqual({
      grant_type: 'refresh_token', refresh_token: 'the-refresh-token', client_id: 'db-app',
    });
  });

  it('returns the new access token with an absolute expiry', async () => {
    const before = Date.now();
    const r = await refreshDropboxToken('db-app', 'r');

    expect(r.accessToken).toBe('db-new');
    // Stored absolute, not as a duration — callers compare it against the clock.
    expect(r.expiresAt).toBeGreaterThanOrEqual(before + 14400 * 1000);
  });

  it('falls back to a 4-hour expiry when the response omits expires_in', async () => {
    stub.route(DROPBOX_TOKEN, { json: { access_token: 'db-new' } });
    const r = await refreshDropboxToken('db-app', 'r');
    expect(r.expiresAt! - Date.now()).toBeGreaterThan(14000 * 1000);
  });

  it('does NOT return a refreshToken — the existing one stays valid', async () => {
    // Dropbox refresh tokens are long-lived and not rotated; returning undefined here would
    // overwrite a stored one if the caller spread it blindly.
    expect(await refreshDropboxToken('db-app', 'r')).not.toHaveProperty('refreshToken');
  });

  it('surfaces the provider body on failure instead of a bare status', async () => {
    stub.route(DROPBOX_TOKEN, { status: 400, text: 'invalid_grant' });
    await expect(refreshDropboxToken('db-app', 'r')).rejects.toThrow(/invalid_grant/);
  });
});

describe('refreshGDriveToken', () => {
  it('posts client_id, client_secret and the refresh token', async () => {
    await refreshGDriveToken('gd-app', 'gd-secret', 'r');
    expect(stub.one(GOOGLE_TOKEN).form()).toEqual({
      grant_type: 'refresh_token', client_id: 'gd-app', client_secret: 'gd-secret', refresh_token: 'r',
    });
  });

  it('defaults to a 1-hour expiry when expires_in is absent', async () => {
    stub.route(GOOGLE_TOKEN, { json: { access_token: 'gd-new' } });
    const r = await refreshGDriveToken('gd-app', 's', 'r');
    expect(r.expiresAt! - Date.now()).toBeGreaterThan(3500 * 1000);
  });

  it('surfaces the provider body on failure', async () => {
    stub.route(GOOGLE_TOKEN, { status: 401, text: 'invalid_client' });
    await expect(refreshGDriveToken('gd-app', 'wrong', 'r')).rejects.toThrow(/invalid_client/);
  });
});

describe('refreshOneDriveToken', () => {
  it('carries the ROTATED refresh token back — Microsoft invalidates the old one', async () => {
    // Unlike Dropbox and Google, Microsoft returns a new refresh token on every exchange. Dropping
    // it means the next refresh fails and the destination silently disconnects.
    const r = await refreshOneDriveToken('od-app', 'tenant', 'old-refresh');
    expect(r.refreshToken).toBe('od-rotated');
    expect(r.accessToken).toBe('od-new');
    expect(r.expiresAt).toBeGreaterThan(Date.now());
  });
});
