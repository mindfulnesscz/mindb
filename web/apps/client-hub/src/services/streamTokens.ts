/* Signed Stream URLs — the video equivalent of the CDN cookie.
 *
 * Images solve this with an HttpOnly cookie the browser attaches to every request. Video cannot:
 * Stream is a different registrable domain, so no cookie of ours reaches it, and its own scheme
 * puts the credential IN THE PATH. So each gated video needs a token minted for it, and every URL
 * for that video — still, animated preview, player — is built from the token instead of the uid.
 *
 * The consequence to design around: a missing token is not an error, it is a blank card. Nothing
 * throws, no request fails visibly, the `<img>` just 401s. Everything here is arranged so that the
 * portal asks for tokens before it renders rather than discovering the gap afterwards.
 */

import { supabase } from '../lib/supabase'
import { reportError } from '../lib/reportError'

interface CachedToken {
  token: string
  /** Epoch milliseconds. */
  expiresAt: number
}

/* Module-scope, so a token minted for the grid is reused by the detail view and the lightbox
   instead of being re-minted on every mount. Cleared on sign-out. */
const cache = new Map<string, CachedToken>()

/* One in-flight request per asset id, so ten cards mounting at once produce one network call
   rather than ten. Without this a grid re-render storms the function. */
let inFlight: Promise<void> | null = null
let pending = new Set<string>()

/** Renew a little before expiry — a token that dies mid-scroll is a wall of broken images. */
const EARLY_RENEW_MS = 5 * 60_000

export function streamDomain(): string | null {
  const d = import.meta.env.VITE_STREAM_DOMAIN as string | undefined
  return d ? d.replace(/\/+$/, '') : null
}

/** The token for a video, if one has been minted and is still good. */
export function cachedStreamToken(uid: string): string | null {
  const hit = cache.get(uid)
  if (!hit) return null
  if (hit.expiresAt - EARLY_RENEW_MS <= Date.now()) {
    cache.delete(uid)
    return null
  }
  return hit.token
}

export function clearStreamTokens(): void {
  cache.clear()
  pending.clear()
}

/**
 * Mint tokens for these assets, batched.
 *
 * Callers pass ASSET ids rather than video uids: the function resolves uids through RLS, so the
 * portal never has to decide what a caller may see — and could not be trusted to, since it is the
 * side of the wire the caller controls.
 *
 * Resolves when the tokens are in the cache. Never throws: a portal that cannot mint should show
 * what it can, exactly as it does when the CDN cookie fails.
 */
export async function ensureStreamTokens(assetIds: string[]): Promise<void> {
  for (const id of assetIds) pending.add(id)
  if (inFlight) return inFlight

  inFlight = (async () => {
    // Yield once so every caller mounting in the same tick joins this batch rather than the next.
    await Promise.resolve()
    const ids = [...pending]
    pending = new Set()
    // Unconfigured Supabase is the portal's mock mode, not a fault — same treatment as everywhere
    // else: do nothing quietly and let the placeholder stand.
    if (!ids.length || !supabase) return

    try {
      const { data, error } = await supabase.functions.invoke<{
        tokens: Record<string, string>
        expires_at: number
      }>('stream-token', { body: { asset_ids: ids } })
      if (error) throw error
      for (const [uid, token] of Object.entries(data?.tokens ?? {})) {
        cache.set(uid, { token, expiresAt: data!.expires_at })
      }
    } catch (e) {
      // `cdn.` because this is delivery authorization — the same concern as the gate cookie, just
      // for the host that will not take a cookie.
      reportError('cdn.ensureStreamTokens', e)
    }
  })()

  try { await inFlight } finally { inFlight = null }
  // A second batch accumulated while this one was in flight — drain it rather than lose it.
  if (pending.size) await ensureStreamTokens([])
}
