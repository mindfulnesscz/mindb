/* Cloudflare Stream delivery URLs.
 *
 * Every video URL in the product is built here, because the one thing that is easy to get wrong is
 * also invisible when you do: a GATED video's URLs must carry a signed token, and one built without
 * it returns 401 — which renders as a blank card, not as an error anyone will report.
 *
 * THE TOKEN REPLACES THE UID IN THE PATH. It is not a query parameter, and it is not a header:
 *
 *   .../<uid>/thumbnails/thumbnail.jpg     public video
 *   .../<token>/thumbnails/thumbnail.jpg   gated video
 *
 * One token opens playback, stills and animated previews for its video, so a card needs one token
 * rather than one per element. They are ~580 characters, which is worth remembering before putting
 * a hundred of them in a grid.
 *
 * Measured 2026-08-02: with `requireSignedURLs` on, stills, animated previews, parameterised
 * variants, manifests, MP4 downloads and the iframe player ALL 401 unsigned. Thumbnails are not
 * the exception the Cloudflare docs imply they might be.
 */

/** Access levels and their tiers live in assetStorage; this only needs the ready state. */
export const STREAM_READY = 'ready';

/**
 * Cloudflare's account-agnostic delivery host, used when no customer subdomain is configured.
 *
 * A default that might not work would be worse than requiring configuration — this one was checked
 * against a real video on this account and serves identically to the customer subdomain. It keeps
 * preview deploys and local development working without another environment variable to forget.
 */
export const STREAM_DELIVERY_FALLBACK = 'https://videodelivery.net';

/** A video, plus the token that opens it when it is gated. */
export interface StreamRef {
  uid: string;
  /** Absent for a `public` video, which needs none. Absent for a GATED video is a bug: 401. */
  token?: string | null;
}

/** Only `ready` means the delivery URLs resolve. Anything else is still encoding — or failed. */
export function isStreamReady(status: string | null | undefined): boolean {
  return status === STREAM_READY;
}

function base(domain: string | null | undefined, ref: StreamRef): string {
  const host = (domain || STREAM_DELIVERY_FALLBACK).replace(/\/+$/, '');
  return `${host}/${ref.token || ref.uid}`;
}

function withParams(url: string, params: Record<string, string | number | undefined>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return q ? `${url}?${q}` : url;
}

export interface StillOptions {
  /** Timestamp to grab, e.g. `2s`. Default `0s` — often a black frame on a faded-in cut. */
  time?: string;
  height?: number;
  width?: number;
  fit?: 'crop' | 'clip' | 'scale' | 'fill';
}

/** A single frame as a JPEG — the card thumbnail for a video. */
export function streamStillUrl(
  domain: string | null | undefined, ref: StreamRef, opts: StillOptions = {},
): string {
  return withParams(`${base(domain, ref)}/thumbnails/thumbnail.jpg`, { ...opts });
}

export interface AnimatedOptions extends StillOptions {
  /** Seconds of video to cover. Default `5s`. */
  duration?: string;
  /** Frames per second. Default 8; 2 gives the half-second-per-frame flip used on hover. */
  fps?: number;
}

/**
 * An animated GIF preview — the hover state.
 *
 * These are LARGE: a default-quality 5s preview measured 2.7 MB against a real video. Never load
 * one eagerly for a grid; fetch on first hover and let the browser cache it after that.
 */
export function streamAnimatedUrl(
  domain: string | null | undefined, ref: StreamRef, opts: AnimatedOptions = {},
): string {
  return withParams(`${base(domain, ref)}/thumbnails/thumbnail.gif`, { ...opts });
}

/**
 * Stream's own player in an iframe.
 *
 * Chosen over hls.js because it brings adaptive bitrate, captions, keyboard handling and the
 * fullscreen affordances for free, and none of that is the interesting part of this product. Reach
 * for hls.js only when the controls themselves need to be custom.
 */
export function streamIframeUrl(
  domain: string | null | undefined, ref: StreamRef,
  opts: { autoplay?: boolean; muted?: boolean; loop?: boolean; controls?: boolean; poster?: string } = {},
): string {
  return withParams(`${base(domain, ref)}/iframe`, {
    autoplay: opts.autoplay ? 'true' : undefined,
    muted:    opts.muted ? 'true' : undefined,
    loop:     opts.loop ? 'true' : undefined,
    controls: opts.controls === false ? 'false' : undefined,
    poster:   opts.poster,
  });
}

/** The HLS manifest, for a custom player. Not used today — see streamIframeUrl. */
export function streamHlsUrl(domain: string | null | undefined, ref: StreamRef): string {
  return `${base(domain, ref)}/manifest/video.m3u8`;
}
