// @vitest-environment jsdom

/* A thumbnail that fails must not read as a broken product.
 *
 * The browser's answer to a 401 or 404 on an <img> is its broken-image glyph, which is what a client
 * saw when a 431 MiB TIFF could not be decoded and so never got a thumbnail. The asset itself was
 * fine and downloadable; only the preview was missing.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AssetImage } from './AssetImage'

const SRC = 'https://files.example.com/client/c1/thumbnails/a1/c1.webp'

/** Simulate what the browser does when the image request fails. */
function failImage() {
  fireEvent.error(screen.getByRole('img'))
}

describe('AssetImage', () => {
  it('shows the image while it loads fine', () => {
    render(<AssetImage src={SRC} alt="Falling Up" />)
    expect(screen.getByRole('img')).toHaveAttribute('src', SRC)
    expect(screen.queryByText('No preview')).not.toBeInTheDocument()
  })

  it('names the asset and offers the original when the preview fails', () => {
    render(<AssetImage
      src={SRC} alt="Falling Up"
      fileName="falling-up@600x.tif"
      downloadUrl="https://files.example.com/original.tif"
    />)
    failImage()

    expect(screen.getByText('No preview')).toBeInTheDocument()
    // Which asset — "no preview" alone does not say, and several tiles can fail at once.
    expect(screen.getByText('falling-up@600x.tif')).toBeInTheDocument()
    // A missing preview is not a missing asset.
    expect(screen.getByRole('link', { name: 'Download' }))
      .toHaveAttribute('href', 'https://files.example.com/original.tif')
  })

  it('keeps the placeholder accessible as an image role', () => {
    render(<AssetImage src={SRC} alt="Falling Up" />)
    failImage()
    expect(screen.getByRole('img', { name: /Falling Up — preview unavailable/ })).toBeInTheDocument()
  })

  it('omits the label and link when compact, for tiles too small to read them', () => {
    render(<AssetImage
      src={SRC} alt="Page 3" compact
      fileName="falling-up@600x.tif" downloadUrl="https://x/o.tif"
    />)
    failImage()

    expect(screen.getByText('No preview')).toBeInTheDocument()
    expect(screen.queryByText('falling-up@600x.tif')).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('does not let the download click open the card behind it', () => {
    // These placeholders sit inside clickable cards; without stopPropagation the click would both
    // download AND open the asset drawer.
    const onDownload = vi.fn()
    const onCardClick = vi.fn()
    render(
      <div onClick={onCardClick}>
        <AssetImage src={SRC} alt="a" fileName="f.tif" downloadUrl="https://x/o.tif" onDownload={onDownload} />
      </div>,
    )
    failImage()
    fireEvent.click(screen.getByRole('link', { name: 'Download' }))

    expect(onDownload).toHaveBeenCalledOnce()
    expect(onCardClick).not.toHaveBeenCalled()
  })

  /* The failure is remembered against the URL, not as a boolean: a carousel reuses one instance as it
     steps, so a bare flag would show the placeholder for every frame after the first failure. */
  it('recovers when the src changes to one that works', () => {
    const { rerender } = render(<AssetImage src={SRC} alt="a" />)
    failImage()
    expect(screen.getByText('No preview')).toBeInTheDocument()

    rerender(<AssetImage src={`${SRC}?v=other`} alt="a" />)
    expect(screen.queryByText('No preview')).not.toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute('src', `${SRC}?v=other`)
  })
})
