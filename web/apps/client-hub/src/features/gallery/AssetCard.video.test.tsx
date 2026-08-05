// @vitest-environment jsdom

/* The video card's hover preview — what it loads, when, and that it covers the whole film.
 *
 * The preview was originally Cloudflare's animated thumbnail, which is capped at 15 contiguous
 * seconds: on a 62-second cut it showed the opening and nothing else, which reads as broken rather
 * than short. It now steps through stills spanning the full duration.
 *
 * Ten stills measured 121 KB on a real video — cheaper than the 763 KB GIF they replaced, but still
 * not something to load for every card in a grid up front. So "not requested until hovered" is
 * asserted, not assumed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import type { Asset } from '@dc-hub/asset-library';

let reduceMotion = false;
vi.mock('motion/react', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('motion/react');
  return { ...actual, useReducedMotion: () => reduceMotion };
});
vi.mock('./MultiAssetHover', () => ({
  MultiAssetHoverGrid: () => null,
  useSiblingPreviews: () => ({ siblings: [], loading: false }),
  useDelayedHover: (active: boolean) => active,
}));

const { AssetCard } = await import('./AssetCard');

const STILL = 'https://videodelivery.net/uid1/thumbnails/thumbnail.jpg?time=2s';
/* As streamFrameUrls builds them: centred in equal slices of a 60s video, so neither the opening
   black frame nor the very end. */
const FRAMES = [3, 9, 15, 21, 27, 33, 39, 45, 51, 57].map(
  t => `https://videodelivery.net/uid1/thumbnails/thumbnail.jpg?height=480&time=${t}.0s`,
);

const video: Asset = {
  id: 'v1', clientId: 'c1', name: 'Brand Film', entityType: 'product', entity: '', formats: [],
  angle: '', status: 'published', perm: 'client', version: 'v1', latest: true,
  avg: 0, count: 0, comments: 0, approval: 'none',
  thumbnailUrl: STILL, streamUid: 'uid1', streamStatus: 'ready', streamDuration: 60,
  updatedAt: '2026-08-03',
} as Asset;

const props = { onOpen: vi.fn(), role: 'member' as const, accent: '#000' };
const shown = () => [...document.querySelectorAll('img')]
  .filter(i => !i.className.includes('opacity-0')).map(i => i.getAttribute('src'));

beforeEach(() => { reduceMotion = false; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('AssetCard — video preview', () => {
  it('requests no frames before hover', () => {
    render(<AssetCard asset={video} previewFrames={FRAMES} {...props} />);
    expect(document.querySelectorAll('img[src*="height=480"]').length).toBe(0);
    // The still is there from the start — the card is never blank waiting on a hover.
    expect(document.querySelector(`img[src="${STILL}"]`)).not.toBeNull();
  });

  /* The point of the rewrite: the frames must span the film, not its opening. */
  it('mounts every frame on first hover, covering the whole duration', () => {
    const { container } = render(<AssetCard asset={video} previewFrames={FRAMES} {...props} />);
    act(() => { fireEvent.mouseEnter(container.querySelector('button')!); });
    expect(document.querySelectorAll('img[src*="height=480"]').length).toBe(10);
    // The last frame sits near the end of a 60s video, not inside the first few seconds.
    expect(document.querySelector('img[src*="time=57.0s"]')).not.toBeNull();
  });

  it('steps through the frames in order while hovered', () => {
    const { container } = render(<AssetCard asset={video} previewFrames={FRAMES} {...props} />);
    act(() => { fireEvent.mouseEnter(container.querySelector('button')!); });
    expect(shown()).toContain(FRAMES[0]);
    act(() => { vi.advanceTimersByTime(500); });
    expect(shown()).toContain(FRAMES[1]);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(shown()).toContain(FRAMES[3]);
  });

  it('wraps around rather than stopping at the last frame', () => {
    const { container } = render(<AssetCard asset={video} previewFrames={FRAMES} {...props} />);
    act(() => { fireEvent.mouseEnter(container.querySelector('button')!); });
    act(() => { vi.advanceTimersByTime(500 * FRAMES.length); });
    expect(shown()).toContain(FRAMES[0]);
  });

  /* Kept mounted after the pointer leaves, so returning to a card plays instantly off the browser
     cache rather than re-downloading ten stills. */
  it('keeps the frames mounted after the pointer leaves, and hides them', () => {
    const { container } = render(<AssetCard asset={video} previewFrames={FRAMES} {...props} />);
    const card = container.querySelector('button')!;
    act(() => { fireEvent.mouseEnter(card); });
    act(() => { fireEvent.mouseLeave(card); });
    expect(document.querySelectorAll('img[src*="height=480"]').length).toBe(10);
    expect(shown()).not.toContain(FRAMES[0]);
  });

  it('restarts at the first frame on the next hover', () => {
    const { container } = render(<AssetCard asset={video} previewFrames={FRAMES} {...props} />);
    const card = container.querySelector('button')!;
    act(() => { fireEvent.mouseEnter(card); });
    act(() => { vi.advanceTimersByTime(1500); });
    act(() => { fireEvent.mouseLeave(card); });
    act(() => { fireEvent.mouseEnter(card); });
    expect(shown()).toContain(FRAMES[0]);
  });

  it('holds the still when the viewer prefers reduced motion', () => {
    reduceMotion = true;
    const { container } = render(<AssetCard asset={video} previewFrames={FRAMES} {...props} />);
    act(() => { fireEvent.mouseEnter(container.querySelector('button')!); });
    expect(document.querySelectorAll('img[src*="height=480"]').length).toBe(0);
    expect(document.querySelector(`img[src="${STILL}"]`)).not.toBeNull();
  });

  /* Mid-encode the duration is unknown, so there are no timestamps to request — the card must fall
     back to the still rather than guessing, since a `time` past the end returns the last frame and
     every guess would look identical. */
  it('renders nothing extra when there are no frames yet', () => {
    const { container } = render(<AssetCard asset={video} previewFrames={[]} {...props} />);
    act(() => { fireEvent.mouseEnter(container.querySelector('button')!); });
    expect(document.querySelectorAll('img[src*="height=480"]').length).toBe(0);
  });

  /* Without a marker a video card is indistinguishable from an image card until it is opened. */
  it('marks video cards so they read as playable', () => {
    const { container } = render(<AssetCard asset={video} {...props} />);
    const image = { ...video, streamUid: null } as Asset;
    const plain = render(<AssetCard asset={image} {...props} />);
    expect(plain.container.querySelectorAll('[aria-hidden="true"]').length)
      .toBeLessThan(container.querySelectorAll('[aria-hidden="true"]').length);
  });
});
