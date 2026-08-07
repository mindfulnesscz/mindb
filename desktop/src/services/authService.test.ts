/* The token refresh is SINGLE-FLIGHT, and that is a correctness property, not a tidiness one.
 *
 * `sbFetch` retries a 401 with `getAccessToken({ forceRefresh: true })`, and the Supabase export now
 * writes rows 8-wide. When a session expires mid-run, eight requests 401 at once — and GoTrue rotates
 * the refresh token on use, so a second concurrent `refreshSession()` presents a token that has just
 * been spent. Best case seven of them fail; worst case reuse detection revokes the session the first
 * call had just renewed, and the rest of the run fails as "not signed in". */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const refreshSession = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn(async () => ({ data: { session: null }, error: null })));

vi.mock('@sotto/auth', () => ({
  createAuthClient: () => ({
    auth: {
      refreshSession,
      getSession,
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      startAutoRefresh: () => {},
      stopAutoRefresh: () => {},
    },
  }),
  checkEmailAuth: vi.fn(),
  sendMagicLink: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(), writeTextFile: vi.fn(), exists: vi.fn(async () => false), mkdir: vi.fn(),
}));
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/appdata', join: async (...p: string[]) => p.join('/'),
}));

const { initAuthClient, getAccessToken } = await import('./authService');

const CONFIG = { url: 'https://one.supabase.co', anonKey: 'anon' };

beforeEach(() => {
  refreshSession.mockReset();
  initAuthClient(CONFIG);
});

describe('getAccessToken({ forceRefresh: true })', () => {
  it('refreshes ONCE for N concurrent callers, and hands them all the new token', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    refreshSession.mockImplementation(async () => {
      await held;
      return { data: { session: { access_token: 'fresh' } }, error: null };
    });

    const callers = Array.from({ length: 8 }, () => getAccessToken({ forceRefresh: true }));
    release();

    expect(await Promise.all(callers)).toEqual(Array(8).fill('fresh'));
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it('refreshes again on the NEXT expiry — the memo is per flight, not per session', async () => {
    refreshSession.mockResolvedValueOnce({ data: { session: { access_token: 'first' } }, error: null });
    refreshSession.mockResolvedValueOnce({ data: { session: { access_token: 'second' } }, error: null });

    expect(await getAccessToken({ forceRefresh: true })).toBe('first');
    expect(await getAccessToken({ forceRefresh: true })).toBe('second');
    expect(refreshSession).toHaveBeenCalledTimes(2);
  });

  it('falls back to the last known token when the shared refresh fails, for every caller', async () => {
    refreshSession.mockResolvedValueOnce({ data: { session: { access_token: 'known' } }, error: null });
    await getAccessToken({ forceRefresh: true });

    refreshSession.mockRejectedValue(new Error('network down'));
    const callers = Array.from({ length: 4 }, () => getAccessToken({ forceRefresh: true }));

    expect(await Promise.all(callers)).toEqual(Array(4).fill('known'));
    expect(refreshSession).toHaveBeenCalledTimes(2); // the successful one, then one shared failure
  });
});
