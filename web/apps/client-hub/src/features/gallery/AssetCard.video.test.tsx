// @vitest-environment jsdom

/* The video card's hover preview — what it loads, and more importantly WHEN.
 *
 * A measured preview ranged from 37 KB to 2.7 MB depending on the footage — two orders of
 * magnitude, decided by content nobody controls. Loading one eagerly per card would look fine in
 * development against a library with two simple videos in it and fall over on a real shoot. So
 * "not requested until hovered" is asserted, not assumed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
const ANIMATED = 'https://videodelivery.net/uid1/thumbnails/thumbnail.gif?fps=2';

const video: Asset = {
  id: 'v1', clientId: 'c1', name: 'Brand Film', entityType: 'product', entity: '', formats: [],
  angle: '', status: 'published', perm: 'client', version: 'v1', latest: true,
  avg: 0, count: 0, comments: 0, approval: 'none',
  thumbnailUrl: STILL, streamUid: 'uid1', streamStatus: 'ready', updatedAt: '2026-08-03',
} as Asset;

const props = { onOpen: vi.fn(), role: 'member' as const, accent: '#000' };

beforeEach(() => { reduceMotion = false; });

describe('AssetCard — video', () => {
  it('does not request the animated preview before hover', () => {
    render(<AssetCard asset={video} animatedThumbUrl={ANIMATED} {...props} />);
    expect(document.querySelector(`img[src="${ANIMATED}"]`)).toBeNull();
    // The still is there from the start — the card is never blank waiting on a hover.
    expect(document.querySelector(`img[src="${STILL}"]`)).not.toBeNull();
  });

  it('loads the preview on first hover', () => {
    const { container } = render(<AssetCard asset={video} animatedThumbUrl={ANIMATED} {...props} />);
    act(() => { fireEvent.mouseEnter(container.querySelector('button')!); });
    expect(document.querySelector(`img[src="${ANIMATED}"]`)).not.toBeNull();
  });

  /* Kept mounted after the pointer leaves, so returning to a card is instant off the browser cache
     rather than a second download of the same GIF. */
  it('keeps the preview mounted after the pointer leaves, and only fades it', () => {
    const { container } = render(<AssetCard asset={video} animatedThumbUrl={ANIMATED} {...props} />);
    const card = container.querySelector('button')!;
    act(() => { fireEvent.mouseEnter(card); });
    act(() => { fireEvent.mouseLeave(card); });
    const img = document.querySelector(`img[src="${ANIMATED}"]`);
    expect(img).not.toBeNull();
    expect(img!.className).toContain('opacity-0');
  });

  it('holds the still when the viewer prefers reduced motion', () => {
    reduceMotion = true;
    const { container } = render(<AssetCard asset={video} animatedThumbUrl={ANIMATED} {...props} />);
    act(() => { fireEvent.mouseEnter(container.querySelector('button')!); });
    expect(document.querySelector(`img[src="${ANIMATED}"]`)).toBeNull();
    expect(document.querySelector(`img[src="${STILL}"]`)).not.toBeNull();
  });

  /* Without a marker a video card is indistinguishable from an image card until it is opened. */
  it('marks video cards so they read as playable', () => {
    const { container } = render(<AssetCard asset={video} {...props} />);
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
    const image = { ...video, streamUid: null } as Asset;
    const plain = render(<AssetCard asset={image} {...props} />);
    // The play marker is the only aria-hidden decoration on a card with no preview.
    expect(plain.container.querySelectorAll('[aria-hidden="true"]').length)
      .toBeLessThan(container.querySelectorAll('[aria-hidden="true"]').length);
  });

  it('renders nothing extra when there is no preview URL', () => {
    const { container } = render(<AssetCard asset={video} {...props} />);
    act(() => { fireEvent.mouseEnter(container.querySelector('button')!); });
    expect(document.querySelector('img[src*="thumbnail.gif"]')).toBeNull();
  });
});
