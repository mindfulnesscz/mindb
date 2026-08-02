/* Video playback — Cloudflare Stream's own player in an iframe.
 *
 * The iframe is deliberate rather than lazy. It brings adaptive bitrate, buffering, captions,
 * keyboard control, picture-in-picture and fullscreen, none of which is the interesting part of
 * this product, and all of which would otherwise be ours to maintain. hls.js is the alternative and
 * only earns its place when the controls themselves need to be custom.
 *
 * THREE STATES, and conflating them is how this looks broken:
 *   - no video          → nothing to render here at all
 *   - encoding          → a placeholder, because every URL built from the uid 404s until `ready`
 *   - ready, but gated and tokenless → also a placeholder, NOT a player, because the player would
 *     load and then fail with a 401 that looks like a dead video rather than a missing permission
 */

import type { Asset } from '@dc-hub/asset-library'
import { isStreamReady } from '@dc-hub/domain'
import { useStreamMediaFor } from './hooks/useStreamMedia'
import { freshStreamStatus } from '../../services/streamTokens'

export function StreamPlayer({ asset, accent }: { asset: Asset; accent: string }) {
  const media = useStreamMediaFor(asset)

  if (!asset.streamUid) return null

  if (!media) {
    /* Encoding, or waiting on a token. Both are transient and neither is the viewer's problem, so
       they read the same: the asset is here, the video is not playable yet. Reusing the grid's
       resting tone rather than inventing an error state for something that fixes itself. */
    /* The override, not the row: `stream_status` is written once at upload and the row the page
       fetched is stale for the length of the encode. Reading it alone is what left a finished
       video saying "processing". */
    const encoding = !isStreamReady(freshStreamStatus(asset.id) ?? asset.streamStatus)
    return (
      <div
        className="aspect-video w-full rounded-sm overflow-hidden flex items-center justify-center"
        style={{ backgroundColor: `color-mix(in srgb, ${accent} 10%, #000)` }}
      >
        <p className="text-[11px] font-sans uppercase tracking-label text-clear-white/60">
          {encoding ? 'Video processing' : 'Video unavailable'}
        </p>
      </div>
    )
  }

  return (
    <div className="aspect-video w-full rounded-sm overflow-hidden bg-black">
      <iframe
        src={media.iframe()}
        title={asset.name}
        className="w-full h-full border-0"
        /* Stream's player needs these to offer fullscreen and picture-in-picture; without the
           allow list the controls render and then do nothing when pressed. */
        allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;"
        allowFullScreen
      />
    </div>
  )
}
