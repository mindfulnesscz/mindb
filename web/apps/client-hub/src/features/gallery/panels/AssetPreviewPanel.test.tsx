// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Asset } from '@sotto/asset-library'

vi.mock('../ImageLightbox', () => ({
  ImageLightbox: ({
    items,
  }: {
    items: { assetId?: string; downloadUrl?: string; cloudLinks?: unknown[] }[]
  }) => (
    <div>
      {items.map(item => (
        <div key={item.assetId}>
          <span data-testid={`download-${item.assetId}`}>
            {item.downloadUrl ?? 'locked'}
          </span>
          <span data-testid={`cloud-${item.assetId}`}>{item.cloudLinks?.length ?? 0}</span>
        </div>
      ))}
    </div>
  ),
}))
vi.mock('../../../services/eventService', () => ({ trackEvent: vi.fn(async () => {}) }))
vi.mock('../../../lib/assetActions', () => ({ webAssetActions: {} }))

const { AssetPreviewPanel } = await import('./AssetPreviewPanel')

const makeAsset = (id: string, status: Asset['status']): Asset => ({
  id,
  clientId: 'client-1',
  name: id,
  entityType: 'product',
  entity: '',
  formats: [],
  angle: '',
  status,
  perm: 'client',
  version: 'v1',
  latest: true,
  avg: 0,
  count: 0,
  comments: 0,
  approval: 'none',
  thumbnailUrl: `https://files.example.com/${id}.webp`,
  downloadUrl: `https://files.example.com/${id}.tif`,
  updatedAt: '2026-08-05',
})

describe('AssetPreviewPanel sibling downloads', () => {
  it('checks each sibling instead of inheriting the parent permission', () => {
    const parent = makeAsset('parent', 'published')
    const released = makeAsset('released', 'published')
    const draft = makeAsset('draft', 'review')
    released.downloadUrls = [{
      destId: 'destination-1',
      provider: 'gdrive',
      name: 'Drive',
      url: 'https://drive.example.com/released',
    }]
    draft.downloadUrls = [{
      destId: 'destination-1',
      provider: 'gdrive',
      name: 'Drive',
      url: 'https://drive.example.com/draft',
    }]

    render(
      <AssetPreviewPanel
        asset={parent}
        selectedAsset={parent}
        children={[released, draft]}
        childView="grid"
        setChildView={vi.fn()}
        carouselIdx={0}
        lightboxIndex={0}
        onFocus={vi.fn()}
        onCloseLightbox={vi.fn()}
        role="member"
        userId="user-1"
        isStaff={false}
        accent="#000"
        bumpDownloads={vi.fn()}
        visibleDests={[{
          id: 'destination-1',
          name: 'Drive',
          role: 'client',
          minRole: 'member',
          exportLayout: 'folders',
          includePackages: false,
          generateLink: true,
          showInPortal: true,
          allowRevealLocal: false,
          enabled: true,
          config: { type: 'local', path: '' },
        }]}
      />,
    )

    expect(screen.getByTestId('download-released')).toHaveTextContent(released.downloadUrl!)
    expect(screen.getByTestId('download-draft')).toHaveTextContent('locked')
    expect(screen.getByTestId('cloud-released')).toHaveTextContent('1')
    expect(screen.getByTestId('cloud-draft')).toHaveTextContent('0')
  })
})
