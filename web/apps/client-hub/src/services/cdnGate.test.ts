/* Refresh timing for the CDN cookie.
 *
 * Worth its own test because both failure modes are invisible in development, where a session is
 * minutes old and a token never lapses: refresh too late and a gallery becomes a wall of broken
 * images mid-scroll that only a reload fixes; refresh in a tight loop and every viewer hammers the
 * gate for the length of their visit.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { refreshDelayMs, isGatedUrl } from './cdnGate'

const NOW = 1_775_000_000_000
const MIN = 60_000

describe('refreshDelayMs', () => {
  it('renews at three quarters of the remaining life', () => {
    // Leaves a full quarter of the TTL for a failed attempt to be retried in.
    expect(refreshDelayMs(NOW + 30 * MIN, NOW)).toBe(22.5 * MIN)
    expect(refreshDelayMs(NOW + 20 * MIN, NOW)).toBe(15 * MIN)
  })

  it('never returns less than 30 seconds, however stale the token', () => {
    // The spin guard. An expired or nearly-expired token must not schedule an immediate retry.
    expect(refreshDelayMs(NOW + 10_000, NOW)).toBe(30_000)
    expect(refreshDelayMs(NOW, NOW)).toBe(30_000)
    expect(refreshDelayMs(NOW - 60 * MIN, NOW)).toBe(30_000)
    expect(refreshDelayMs(0, NOW)).toBe(30_000)
  })

  it('re-checks at least every 30 minutes, however long the TTL', () => {
    // The cookie carries the caller's role. A member promoted to editor should not have to wait
    // out an eight-hour token before their new access takes effect.
    expect(refreshDelayMs(NOW + 8 * 60 * MIN, NOW)).toBe(30 * MIN)
    expect(refreshDelayMs(NOW + 365 * 24 * 60 * MIN, NOW)).toBe(30 * MIN)
  })
})

/* Which URLs may be fetched with credentials.
 *
 * This is not a nicety. `credentials: 'include'` against a response carrying
 * `Access-Control-Allow-Origin: *` is REJECTED by the browser, and all three public R2 buckets are
 * configured with a wildcard origin. Sending credentials to them breaks every download in the
 * library, and breaks it quietly — the fetch fails CORS, the catch opens a new tab, and the only
 * user-visible symptom is that the save dialog stopped appearing.
 */
describe('isGatedUrl', () => {
  const setGate = (url: string | undefined) => {
    vi.stubEnv('VITE_CDN_GATE_URL', url as string)
    vi.stubGlobal('window', { location: { href: 'https://hub.disruptcollective.com/' } })
  }
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('is true only for the gate origin', () => {
    setGate('https://files.disruptcollective.com')
    expect(isGatedUrl('https://files.disruptcollective.com/client/x/y.webp')).toBe(true)
    expect(isGatedUrl('https://files.disruptcollective.com/a/b/c.mp4?v=abc123')).toBe(true)
  })

  it('is false for the PUBLIC CDN — the wildcard-CORS case this exists to protect', () => {
    setGate('https://files.disruptcollective.com')
    expect(isGatedUrl('https://cdn.disruptcollective.com/client/x/y.webp')).toBe(false)
    expect(isGatedUrl('https://pub-714fd704.r2.dev/client/x/y.webp')).toBe(false)
    // A lookalike host must not match on a prefix.
    expect(isGatedUrl('https://files.disruptcollective.com.evil.test/x')).toBe(false)
  })

  it('is false for third-party cloud share links', () => {
    setGate('https://files.disruptcollective.com')
    expect(isGatedUrl('https://www.dropbox.com/s/abc/deck.pdf')).toBe(false)
  })

  it('is false when no gate is configured, and never throws on junk', () => {
    setGate(undefined)
    expect(isGatedUrl('https://files.disruptcollective.com/x')).toBe(false)
    setGate('https://files.disruptcollective.com')
    expect(isGatedUrl('not a url at all')).toBe(false)
    expect(isGatedUrl('')).toBe(false)
  })
})
