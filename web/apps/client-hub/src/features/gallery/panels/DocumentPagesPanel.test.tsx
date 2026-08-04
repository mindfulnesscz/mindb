// @vitest-environment jsdom

/* The page strip's job is to show what exists and be honest about what does not.
 *
 * `previewPageCount` is what was rendered and published; `previewPageTotal` is what the document
 * has. When a client's page limit capped rendering the two differ, and a viewer looking at five
 * pages of a forty-page report has to be told the other thirty-five exist. Hiding that is the
 * failure this file guards against — it looks identical to a five-page document.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { Asset } from '@sotto/asset-library'
import { DocumentPagesPanel } from './DocumentPagesPanel'

/* The lightbox portals into document.body and animates; none of that is under test here, and its
   real implementation would need a full DOM/motion environment. */
vi.mock('../ImageLightbox', () => ({
  ImageLightbox: ({ index }: { index: number }) => <div data-testid="lightbox">{index}</div>,
}))

const THUMB = 'https://files.example.com/client/c-1/thumbnails/a1/c1.webp?v=abc123'

const asset = (over: Partial<Asset> = {}): Asset => ({
  id: 'asset-1', clientId: 'c1', name: 'Quarterly Report',
  entityType: 'product', entity: 'Product', formats: ['PDF'], angle: 'Overview',
  status: 'published', perm: 'client', version: 'v1', latest: true,
  avg: 0, count: 0, comments: 0, approval: 'none', updatedAt: '2026-01-01',
  thumbnailUrl: THUMB,
  ...over,
})

describe('DocumentPagesPanel', () => {
  it('renders one tile per rendered page, in page order', () => {
    render(<DocumentPagesPanel asset={asset({ previewPageCount: 3, previewPageTotal: 3 })} />)

    const imgs = screen.getAllByRole('img')
    expect(imgs).toHaveLength(3)
    // Zero-padded addresses, matching the objects the pipeline wrote.
    expect(imgs.map(i => i.getAttribute('src'))).toEqual([
      'https://files.example.com/client/c-1/pages/a1/c1/001.webp?v=abc123',
      'https://files.example.com/client/c-1/pages/a1/c1/002.webp?v=abc123',
      'https://files.example.com/client/c-1/pages/a1/c1/003.webp?v=abc123',
    ])
  })

  it('says how many pages exist when nothing was capped', () => {
    render(<DocumentPagesPanel asset={asset({ previewPageCount: 2, previewPageTotal: 2 })} />)
    expect(screen.getByText('2 pages')).toBeInTheDocument()
    expect(screen.queryByText(/download the asset/i)).not.toBeInTheDocument()
  })

  /* THE case this panel exists for. */
  it('tells the viewer what is missing, and where to get it, when the limit capped rendering', () => {
    render(<DocumentPagesPanel asset={asset({
      previewPageCount: 5, previewPageTotal: 40, downloadUrl: 'https://files.example.com/doc.pdf',
    })} />)

    expect(screen.getAllByRole('img')).toHaveLength(5)
    expect(screen.getByText('5 of 40')).toBeInTheDocument()
    expect(screen.getByText(/Showing the first 5 of 40 pages/)).toBeInTheDocument()

    const link = screen.getByRole('link', { name: /download the asset/i })
    expect(link).toHaveAttribute('href', 'https://files.example.com/doc.pdf')
  })

  it('still states the cap when there is no download URL to offer', () => {
    // Better to say the pages exist than to silently imply the document is five pages long.
    render(<DocumentPagesPanel asset={asset({ previewPageCount: 1, previewPageTotal: 9 })} />)
    expect(screen.getByText(/Showing the first 1 of 9 pages/)).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('renders nothing for an asset with no page previews', () => {
    const { container } = render(<DocumentPagesPanel asset={asset()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when a count survives but the thumbnail URL does not', () => {
    // Without the thumbnail there is no address to derive, and a grid of broken images is worse
    // than no grid. Reachable if a thumbnail upload failed after the counts were written.
    const { container } = render(
      <DocumentPagesPanel asset={asset({ previewPageCount: 4, thumbnailUrl: undefined })} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the limit is 0, which is how an admin turns previews off', () => {
    const { container } = render(
      <DocumentPagesPanel asset={asset({ previewPageCount: 0, previewPageTotal: 12 })} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('treats a missing total as equal to the rendered count', () => {
    // A row written before preview_page_total existed must not read as "0 of 3 pages".
    render(<DocumentPagesPanel asset={asset({ previewPageCount: 3, previewPageTotal: null })} />)
    expect(screen.getByText('3 pages')).toBeInTheDocument()
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument()
  })

  it('opens the lightbox at the page that was clicked', () => {
    render(<DocumentPagesPanel asset={asset({ previewPageCount: 4, previewPageTotal: 4 })} />)

    expect(screen.queryByTestId('lightbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open page 3 of 4' }))
    // Zero-based index into the item list, so page 3 is index 2.
    expect(screen.getByTestId('lightbox')).toHaveTextContent('2')
  })
})
