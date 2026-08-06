/* The CDN cookie — how the portal gets permission to load gated bytes.
 *
 * Gated thumbnails and originals are served by the cdn-gate Worker, which authorizes from a signed
 * cookie scoped to the registrable domain the portal and the CDN share. The portal's job is small
 * and entirely about timing: obtain the cookie when a session appears, drop it on sign-out, and
 * renew it comfortably before it lapses.
 *
 * Why the timing matters more than it sounds: `<img>` tags cannot retry meaningfully, so a cookie
 * that expires mid-scroll turns a gallery into a wall of broken images that only a reload fixes.
 * The refresh therefore fires at three quarters of the token's life, not at the end of it.
 *
 * The cookie itself is HttpOnly and never visible to this code. Nothing here reads a token; the
 * only observable effect is that later `<img>` and download requests to the gate succeed.
 */

import { SESSION_INVALID } from '@sotto/domain'
import { reportError } from '../lib/reportError'
import { reportSessionEnded } from '../lib/edgeFunction'

export interface CdnGrant {
  /** Highest level this session may fetch: guest | client | internal. */
  level: string
  client_id: string | null
  /** Epoch milliseconds. */
  expires_at: number
}

/**
 * Base URL of the gate, e.g. `https://files.disruptcollective.com`.
 *
 * Absent is a supported state, not a misconfiguration: before the Worker is deployed — and on any
 * `*.vercel.app` preview, where a cookie for the production domain is never sent anyway — the
 * portal simply runs without gated delivery. Failing loudly here would break every preview build
 * for a feature that cannot work on one.
 */
export function cdnGateUrl(): string | null {
  const url = import.meta.env.VITE_CDN_GATE_URL as string | undefined
  return url ? url.replace(/\/+$/, '') : null
}

/**
 * Does this URL belong to the gated CDN, and therefore need the cookie sent with it?
 *
 * This has to be asked per URL rather than answered once, because `credentials: 'include'` is not
 * a harmless addition: a response carrying `Access-Control-Allow-Origin: *` is REJECTED outright by
 * the browser when the request was credentialed. The public R2 buckets are all configured with a
 * wildcard origin, so sending credentials to them turns a working download into a CORS failure —
 * silently, with the only symptom being that the save dialog becomes a new browser tab.
 *
 * So: credentials go to the gate, which echoes an exact origin, and nowhere else.
 */
export function isGatedUrl(url: string): boolean {
  const base = cdnGateUrl()
  if (!base) return false
  try {
    return new URL(url, window.location.href).origin === new URL(base).origin
  } catch {
    return false
  }
}

/**
 * When to renew, in milliseconds from now.
 *
 * Three quarters of the remaining life, so a single failed attempt still has a quarter of the TTL
 * to succeed in. Floored at 30s so a short or already-stale token cannot spin, and clamped to a
 * 30-minute ceiling so a long TTL still gets a periodic re-check against the caller's real role —
 * a member promoted to editor should not wait out an eight-hour cookie for their new access.
 */
export function refreshDelayMs(expiresAt: number, now: number = Date.now()): number {
  const remaining = expiresAt - now
  if (remaining <= 0) return 30_000
  return Math.min(Math.max(remaining * 0.75, 30_000), 30 * 60_000)
}

/** The gate's own `code` from a refusal body, or null when it did not send one. */
function refusalCode(body: string): string | null {
  try {
    return (JSON.parse(body) as { code?: string }).code ?? null
  } catch {
    return null
  }
}

/**
 * Trade a Supabase access token for the cookie. `credentials: 'include'` is required in both
 * directions — without it the browser discards the Set-Cookie, silently, and every subsequent
 * image 403s with nothing in the network log to explain why.
 *
 * Returns null on any failure. A portal that cannot get the cookie should degrade to showing what
 * it can rather than blocking sign-in on a CDN.
 */
export async function requestCdnCookie(accessToken: string): Promise<CdnGrant | null> {
  const base = cdnGateUrl()
  if (!base) return null
  try {
    const res = await fetch(`${base}/auth`, {
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      // 503 means the gate exists but is not provisioned — worth distinguishing in the log from a
      // refusal, because they are fixed in completely different places.
      const detail = await res.text()
      /* A revoked session is the one refusal retrying cannot fix, and this is the caller that would
         retry it hardest: useCdnCookie renews on a timer for as long as the tab is open, so without
         this the operator sits on a wall of blank gated thumbnails indefinitely. The gate names the
         case with the same code the edge functions use — see packages/domain/src/callerAuth.ts.
         Parsed rather than substring-matched: the body may be a proxy's HTML on a bad day. */
      if (refusalCode(detail) === SESSION_INVALID) reportSessionEnded()
      reportError('cdn.requestCdnCookie', new Error(`CDN gate ${res.status}: ${detail}`))
      return null
    }
    return (await res.json()) as CdnGrant
  } catch (e) {
    reportError('cdn.requestCdnCookie', e)
    return null
  }
}

/** Drop the cookie on sign-out. Best-effort: the token expires on its own regardless. */
export async function clearCdnCookie(): Promise<void> {
  const base = cdnGateUrl()
  if (!base) return
  try {
    await fetch(`${base}/auth`, { method: 'DELETE', credentials: 'include' })
  } catch (e) {
    reportError('cdn.clearCdnCookie', e)
  }
}
