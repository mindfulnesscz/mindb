// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Asset, Role } from '@sotto/asset-library'

vi.mock('motion/react', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('motion/react')
  return { ...actual, useReducedMotion: () => false }
})
vi.mock('./MultiAssetHover', () => ({
  MultiAssetHoverGrid: () => null,
  useSiblingPreviews: () => ({ siblings: [], loading: false }),
  useDelayedHover: (active: boolean) => active,
}))

const { AssetCard } = await import('./AssetCard')

const asset: Asset = {
  id: 'asset-1',
  clientId: 'client-1',
  name: 'Client-only original',
  entityType: 'product',
  entity: '',
  formats: [],
  angle: '',
  status: 'published',
  perm: 'client',
  version: 'v1',
  latest: true,
  avg: 0,
  count: 0,
  comments: 0,
  approval: 'none',
  thumbnailUrl: 'https://files.example.com/preview.webp',
  downloadUrl: 'https://files.example.com/original.tif',
  updatedAt: '2026-08-05',
}

function renderFailedPreview(role: Role) {
  render(<AssetCard asset={asset} onOpen={vi.fn()} role={role} accent="#000" />)
  fireEvent.error(screen.getByRole('img'))
}

describe('AssetCard fallback download', () => {
  it('stays hidden when the primary download control is forbidden', () => {
    renderFailedPreview('public')

    expect(screen.queryByRole('link', { name: 'Download' })).not.toBeInTheDocument()
    expect(screen.queryByTitle('Download')).not.toBeInTheDocument()
  })

  it('is offered when the primary download control is allowed', () => {
    renderFailedPreview('member')

    expect(screen.getByRole('link', { name: 'Download' }))
      .toHaveAttribute('href', asset.downloadUrl)
    expect(screen.getByTitle('Download')).toBeInTheDocument()
  })
})
