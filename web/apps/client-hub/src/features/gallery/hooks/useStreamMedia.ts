/* Resolving a video asset's Stream URLs, including the token a gated one needs.
 *
 * Kept in a hook rather than in the components because the token arrives ASYNCHRONOUSLY and the
 * components that need it are deliberately presentational. Cards would otherwise each have to
 * fetch, and a grid of ten videos would mint ten tokens for the same view.
 *
 * The failure mode being designed around is quiet: without a token a gated video's still returns
 * 401, which renders as an empty tile. Nothing throws and nothing appears in the console, so the
 * only way to notice is to already know. Hence tokens are requested for the whole visible set up
 * front, and a video with no usable URL yet renders the same placeholder as one still encoding.
 */

import { useEffect, useMemo, useState } from 'react'
import type { Asset } from '@sotto/asset-library'
import {
  isStreamReady, streamStillUrl, streamFrameUrls, streamIframeUrl,
  effectiveLevel, tierFor, type StreamRef,
} from '@sotto/domain'
import {
  ensureStreamTokens, cachedStreamToken, streamDomain, freshStreamStatus, freshStreamDuration,
} from '../../../services/streamTokens'

/* How many frames a hover preview steps through.
 *
 * Ten, because that is what makes a 62-second film legible in a hover: one frame per ~6 seconds.
 * Measured cost on a real video — ten stills spanning the whole thing total 121 KB, against 763 KB
 * for a five-second GIF, so covering everything is also the cheaper option. */
const PREVIEW_FRAMES = 10

/* How often to re-ask while something is still encoding.
 *
 * Encodes run from seconds to minutes depending on length, so a one-shot check would leave a video
 * showing "processing" until the next navigation. Only fires while a NOT-ready video is on screen
 * — a library of finished videos polls nothing. */
const ENCODE_POLL_MS = 15_000

/** Everything a video asset can show. Null for anything that is not a ready video. */
export interface StreamMedia {
  ref: StreamRef
  /** Card thumbnail — a single frame. */
  still: string
  /**
   * Hover preview: stills spanning the WHOLE video, in order.
   *
   * Not Cloudflare's animated thumbnail — that is capped at 15 seconds and contiguous, so on
   * anything longer it shows the opening and nothing else. Empty until the duration is known,
   * which is only after encoding finishes.
   */
  frames: string[]
  /** Stream's player, for the detail view. */
  iframe: (opts?: { autoplay?: boolean; muted?: boolean }) => string
}

function isVideoAsset(a: Pick<Asset, 'streamUid'>): boolean {
  return !!a.streamUid
}

/**
 * Ensure tokens exist for every gated video in `assets`, and return a resolver.
 *
 * The resolver is recreated whenever tokens land, which is what re-renders the cards — the tokens
 * themselves live in a module-scope cache, not in state, so the detail view and lightbox reuse
 * what the grid already minted.
 */
export function useStreamMedia(assets: Pick<Asset, 'id' | 'streamUid' | 'streamStatus' | 'streamDuration'>[]) {
  const [tokenNonce, setTokenNonce] = useState(0)

  /* Only ids matter for the request, and only video ones. Joined into a string so a re-render with
     an equal-but-new array does not re-fire the effect — the grid rebuilds its array on every
     filter keystroke. */
  const videoIds = useMemo(
    () => assets.filter(isVideoAsset).map(a => a.id).sort().join(','),
    [assets],
  )

  /* Whether anything on screen is still encoding, from the freshest answer available. Recomputed
     on every nonce bump, so the poll below stops the moment the last video turns ready. */
  const stillEncoding = assets.some(a =>
    a.streamUid && (!isStreamReady(freshStreamStatus(a.id) ?? a.streamStatus)
      // The duration arrives with the same call and the preview cannot place frames without it.
      || (freshStreamDuration(a.id) ?? a.streamDuration) == null))

  useEffect(() => {
    if (!videoIds) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const ask = () => ensureStreamTokens(videoIds.split(',')).then(() => {
      // Bump even when nothing was minted or moved: public videos need no token, and the resolver
      // should still run once for them rather than waiting for an unrelated render.
      if (alive) setTokenNonce(n => n + 1)
    })

    void ask()
    /* The same call refreshes encoding state server-side, so the poll is the token request
       repeated — not a second endpoint. It runs only while something is unfinished. */
    if (stillEncoding) timer = setInterval(ask, ENCODE_POLL_MS)

    return () => { alive = false; if (timer) clearInterval(timer) }
  }, [videoIds, stillEncoding])

  return useMemo(() => {
    const domain = streamDomain()
    return function resolve(
      asset: Pick<Asset, 'id' | 'streamUid' | 'streamStatus' | 'streamDuration' | 'perm' | 'status'>,
    ): StreamMedia | null {
      if (!asset.streamUid) return null
      /* Mid-encode, every URL built from the uid 404s. Returning null here is what keeps the
         existing placeholder on screen instead of a broken image.

         The override first: the row was fetched with whatever `stream_status` held at page load,
         and an encode that finished since is only known to the last stream-token call. Reading the
         row alone is what left both staging videos showing "processing" after they were ready. */
      if (!isStreamReady(freshStreamStatus(asset.id) ?? asset.streamStatus)) return null

      const token = cachedStreamToken(asset.streamUid)
      /* A gated video with no token in hand is treated as NOT AVAILABLE rather than rendered from
         its bare uid. The bare-uid URL would 401, which looks like a dead video instead of a
         missing permission — and for the player it would be a black rectangle with controls.
         Better to hold the placeholder until the token arrives, which is a render away. */
      if (tierFor(effectiveLevel(asset)) !== 'public' && !token) return null

      const ref: StreamRef = { uid: asset.streamUid, token }
      return {
        ref,
        // `2s` rather than the default `0s`: a cut that fades in from black has nothing to show on
        // its first frame, and a black card looks like a broken one.
        still: streamStillUrl(domain, ref, { time: '2s', height: 640 }),
        frames: streamFrameUrls(
          domain, ref,
          freshStreamDuration(asset.id) ?? asset.streamDuration,
          PREVIEW_FRAMES, { height: 480 },
        ),
        iframe: (opts) => streamIframeUrl(domain, ref, opts),
      }
    }
    // tokenNonce is the point of this dependency: it is what rebuilds the resolver once tokens land.
  }, [tokenNonce])
}

/** The same, for a single asset — the detail view has one video, not a grid. */
export function useStreamMediaFor(
  asset: Pick<Asset, 'id' | 'streamUid' | 'streamStatus' | 'streamDuration' | 'perm' | 'status'> | null | undefined,
) {
  const list = useMemo(() => (asset ? [asset] : []), [asset])
  const resolve = useStreamMedia(list)
  return asset ? resolve(asset) : null
}
