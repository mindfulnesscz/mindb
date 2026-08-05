/* Desktop authentication — Supabase magic link with PKCE over a loopback callback.
 *
 * The desktop signs in as a real portal user (same Auth project, profiles, and
 * roles as the web app). Flow, per docs/pages/desktop/authentication-plan.mdx:
 *   email → check_email_auth (staff only) → signInWithOtp (PKCE) → user clicks
 *   the emailed link in their browser → Supabase redirects to the loopback
 *   listener (wait_for_oauth_redirect, :7623) with ?code= → the webview, which
 *   holds the PKCE verifier, exchanges the code for a session.
 *
 * The auth server (URL + anon key) is app-level config persisted in its own
 * file — it must be available before any sign-in and is not a pipeline setting.
 * Only the anon key is stored here; it is a public value by design.
 */
import type { Session } from '@supabase/supabase-js';
import {
  createAuthClient,
  checkEmailAuth,
  sendMagicLink as sendMagicLinkCore,
  signOut as signOutCore,
  type SottoClient,
  type EmailAuthType,
} from '@sotto/auth';
import { invoke } from '@tauri-apps/api/core';
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';

export interface AuthServerConfig { url: string; anonKey: string }
export interface AuthProfile { id: string; name: string; role: string }

/** Roles allowed to operate the desktop app. */
export const DESKTOP_ROLES = ['editor', 'admin', 'super_admin'];

export const AUTH_CALLBACK_URL = 'http://localhost:7623/auth-callback';

const AUTH_TIMEOUT_MS = 12_000;

