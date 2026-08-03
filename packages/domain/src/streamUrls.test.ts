import { describe, it, expect } from 'vitest';
import {
  streamStillUrl, streamAnimatedUrl, streamFrameUrls, streamIframeUrl, streamHlsUrl,
  isStreamReady, STREAM_DELIVERY_FALLBACK, ANIMATED_MAX_SECONDS,
} from './streamUrls';

const DOMAIN = 'https://customer-abc.cloudflarestream.com';
const UID = 'fecb3749fe45ba83f3d7a012643b603a';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig';

describe('stream delivery URLs', () => {
  /* The whole point of the module. A gated video's URL built from the uid returns 401, which
     renders as a blank card rather than an error — so this is the assertion that matters most. */
  it('puts the token where the uid goes, not in the query string', () => {
    const url = streamStillUrl(DOMAIN, { uid: UID, token: TOKEN });
    expect(url).toContain(`/${TOKEN}/thumbnails/thumbnail.jpg`);
    expect(url).not.toContain(UID);
    expect(url).not.toContain('token=');
  });

  it('uses the bare uid when there is no token — public videos need none', () => {
    expect(streamStillUrl(DOMAIN, { uid: UID })).toBe(`${DOMAIN}/${UID}/thumbnails/thumbnail.jpg`);
    expect(streamStillUrl(DOMAIN, { uid: UID, token: null })).toContain(`/${UID}/`);
  });

  it('falls back to the account-agnostic host when no domain is configured', () => {
    for (const domain of [null, undefined, '']) {
      expect(streamStillUrl(domain, { uid: UID }), String(domain))
        .toBe(`${STREAM_DELIVERY_FALLBACK}/${UID}/thumbnails/thumbnail.jpg`);
    }
  });

  it('does not double a trailing slash on the configured domain', () => {
    expect(streamStillUrl('https://x.net/', { uid: UID })).toBe(`https://x.net/${UID}/thumbnails/thumbnail.jpg`);
  });

  it('carries still options through', () => {
    const url = streamStillUrl(DOMAIN, { uid: UID }, { time: '2s', height: 640, fit: 'crop' });
    expect(url).toContain('time=2s');
    expect(url).toContain('height=640');
    expect(url).toContain('fit=crop');
  });

  it('omits absent options rather than sending empty ones', () => {
    expect(streamStillUrl(DOMAIN, { uid: UID }, {})).not.toContain('?');
    expect(streamStillUrl(DOMAIN, { uid: UID }, { time: undefined })).not.toContain('time=');
  });

  it('builds the animated preview with fps and duration', () => {
    const url = streamAnimatedUrl(DOMAIN, { uid: UID }, { fps: 2, duration: '5s' });
    expect(url).toContain('/thumbnails/thumbnail.gif');
    expect(url).toContain('fps=2');
    expect(url).toContain('duration=5s');
  });

  it('builds a player URL, and only sends flags that are set', () => {
    expect(streamIframeUrl(DOMAIN, { uid: UID })).toBe(`${DOMAIN}/${UID}/iframe`);
    const url = streamIframeUrl(DOMAIN, { uid: UID, token: TOKEN }, { autoplay: true, muted: true });
    expect(url).toContain(`/${TOKEN}/iframe`);
    expect(url).toContain('autoplay=true');
    expect(url).toContain('muted=true');
    expect(url).not.toContain('loop=');
  });

  it('builds the HLS manifest URL', () => {
    expect(streamHlsUrl(DOMAIN, { uid: UID })).toBe(`${DOMAIN}/${UID}/manifest/video.m3u8`);
  });
});

describe('isStreamReady', () => {
  /* Everything except `ready` means the delivery URLs 404. Treating `inprogress` as playable is
     how a card renders a broken image for the length of an encode. */
  it('is true only for ready', () => {
    expect(isStreamReady('ready')).toBe(true);
    for (const s of ['queued', 'inprogress', 'downloading', 'pendingupload', 'error', null, undefined, '']) {
      expect(isStreamReady(s), String(s)).toBe(false);
    }
  });
});

describe('streamFrameUrls', () => {
  /* The whole reason this replaced the animated thumbnail: Stream caps `duration` at 15 contiguous
     seconds, so a GIF of a 62-second film shows the opening and nothing else. */
  it('spans the whole video, not its opening', () => {
    const urls = streamFrameUrls(DOMAIN, { uid: UID }, 60, 10);
    expect(urls).toHaveLength(10);
    expect(urls[0]).toContain('time=3.0s');
    expect(urls[9]).toContain('time=57.0s');
  });

  /* Centred in each slice: starting at 0s opens on black for any cut that fades in, and the final
     boundary lands on or past the last frame. */
  it('centres frames in equal slices, avoiding both ends', () => {
    const urls = streamFrameUrls(DOMAIN, { uid: UID }, 10, 2);
    expect(urls[0]).toContain('time=2.5s');
    expect(urls[1]).toContain('time=7.5s');
  });

  it('carries the token so a gated video\'s frames are signed', () => {
    const urls = streamFrameUrls(DOMAIN, { uid: UID, token: TOKEN }, 30, 3);
    for (const u of urls) {
      expect(u).toContain(`/${TOKEN}/`);
      expect(u).not.toContain(UID);
    }
  });

  /* Mid-encode there is no duration. Guessing timestamps would be worse than nothing: a `time` past
     the end returns the last frame, so every guess would look identical. */
  it('returns nothing when the duration is unknown', () => {
    for (const d of [null, undefined, 0, -5]) {
      expect(streamFrameUrls(DOMAIN, { uid: UID }, d as number), String(d)).toEqual([]);
    }
  });

  it('respects the requested count and passes still options through', () => {
    expect(streamFrameUrls(DOMAIN, { uid: UID }, 60, 4)).toHaveLength(4);
    expect(streamFrameUrls(DOMAIN, { uid: UID }, 60, 1)[0]).toContain('time=30.0s');
    expect(streamFrameUrls(DOMAIN, { uid: UID }, 60, 2, { height: 480 })[0]).toContain('height=480');
  });

  it('rounds timestamps so the same frame keeps the same URL, and therefore the same cache entry', () => {
    const a = streamFrameUrls(DOMAIN, { uid: UID }, 61.9, 10);
    const b = streamFrameUrls(DOMAIN, { uid: UID }, 61.9, 10);
    expect(a).toEqual(b);
    // One decimal place, always — an unrounded float would vary the URL and defeat the cache.
    for (const u of a) expect(u).toMatch(/[?&]time=\d+\.\ds(&|$)/);
    expect(a[0]).toContain('time=3.1s');
  });

  /* A real 62-second video cannot be covered by an animated thumbnail at all, which is why frames
     exist. Asserted so the cap is not quietly raised in the URL builder without revisiting this. */
  it('exists because animated previews cap at 15 seconds', () => {
    expect(ANIMATED_MAX_SECONDS).toBe(15);
    const long = 61.9;
    expect(long).toBeGreaterThan(ANIMATED_MAX_SECONDS);
    expect(streamFrameUrls(DOMAIN, { uid: UID }, long, 10)[9]).toContain('time=58.8s');
  });
});
