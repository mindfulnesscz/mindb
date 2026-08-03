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
 * An animated GIF preview.
 *
 * NOT USED FOR THE HOVER PREVIEW, and the reason is a hard limit worth recording: `duration` is
 * capped at FIFTEEN SECONDS — `duration: attribute 20s must be between 100ms and 15s`. The window is
 * also contiguous, so on anything longer than a few seconds a GIF can only ever show the opening.
 * On a 62-second film that reads as broken rather than short.
 *
 * Size is unpredictable too. Measured across two real videos at `fps=2, height=480`: 37 KB for a
 * simple clip, 763 KB for a detailed one, and 1.5 MB at ten seconds. Against that, ten stills
 * spanning a whole 62-second video total 121 KB — cheaper AND complete, which is why
 * `streamFrameUrls` won.
 *
 * Kept because it is the right tool for a genuinely short clip, and because the cap is the kind of
 * fact that gets rediscovered expensively.
 */
export function streamAnimatedUrl(
  domain: string | null | undefined, ref: StreamRef, opts: AnimatedOptions = {},
): string {
  return withParams(`${base(domain, ref)}/thumbnails/thumbnail.gif`, { ...opts });
}

/** Stream refuses an animated `duration` outside this range. Measured, not documented. */
export const ANIMATED_MAX_SECONDS = 15;

/**
 * Stills spanning the whole video — the hover preview.
 *
 * Frames are centred in equal slices rather than placed at slice boundaries: `t = duration *
 * (i + 0.5) / count`. Starting at 0s is what makes a preview open on black, because a cut that fades
 * in has nothing to show on its first frame, and the final boundary lands on the last frame or past
 * it. Centring avoids both ends for free.
 *
 * Returns an empty array when the duration is unknown — mid-encode, or a row predating the column.
 * The caller should hold the still rather than guess at timestamps, since a `time` past the end
 * returns the last frame and every guess would look identical.
 */
export function streamFrameUrls(
  domain: string | null | undefined, ref: StreamRef,
  durationSeconds: number | null | undefined, count = 10, opts: Omit<StillOptions, 'time'> = {},
): string[] {
  if (!durationSeconds || durationSeconds <= 0 || count < 1) return [];
  return Array.from({ length: count }, (_, i) => {
    const t = (durationSeconds * (i + 0.5)) / count;
    // Whole tenths of a second: Stream accepts fractional `time`, and rounding keeps the URL — and
    // therefore the cache key — stable across renders that recompute the same frame.
    return streamStillUrl(domain, ref, { ...opts, time: `${t.toFixed(1)}s` });
  });
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
