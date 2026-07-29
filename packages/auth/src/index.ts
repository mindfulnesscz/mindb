/* @dc-hub/auth — auth logic shared by the web portal and the desktop app.
 *
 * Both clients sign in against the *same* Supabase project, profiles, and roles.
 * What is shared lives here: the typed client factory and the provider-agnostic
 * sign-in calls. What is genuinely platform-specific stays in each app and is
 * passed in as options:
 *   - web returns from the provider by browser redirect, so the client is built
 *     with `detectSessionInUrl: true` and the `?code=` is exchanged on load.
 *   - desktop has no page to return to: a Rust loopback listener captures the
 *     `?code=` and calls `exchangeCodeForSession` manually, so it builds the
 *     client with `detectSessionInUrl: false` and a per-environment storageKey.
 *
 * These functions throw on error (the idiomatic shape). Callers that prefer a
 * soft failure — e.g. the web modal mapping a failed pre-check to 'unknown', or
 * returning an error string instead of throwing — wrap them at the call site.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@dc-hub/database'

/** A typed client bound to the DC Hub schema. */
export type DcHubClient = SupabaseClient<Database>

/** Result of the anonymous `check_email_auth` pre-flight. */
export type EmailAuthType = 'staff' | 'whitelisted' | 'returning' | 'unknown'

/** OAuth providers the portal offers. 'azure' is Microsoft / Entra ID. */
export type OAuthProvider = 'azure' | 'google' | 'github'

export interface AuthClientConfig {
  url: string
  anonKey: string
}

/** Platform-specific client knobs. Everything defaults to the safe portal
 *  values; desktop overrides `detectSessionInUrl` and sets a `storageKey`. */
export interface AuthClientOptions {
  /** web: true (browser exchanges `?code=` on load) · desktop: false. */
  detectSessionInUrl?: boolean
  /** Namespaces the session in storage — desktop uses one per environment. */
  storageKey?: string
  persistSession?: boolean
  autoRefreshToken?: boolean
}

/** Build a typed Supabase client with the shared PKCE defaults. PKCE is what
 *  lets both OAuth and magic-link redirects come back as `?code=` and be
 *  exchanged against a verifier held in this client's storage. */
export function createAuthClient(
  config: AuthClientConfig,
  options: AuthClientOptions = {},
): DcHubClient {
  return createClient<Database>(config.url, config.anonKey, {
    auth: {
      flowType: 'pkce',
      detectSessionInUrl: options.detectSessionInUrl ?? false,
      persistSession: options.persistSession ?? true,
      autoRefreshToken: options.autoRefreshToken ?? true,
      ...(options.storageKey ? { storageKey: options.storageKey } : {}),
    },
  })
}

/** Anonymous pre-flight: which sign-in flow an email should get. Throws on RPC
 *  error. */
export async function checkEmailAuth(client: DcHubClient, email: string): Promise<EmailAuthType> {
  const { data, error } = await client.rpc('check_email_auth', { p_email: email })
  if (error) throw new Error(error.message)
  return (data as EmailAuthType) ?? 'unknown'
}

export interface MagicLinkOptions {
  /** Where Supabase sends the user after they click the emailed link. */
  emailRedirectTo: string
  /** Extra metadata stored on first sign-in (web's unknown-user form). */
  data?: Record<string, string>
  /** Desktop passes false — staff must already exist. */
  shouldCreateUser?: boolean
}

/** Send a magic link / OTP. Throws on error. */
export async function sendMagicLink(
  client: DcHubClient,
  email: string,
  options: MagicLinkOptions,
): Promise<void> {
  const { error } = await client.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: options.emailRedirectTo,
      ...(options.data ? { data: options.data } : {}),
      ...(options.shouldCreateUser === undefined ? {} : { shouldCreateUser: options.shouldCreateUser }),
    },
  })
  if (error) throw new Error(error.message)
}

/** Scopes that guarantee a verified email back from each provider. Azure/Entra
 *  only returns an email when `email` is explicitly requested (its default is
 *  just `openid`); GitHub/Google include it by default but asking is harmless. */
const PROVIDER_SCOPES: Record<OAuthProvider, string> = {
  azure:  'openid email profile',
  google: 'openid email profile',
  github: 'read:user user:email',
}

/** Begin an OAuth sign-in. Throws on error. On success the browser navigates
 *  to the provider, so control does not return to the caller. */
export async function signInWithProvider(
  client: DcHubClient,
  provider: OAuthProvider,
  redirectTo: string,
): Promise<void> {
  const { error } = await client.auth.signInWithOAuth({
    provider,
    options: { redirectTo, scopes: PROVIDER_SCOPES[provider] },
  })
  if (error) throw new Error(error.message)
}

export async function signOut(client: DcHubClient): Promise<void> {
  await client.auth.signOut()
}
