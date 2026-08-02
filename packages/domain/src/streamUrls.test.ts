import { describe, it, expect } from 'vitest';
import {
  streamStillUrl, streamAnimatedUrl, streamIframeUrl, streamHlsUrl,
  isStreamReady, STREAM_DELIVERY_FALLBACK,
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
