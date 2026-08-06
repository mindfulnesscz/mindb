/* Read a backend's own error message, and notice when the session behind it is dead.
 *
 * Two problems, one place, because they show up together.
 *
 * ── The message ──────────────────────────────────────────────────────────────
 * `functions.invoke` reports any non-2xx as a generic `FunctionsHttpError` and puts the body out of
 * reach on `error.context`. Without reading it, every cause — unprovisioned storage, a refused role,
 * a blown blast-radius gate — arrives as "Edge Function returned a non-2xx status code".
 *
 * ── The dead session ─────────────────────────────────────────────────────────
 * An access token stays signature-valid and unexpired after its session row is revoked (a password
 * change, a sign-out in another tab, a wiped local database). The edge gateway forwards it, and
 * PostgREST keeps answering reads off it — so the portal renders a name in the header and lists
 * clients — while every function that resolves the caller through GoTrue refuses it. The result is a
 * page that says "Not authenticated" underneath a header that says who you are, which reads as a bug
 * in that page. Every backend now names the case — the edge functions and the cdn-gate Worker both
 * answer `code: SESSION_INVALID` — and this turns that answer into an actual sign-out.
 *
 * The vocabulary is IMPORTED, never spelled out here. A literal that drifted from what the backends
 * send would make this quietly stop working, which is the failure it exists to prevent. See
 * `packages/domain/src/callerAuth.ts`.
 */

import { SESSION_INVALID } from '@sotto/domain'

/** Set by AuthProvider. Module-level for the same reason as the error sink: services call this from
 *  outside React, and threading a callback through every one of them buys nothing. */
let sessionEnded: (() => void) | null = null

/** Register what happens when a backend reports the caller's session is gone. Null to clear. */
export function configureSessionEndedHandler(handler: (() => void) | null): void {
  sessionEnded = handler
}

/** Signal a dead session from a caller that reads its own response — see `cdnGate.ts`. */
export function reportSessionEnded(): void {
  sessionEnded?.()
}

interface EdgeErrorBody {
  error?: string
  code?: string
}

/**
 * The function's own `error` message, or null if the failure carried none (a network error, a body
 * that is not ours). Signs the operator out as a side effect when the function says the session is
 * no longer valid — that is a state the portal cannot render its way out of.
 */
export async function edgeFunctionError(error: unknown): Promise<string | null> {
  const response = (error as { context?: Response })?.context
  if (!response || typeof response.json !== 'function') return null
  let body: EdgeErrorBody
  try {
    body = await response.json() as EdgeErrorBody
  } catch {
    return null
  }
  /* Strictly on the code, never on the 401 alone: an anonymous caller and a caller whose key was
     refused also get 401s, and signing someone out over those would be its own bug. */
  if (body?.code === SESSION_INVALID) reportSessionEnded()
  return body?.error ?? null
}