/** Reject when a Supabase auth/network call stalls (common on env switch to an
 * unreachable or misconfigured production URL — without this the boot gate
 * shows "Connecting…" forever). */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} timed out — check the environment URL, anon key, and network.`)),
        ms,
      );
    }),
  ]);
}

let client: SottoClient | null = null;
let clientKey = '';
let authSubscription: { unsubscribe: () => void } | null = null;
let currentAccessToken: string | null = null;

/**
 * A token that is valid *now*.
 *
 * `client.auth.getSession()` checks the expiry and silently refreshes when needed, which the cached
 * string above cannot do. This is why the CDN grant used to fail with
 * "Storage grant refused (401): Not authenticated" on a second pipeline run: the first run happened
 * within the hour, the second did not, and every request still carried the original token.
 *
 * Falls back to the cached value if the lookup fails, so a transient network blip degrades to
 * "try the old token" rather than "not signed in".
 */
export async function getAccessToken(opts: { forceRefresh?: boolean } = {}): Promise<string | null> {
  if (!client) return null;
  try {
    if (opts.forceRefresh) {
      const { data, error } = await withTimeout(
        client.auth.refreshSession(), AUTH_TIMEOUT_MS, 'Session refresh',
      );
      if (!error && data.session) currentAccessToken = data.session.access_token;
      return currentAccessToken;
    }
    const { data, error } = await withTimeout(
      client.auth.getSession(), AUTH_TIMEOUT_MS, 'Session lookup',
    );
    if (!error && data.session) currentAccessToken = data.session.access_token;
    return currentAccessToken;
  } catch {
    return currentAccessToken;
  }
}

function authStorageKey(url: string): string {
  const host = url.replace(/^https?:\/\//, '').replace(/[:./]/g, '_');
  return `sotto-auth-${host}`;
}

/**
 * Carry a session across the storage-key rename, once, so the Sotto rename does not sign everyone
 * out of every environment they had configured.
 *
 * supabase-js keeps the session under `storageKey`; changing that key alone makes a signed-in
 * operator look signed out, with a working session still sitting in storage under the old name. The
 * old entry is removed after the copy so this cannot resurrect a stale session later.
 */
function migrateLegacyAuthSession(url: string): void {
  const host = url.replace(/^https?:\/\//, '').replace(/[:./]/g, '_');
  const legacy = `dc-hub-auth-${host}`;
  const current = authStorageKey(url);
  try {
    if (localStorage.getItem(current) !== null) return; // already migrated, or a fresh sign-in
    const stored = localStorage.getItem(legacy);
    if (stored === null) return;
    localStorage.setItem(current, stored);
    localStorage.removeItem(legacy);
  } catch {
    // Storage unavailable (private mode, disabled). A re-sign-in is the fallback, not a crash.
  }
}

function teardownAuthClient(): void {
  authSubscription?.unsubscribe();
  authSubscription = null;
  currentAccessToken = null;
  if (client) {
    try { client.auth.stopAutoRefresh(); } catch { /* already stopped */ }
  }
  client = null;
  clientKey = '';
}

function mountAuthClient(config: AuthServerConfig): SottoClient {
  // Desktop flow: detectSessionInUrl false — the Rust loopback listener
  // captures the ?code= and waitForMagicLink() exchanges it manually. A
  // per-environment storageKey keeps sessions from colliding across projects.
  migrateLegacyAuthSession(config.url);
  client = createAuthClient(
    { url: config.url, anonKey: config.anonKey },
    { detectSessionInUrl: false, storageKey: authStorageKey(config.url) },
  );
  clientKey = `${config.url}::${config.anonKey}`;
  const { data } = client.auth.onAuthStateChange((_event, session) => {
    currentAccessToken = session?.access_token ?? null;
  });
  authSubscription = data.subscription;
  // Start the background refresh explicitly. supabase-js ties its automatic ticker to browser
  // visibility events, which a Tauri webview does not deliver the same way — and teardown already
  // called stopAutoRefresh(), so nothing was ever running to stop. Without this the session simply
  // expired after an hour and every request 401'd.
  try { client.auth.startAutoRefresh(); } catch { /* unsupported in this environment */ }
  return client;
}

export function initAuthClient(config: AuthServerConfig): SottoClient {
  const key = `${config.url}::${config.anonKey}`;
  if (client && clientKey === key) return client;
  teardownAuthClient();
  return mountAuthClient(config);
}

/** Tear down the previous project's session storage lock before switching
 * environments — without this, getSession() can stall indefinitely. */
export async function switchAuthClient(config: AuthServerConfig): Promise<SottoClient> {
  const key = `${config.url}::${config.anonKey}`;
  if (client && clientKey === key) return client;

  const previous = client;
  teardownAuthClient();

  if (previous) {
    try {
      await withTimeout(previous.auth.signOut({ scope: 'local' }), 4_000, 'Sign out');
    } catch { /* best-effort — proceed with new client */ }
  }

  return mountAuthClient(config);
}

export function getAuthClient(): SottoClient | null {
  return client;
}

async function authConfigPath(): Promise<string> {
  return await join(await appDataDir(), 'auth-server.json');
}

export async function loadAuthServer(): Promise<AuthServerConfig | null> {
  try {
    const path = await authConfigPath();
    if (!(await exists(path))) return null;
    const raw = JSON.parse(await readTextFile(path));
    if (typeof raw.url === 'string' && typeof raw.anonKey === 'string' && raw.url && raw.anonKey) {
      return { url: raw.url, anonKey: raw.anonKey };
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveAuthServer(config: AuthServerConfig): Promise<void> {
  const dir = await appDataDir();
  try { await mkdir(dir, { recursive: true }); } catch { /* exists */ }
  await writeTextFile(await authConfigPath(), JSON.stringify(config, null, 2));
}

/* ── Sign-in flow ────────────────────────────────────────────────────────── */

export type { EmailAuthType };

export async function checkEmail(email: string): Promise<EmailAuthType> {
  if (!client) throw new Error('Auth client not initialized');
  return checkEmailAuth(client, email);
}

export async function sendMagicLink(email: string): Promise<void> {
  if (!client) throw new Error('Auth client not initialized');
  await sendMagicLinkCore(client, email, {
    emailRedirectTo: AUTH_CALLBACK_URL,
    shouldCreateUser: false,
  });
}

/** Blocks until the user clicks the emailed link (3-minute listener timeout),
 * then exchanges the PKCE code for a session. Must be called in the same
 * webview session that called sendMagicLink — that's where the verifier lives. */
export async function waitForMagicLink(): Promise<Session> {
  if (!client) throw new Error('Auth client not initialized');
  const path = await invoke<string>('wait_for_oauth_redirect');
  const query = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
  const code = new URLSearchParams(query).get('code');
  if (!code) {
    const err = new URLSearchParams(query).get('error_description');
    throw new Error(err || 'The sign-in link did not carry an auth code.');
  }
  const { data, error } = await client.auth.exchangeCodeForSession(code);
  if (error) throw new Error(error.message);
  if (!data.session) throw new Error('No session returned from code exchange.');
  return data.session;
}

export async function getSession(): Promise<Session | null> {
  if (!client) return null;
  try {
    const { data, error } = await withTimeout(client.auth.getSession(), AUTH_TIMEOUT_MS, 'Session lookup');
    if (error) return null;
    return data.session;
  } catch {
    return null;
  }
}

/** The authoritative role check — the profile row, read under the user's own
 * JWT (RLS: own row readable). check_email_auth is only the pre-flight. */
export async function loadProfile(): Promise<AuthProfile> {
  if (!client) throw new Error('Auth client not initialized');
  const { data: userData, error: userErr } = await withTimeout(
    client.auth.getUser(),
    AUTH_TIMEOUT_MS,
    'User lookup',
  );
  if (userErr || !userData.user) throw new Error(userErr?.message ?? 'No user');
  const profileQuery = client
    .from('profiles')
    .select('id,name,role')
    .eq('id', userData.user.id)
    .single();
  const { data, error } = await withTimeout(
    Promise.resolve(profileQuery),
    AUTH_TIMEOUT_MS,
    'Profile lookup',
  );
  if (error) throw new Error(error.message);
  return data as AuthProfile;
}

export async function signOut(): Promise<void> {
  if (!client) return;
  await signOutCore(client);
}
