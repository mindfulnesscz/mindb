/* Keep the CDN cookie alive for as long as there is a session.
 *
 * Deliberately driven by `accessToken` rather than by the session object: Supabase refreshes the
 * access token on its own schedule, and each refresh is a fresh opportunity to re-mint the CDN
 * cookie against the caller's current role. Keying the effect on the token means that happens for
 * free instead of needing its own listener.
 */

import { useEffect, useRef } from 'react'
import { clearCdnCookie, refreshDelayMs, requestCdnCookie } from '../services/cdnGate'

export function useCdnCookie(accessToken: string | undefined): void {
  // Survives the effect's own teardown, so a re-run mid-flight cannot let a stale response
  // schedule a timer for a session that has already gone.
  const generation = useRef(0)

  useEffect(() => {
    const mine = ++generation.current

    if (!accessToken) {
      void clearCdnCookie()
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined

    async function cycle() {
      const grant = await requestCdnCookie(accessToken!)
      if (generation.current !== mine) return
      // No grant means the gate is absent or refused. Retry on the floor delay rather than giving
      // up for the session — a Worker deploy or a transient 502 should heal without a reload.
      timer = setTimeout(cycle, refreshDelayMs(grant?.expires_at ?? 0))
    }
    void cycle()

    return () => {
      generation.current++
      if (timer) clearTimeout(timer)
    }
  }, [accessToken])
}
