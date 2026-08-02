import type { SupabaseConfig } from './rest';
import { makeHeaders, sbFetch } from './rest';

export interface StreamUploadResult {
  stream_uid: string;
  /* Stream's own encoding state, verbatim. Only `ready` means the delivery URLs resolve — a fresh
     upload is `queued` or `inprogress` for as long as the encode takes. */
  stream_status: string;
  /** True when the asset already had a video and this call returned it untouched. */
  reused?: boolean;
  /** Whether the video is protected by `requireSignedURLs`. False only for `public` assets. */
  signed?: boolean;
  /** The uid this upload superseded and deleted, when `replace` was asked for. */
  replaced?: string | null;
}

/* Hands an asset's video master to Cloudflare Stream.
 *
 * The upload is a PULL: the function presigns the R2 master and Stream fetches it. Nothing streams
 * through the desktop, so this call returns in about a second regardless of file size, and the
 * encode continues afterwards. Poll `stream_status` for readiness rather than expecting this to
 * block until the video plays.
 */
export async function requestStreamUpload(
  config: SupabaseConfig, assetId: string, opts: { replace?: boolean } = {},
): Promise<StreamUploadResult> {
  const res = await sbFetch(`${config.url}/functions/v1/stream-upload`, {
    method:  'POST',
    headers: await makeHeaders(config.anonKey),
    body:    JSON.stringify({ asset_id: assetId, replace: opts.replace ?? false }),
  });
  if (!res.ok) {
    const body = await res.text();
    // Same split as requestR2Grant: the function reports its own refusals in `error`, while the API
    // gateway reports upstream trouble in `message`. Without naming the difference, an edge runtime
    // that is simply not up reads as a video-provisioning problem and sends you to the wrong place.
    let msg = body, gateway = false;
    try {
      const parsed = JSON.parse(body) as { error?: string; message?: string };
      if (parsed.error) msg = parsed.error;
      else if (parsed.message) { msg = parsed.message; gateway = true; }
    } catch { /* raw body */ }
    if (gateway || res.status === 502 || res.status === 504) {
      throw new Error(
        `Video upload unreachable (${res.status}): ${msg} — the stream-upload function did not respond. `
        + `Locally, check the edge runtime is running (\`docker start supabase_edge_runtime_<project>\`).`,
      );
    }
    throw new Error(`Video upload refused (${res.status}): ${msg}`);
  }
  return await res.json<StreamUploadResult>();
}
