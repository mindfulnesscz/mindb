/* Ask the backend to move an asset's bytes to the key its access level now requires.
 *
 * The level is encoded in the R2 object key — that is what lets the CDN Worker authorize a request
 * without a database lookup — so changing `perm` or `status` has to physically move the object.
 * A database trigger queues that work the moment the row changes; this is what drains the queue
 * promptly instead of leaving it for the next person who happens to call.
 *
 * Deliberately sends NO asset ids, even though the caller knows exactly what it just changed.
 * Setting a gallery's level cascades to every child through a database trigger, and the portal
 * never learns those ids — naming only the row it edited would move the parent and leave the
 * children behind, which is the empty-grid bug all over again. Draining the queue catches whatever
 * the change actually touched.
 *
 * Best-effort by design: the queue is durable, so a failure here delays the move rather than losing
 * it. The next edit, or the next pipeline run, picks it up. That is why nothing is thrown at the
 * caller — a visibility change that succeeded must not report failure because a follow-up call did.
 */

import { supabase } from '../lib/supabase'
import { reportError } from '../lib/reportError'
import { edgeFunctionError } from '../lib/edgeFunction'

export interface ReconcileResult {
  moved: number
  skipped: number
  failed: number
  remaining: number
}

export async function reconcileCdnObjects(): Promise<ReconcileResult | null> {
  if (!supabase) return null
  try {
    // `functions.invoke` carries the current session, which is what the function authorizes on —
    // it is staff-only, and no callback secret is stored anywhere as a result.
    const { data, error } = await supabase.functions.invoke('cdn-reconcile', { body: {} })
    if (error) {
      // Reading the body is also what notices a revoked session — otherwise the queue would just
      // stop draining, silently, for as long as the tab stayed open. See edgeFunction.ts.
      const detail = await edgeFunctionError(error)
      reportError('cdn.reconcileCdnObjects', detail ? new Error(detail) : error)
      return null
    }
    return data as ReconcileResult
  } catch (e) {
    reportError('cdn.reconcileCdnObjects', e)
    return null
  }
}
