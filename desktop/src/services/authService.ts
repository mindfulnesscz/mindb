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
import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import { invoke } from '@tauri-apps/api/core';
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';

export interface AuthServerConfig { url: string; anonKey: string }
export interface AuthProfile { id: string; name: string; role: string }

/** Roles allowed to operate the desktop app. */
export const DESKTOP_ROLES = ['editor', 'admin'];

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

let client: SupabaseClient | null = null;
let clientKey = '';
let authSubscription: { unsubscribe: () => void } | null = null;

/* The signed-in session's current access token, kept fresh by supabase-js's
 * auto-refresh via onAuthStateChange. The pipeline attaches this to every
 * PostgREST request — the service-role key no longer exists desktop-side
 * (authentication-plan Phase 3). */
let currentAccessToken: string | null = null;

export function getCurrentAccessToken(): string | null {
  return currentAccessToken;
}

export function initAuthClient(config: AuthServerConfig): SupabaseClient {
  const key = `${config.url}::${config.anonKey}`;
  if (client && clientKey === key) return client;
  // Tear the previous environment's client down — its auto-refresh timers and
  // listeners otherwise keep running and can contend with the new instance
  // (symptom: getSession() hangs on environment switch → endless boot screen).
  if (client) {
    authSubscription?.unsubscribe();
    authSubscription = null;
    try { client.auth.stopAutoRefresh(); } catch { /* already stopped */ }
  }
  client = createClient(config.url, config.anonKey, {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  clientKey = key;
  currentAccessToken = null;
  const { data } = client.auth.onAuthStateChange((_event, session) => {
    currentAccessToken = session?.access_token ?? null;
  });
  authSubscription = data.subscription;
  // Prime the token from a persisted session without waiting for the listener.
  client.auth.getSession().then(({ data }) => {
    currentAccessToken = data.session?.access_token ?? currentAccessToken;
  }).catch(() => { /* signed out */ });
  return client;
}

export function getAuthClient(): SupabaseClient | null {
  return client;
}

/* ── Auth server config persistence ─────────────────────────────────────── */

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

export type EmailAuthType = 'staff' | 'whitelisted' | 'returning' | 'unknown';

export async function checkEmail(email: string): Promise<EmailAuthType> {
  if (!client) throw new Error('Auth client not initialized');
  const { data, error } = await client.rpc('check_email_auth', { p_email: email });
  if (error) throw new Error(error.message);
  return data as EmailAuthType;
}

export async function sendMagicLink(email: string): Promise<void> {
  if (!client) throw new Error('Auth client not initialized');
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: AUTH_CALLBACK_URL, shouldCreateUser: false },
  });
  if (error) throw new Error(error.message);
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
  await client.auth.signOut();
}
