/* The browser's return from an auth redirect — read once, at app level, before any session is trusted.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────────────────────────
 *
 * The portal used to delegate the whole return to `detectSessionInUrl: true` and parse `error=` out
 * of the hash inside two leaf components. That composed into a silent wrong-user state: supabase-js
 * deliberately keeps an existing session when a URL login fails ("A failed attempt (e.g. reused
 * magic link) shouldn't invalidate a valid session" — GoTrueClient `_initialize`), it reports the
 * failure only as the resolved value of an internal promise, and the two `error=` handlers live in
 * components that do not render when a session was restored. A failed sign-in therefore showed the
 * previous user's account, with their tenant and role, and no error anywhere.
 *
 * Worse, `_isPKCECallback` requires a `?code=` AND a stored code-verifier, so a return into a
 * browser without the verifier is not even classified as a callback: it falls straight through to
 * "recover the session from storage".
 *
 * So the exchange is explicit here and its failure is a value. `lib/supabase.ts` builds the client
 * with `detectSessionInUrl: false` — the two must stay in step, or the code is consumed by whichever
 * runs first and the other reports `invalid request: both auth code and code verifier should be
 * non-empty`.
 *
 * Parsing and URL cleanup are pure functions over an href so they are testable without a browser;
 * only `resolveAuthReturn` touches the client.
 */

import type { SottoClient } from '@sotto/auth'

/** Query params GoTrue adds to the app's redirect target. `type` is NOT here on purpose — it is a
 *  gallery filter param (`FILTER_PARAMS.entityTypes`), and stripping it would wipe part of the view
 *  the recipient was sent back to. */
const AUTH_QUERY_PARAMS = ['code', 'error', 'error_code', 'error_description'] as const

export type AuthReturn =
  /** No auth material in the URL — an ordinary page load. */
  | { kind: 'none' }
  /** The provider or GoTrue refused, and said why. */
  | { kind: 'error'; message: string }
  /** A PKCE authorization code waiting to be exchanged. */
  | { kind: 'code'; code: string }

function messageFrom(params: URLSearchParams): string {
  /* URLSearchParams already decodes `+` to a space and percent-escapes, so no hand-rolled decoding.
     Fall back through the machine-readable fields: GoTrue always sends at least one. */
  return (
    params.get('error_description')
    ?? params.get('error_code')
    ?? params.get('error')
    ?? 'Sign-in failed'
  )
}

function hasError(params: URLSearchParams): boolean {
  return params.has('error') || params.has('error_code') || params.has('error_description')
}

/**
 * Classify an auth redirect target. GoTrue uses the **query** for the PKCE code and for errors it
 * raises itself, and the **hash** for errors it forwards from a provider — both are checked, errors
 * first, because a URL carrying both is a failure that happens to still have a code in it.
 */
export function parseAuthReturn(href: string): AuthReturn {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return { kind: 'none' }
  }

  const query = url.searchParams
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''))

  if (hasError(query)) return { kind: 'error', message: messageFrom(query) }
  if (hasError(hash))  return { kind: 'error', message: messageFrom(hash) }

  const code = query.get('code')
  if (code) return { kind: 'code', code }

  return { kind: 'none' }
}

/**
 * The same URL with the auth material removed.
 *
 * **Keeps the query, strips the hash** — and only ever strips a hash that carried auth params. That
 * split is load-bearing: the gallery's filters live in the query and `redirectTo` carries the
 * filtered URL, so dropping the search would silently wipe the view the recipient was being sent
 * back to. A plain `#section` anchor is not ours to remove.
 */
export function cleanAuthUrl(href: string): string {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return href
  }

  for (const name of AUTH_QUERY_PARAMS) url.searchParams.delete(name)
  if (hasError(new URLSearchParams(url.hash.replace(/^#/, '')))) url.hash = ''

  return url.toString()
}

export interface AuthReturnOutcome {
  /** A message to render on the sign-in surface, or null when nothing failed. */
  error: string | null
  /** The href the address bar should show once the return has been consumed. */
  url: string
}

/**
 * Consume the auth return: exchange a code, or turn a failure into a signed-out state plus a message.
 *
 * `signOut({ scope: 'local' })` on failure is the whole point. The stale token in
 * `sb-<ref>-auth-token` outlives a failed return, so without this the caller goes on to restore it
 * and renders the app around whoever last used this browser. Local scope because the failed sign-in
 * says nothing about the *other* session's validity elsewhere — this drops it from this browser only.
 */
export async function resolveAuthReturn(
  client: SottoClient,
  href: string,
): Promise<AuthReturnOutcome> {
  const ret = parseAuthReturn(href)
  if (ret.kind === 'none') return { error: null, url: href }

  const url = cleanAuthUrl(href)

  if (ret.kind === 'error') {
    await client.auth.signOut({ scope: 'local' })
    return { error: ret.message, url }
  }

  try {
    const { error } = await client.auth.exchangeCodeForSession(ret.code)
    if (error) {
      await client.auth.signOut({ scope: 'local' })
      return { error: error.message, url }
    }
  } catch (e) {
    await client.auth.signOut({ scope: 'local' })
    return { error: e instanceof Error ? e.message : String(e), url }
  }

  return { error: null, url }
}
