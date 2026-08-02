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
import type { Asset } from '@dc-hub/asset-library'
import {
  isStreamReady, streamStillUrl, streamAnimatedUrl, streamIframeUrl, type StreamRef,
} from '@dc-hub/domain'
import { ensureStreamTokens, cachedStreamToken, streamDomain } from '../../../services/streamTokens'

/** Everything a video asset can show. Null for anything that is not a ready video. */
export interface StreamMedia {
  ref: StreamRef
  /** Card thumbnail — a single frame. */
  still: string
  /** Hover preview. Large; never load eagerly. See streamAnimatedUrl. */
  animated: (opts?: { fps?: number; duration?: string }) => string
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
export function useStreamMedia(assets: Pick<Asset, 'id' | 'streamUid' | 'streamStatus'>[]) {
  const [tokenNonce, setTokenNonce] = useState(0)

  /* Only ids matter for the request, and only video ones. Joined into a string so a re-render with
     an equal-but-new array does not re-fire the effect — the grid rebuilds its array on every
     filter keystroke. */
  const videoIds = useMemo(
    () => assets.filter(isVideoAsset).map(a => a.id).sort().join(','),
    [assets],
  )

  useEffect(() => {
    if (!videoIds) return
    let alive = true
    void ensureStreamTokens(videoIds.split(',')).then(() => {
      // Bump even when nothing was minted: public videos need no token, and the resolver should
      // still run once for them rather than waiting for an unrelated render.
      if (alive) setTokenNonce(n => n + 1)
    })
    return () => { alive = false }
  }, [videoIds])

  return useMemo(() => {
    const domain = streamDomain()
    return function resolve(asset: Pick<Asset, 'streamUid' | 'streamStatus'>): StreamMedia | null {
      if (!asset.streamUid) return null
      /* Mid-encode, every URL built from the uid 404s. Returning null here is what keeps the
         existing placeholder on screen instead of a broken image. */
      if (!isStreamReady(asset.streamStatus)) return null

      const token = cachedStreamToken(asset.streamUid)
      const ref: StreamRef = { uid: asset.streamUid, token }
      return {
        ref,
        // `2s` rather than the default `0s`: a cut that fades in from black has nothing to show on
        // its first frame, and a black card looks like a broken one.
        still: streamStillUrl(domain, ref, { time: '2s', height: 640 }),
        animated: (opts) => streamAnimatedUrl(domain, ref, {
          time: '2s', duration: '5s', fps: 2, height: 480, ...opts,
        }),
        iframe: (opts) => streamIframeUrl(domain, ref, opts),
      }
    }
    // tokenNonce is the point of this dependency: it is what rebuilds the resolver once tokens land.
  }, [tokenNonce])
}

/** The same, for a single asset — the detail view has one video, not a grid. */
export function useStreamMediaFor(asset: Pick<Asset, 'id' | 'streamUid' | 'streamStatus'> | null | undefined) {
  const list = useMemo(() => (asset ? [asset] : []), [asset])
  const resolve = useStreamMedia(list)
  return asset ? resolve(asset) : null
}
