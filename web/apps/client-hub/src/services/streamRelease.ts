/* Give a video back to Cloudflare when its asset is deleted.
 *
 * Stream storage is billed per minute held, whether or not anything points at the video. So a row
 * with a `stream_uid` cannot simply be DELETEd: the row is the only record of which video belonged
 * to it, and once it is gone the video is unattributable — it sits in the account forever, costing
 * money, with nothing left to say what it was or whether it is safe to remove.
 *
 * Hence release-then-delete, in that order, and a failure here is REPORTED rather than swallowed.
 * The opposite order (delete the row, then release) has no failure it can recover from.
 *
 * The account is shared between staging and production — Stream has no equivalent of the two R2
 * buckets — which is the other reason this goes through the edge function instead of the browser:
 * deleting from Stream needs the account token, and that token can delete production's videos too.
 */

import { supabase } from '../lib/supabase'

/** Raised when the video could not be released, so the caller can offer to proceed anyway. */
export class StreamReleaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StreamReleaseError'
  }
}

/**
 * Delete an asset's Stream video and clear the columns that referenced it.
 *
 * Idempotent: a uid Cloudflare no longer knows counts as released, because the goal is "no video
 * left behind", not "a delete was performed".
 */
export async function releaseStreamVideo(assetId: string): Promise<void> {
  if (!supabase) throw new StreamReleaseError('Supabase not configured')
  const { data, error } = await supabase.functions.invoke('stream-upload', {
    body: { asset_id: assetId, release: true },
  })
  if (error) {
    /* functions.invoke reports a non-2xx as a generic FunctionsHttpError and puts the body out of
       reach, so the function's own message — which is the only thing that says WHY — has to be read
       off the response. Without this the operator sees "Edge Function returned a non-2xx status
       code", which is true of every possible cause. */
    const detail = await readFunctionError(error)
    throw new StreamReleaseError(detail ?? error.message)
  }
  const body = data as { released?: boolean; error?: string } | null
  if (body?.error) throw new StreamReleaseError(body.error)
}

async function readFunctionError(error: unknown): Promise<string | null> {
  const res = (error as { context?: Response })?.context
  if (!res || typeof res.json !== 'function') return null
  try {
    const body = await res.json() as { error?: string }
    return body?.error ?? null
  } catch {
    return null
  }
}
