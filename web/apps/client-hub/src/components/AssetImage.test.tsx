// @vitest-environment jsdom

/* The thumbnail fallback.
 *
 * The failure being designed around is quiet and easy to mistake for a bug in the product: an asset's
 * row is visible while its bytes are not. `perm='guest'` is exactly that — RLS returns the row to any
 * signed-in user, but the image comes from the gated bucket through `cdn-gate`, which answers 401
 * without the CDN cookie. The browser's own answer to that is the broken-image glyph.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AssetImage } from './AssetImage';

describe('AssetImage', () => {
  it('renders the image', () => {
    render(<AssetImage src="https://cdn.example/a.webp" alt="Sofa hero" />);
    expect(screen.getByAltText('Sofa hero')).toBeTruthy();
  });

  it('sends no referrer — a hotlink-protected CDN must treat this as a direct hit', () => {
    render(<AssetImage src="https://cdn.example/a.webp" alt="Sofa hero" />);
    expect(screen.getByAltText('Sofa hero')).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('a failed load becomes a placeholder, not a broken image', () => {
    render(<AssetImage src="https://cdn.example/gated.webp" alt="Sofa hero" />);

    fireEvent.error(screen.getByAltText('Sofa hero'));

    expect(screen.queryByAltText('Sofa hero')).toBeNull();
    expect(screen.getByText('Preview unavailable')).toBeTruthy();
    // Still announced as an image, and still named — a screen reader gets the asset, not silence.
    expect(screen.getByRole('img', { name: 'Sofa hero — preview unavailable' })).toBeTruthy();
  });

  it('keeps the footprint, so a grid does not reflow around one gated tile', () => {
    render(
      <AssetImage
        src="https://cdn.example/gated.webp" alt="Sofa hero"
        className="w-full h-full object-cover" fallbackClassName="w-full h-full"
      />,
    );
    fireEvent.error(screen.getByAltText('Sofa hero'));
    expect(screen.getByRole('img').className).toContain('w-full h-full');
  });

  it('a NEW src gets a fresh attempt', () => {
    /* The carousel reuses one instance as it steps, so a bare `failed` boolean would show the
       placeholder for every frame after the first gated one. */
    const { rerender } = render(<AssetImage src="https://cdn.example/gated.webp" alt="Frame" />);
    fireEvent.error(screen.getByAltText('Frame'));
    expect(screen.getByText('Preview unavailable')).toBeTruthy();

    rerender(<AssetImage src="https://cdn.example/fine.webp" alt="Frame" />);

    expect(screen.getByAltText('Frame')).toBeTruthy();
    expect(screen.queryByText('Preview unavailable')).toBeNull();
  });

  it('and going back to the failed src stays failed', () => {
    const { rerender } = render(<AssetImage src="https://cdn.example/gated.webp" alt="Frame" />);
    fireEvent.error(screen.getByAltText('Frame'));
    rerender(<AssetImage src="https://cdn.example/fine.webp" alt="Frame" />);

    rerender(<AssetImage src="https://cdn.example/gated.webp" alt="Frame" />);

    expect(screen.getByText('Preview unavailable')).toBeTruthy();
  });
});
