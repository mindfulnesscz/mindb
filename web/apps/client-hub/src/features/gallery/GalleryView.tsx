/* Gallery view — the portal's main screen.
 *
 * Owns the data (useAssets, useTags) and the filter state; presentation lives in ./AssetCard,
 * ./FiltersRail and ./GalleryStates.
 */

import { useState, useMemo } from 'react'
import { useRole } from '../../context/RoleContext'
import { getDefaultFilters, type FilterState, type Asset } from '@dc-hub/asset-library'
import { useAssets } from '../../hooks/useAssets'
import { useTags, type TagsByDimension } from '../../hooks/useTags'
import { fetchAsset } from '../../services/assetService'
import AssetDetail from './AssetDetail'
import { AssetCard } from './AssetCard'
import { CardSkeleton, EmptyState, type EmptyReason } from './GalleryStates'
import { FiltersRail } from './FiltersRail'
import { STATUS_KEYS_STAFF, STATUS_KEYS_CLIENT } from './statusLabels'

export default function GalleryView() {
  const { role, activeClient } = useRole()
  const [filters, setFilters] = useState<FilterState>(getDefaultFilters())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusSiblingId, setFocusSiblingId] = useState<string | null>(null)
  const [openLightboxOnFocus, setOpenLightboxOnFocus] = useState(false)
  const [resolvedDetail, setResolvedDetail] = useState<Asset | null>(null)
  const [railVisible, setRailVisible] = useState(true)

  const isStaff = role === 'admin' || role === 'editor' || role === 'super_admin'
  const statusKeys = isStaff ? STATUS_KEYS_STAFF : STATUS_KEYS_CLIENT
  const accent = activeClient?.accent ?? '#161616'

  const clientId = activeClient?.id

  // Stable empty filters — used only for the options pool, never changes → fetches once per client
  const stableFilters = useMemo(() => getDefaultFilters(), [])
  const { assets: optionPool } = useAssets(stableFilters, role, clientId)

  const { assets, total, loading, error, usingMock, reload } = useAssets(filters, role, clientId)
  const tags = useTags(clientId)

  const statusCounts = assets.reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1
    return acc
  }, {})

  // Derive options from the stable unfiltered pool so options never disappear when filters are active.
  // useTags overrides when available (preserves sort_order from DB).
  const derivedEntities = [...new Set(optionPool.map(a => a.entity).filter(Boolean))].sort()
  const derivedFormats  = [...new Set(optionPool.flatMap(a => a.formats ?? []))].sort()
  const derivedAngles   = [...new Set(optionPool.map(a => a.angle).filter(Boolean))].sort()

  const effectiveTags: TagsByDimension = {
    entity: tags.entity.length > 0 ? tags.entity : derivedEntities,
    format: tags.format.length > 0 ? tags.format : derivedFormats,
    angle:  tags.angle.length  > 0 ? tags.angle  : derivedAngles,
    groups: tags.groups,
  }

  const dimensionLabels = {
    entity: activeClient?.dimensionLabels?.entity ?? 'Entity',
    format: activeClient?.dimensionLabels?.format ?? 'Format',
    angle:  activeClient?.dimensionLabels?.angle  ?? 'Angle',
  }

  const hasFiltersApplied =
    (filters.status?.length ?? 0) > 0 ||
    (filters.entityTypes?.length ?? 0) > 0 ||
    (filters.entities?.length ?? 0) > 0 ||
    (filters.formats?.length ?? 0) > 0 ||
    (filters.angles?.length ?? 0) > 0 ||
    (filters.perms?.length ?? 0) > 0 ||
    filters.search?.trim() !== '' ||
    filters.latestOnly

  const selectedAsset = selectedId
    ? assets.find(a => a.id === selectedId) ?? resolvedDetail
    : null

  /** Open a top-level card, or a hover-tile sibling (child/variant) focused inside the parent detail. */
  async function openAsset(primary: Asset, focusId?: string, opts?: { lightbox?: boolean }) {
    const wantLightbox = !!opts?.lightbox
    const targetId = focusId && focusId !== primary.id ? focusId : primary.id
    if (targetId === primary.id) {
      setFocusSiblingId(null)
      setOpenLightboxOnFocus(wantLightbox)
      setResolvedDetail(null)
      setSelectedId(primary.id)
      return
    }
    // Sibling may not be in the top-level list — resolve parent via DB, then focus.
    const row = await fetchAsset(targetId)
    if (!row) {
      setFocusSiblingId(null)
      setOpenLightboxOnFocus(false)
      setResolvedDetail(null)
      setSelectedId(primary.id)
      return
    }
    const parentId = row.parentId || row.variantOf || primary.id
    const parentInList = assets.find(a => a.id === parentId)
    if (parentInList) {
      setResolvedDetail(null)
      setFocusSiblingId(targetId)
      setOpenLightboxOnFocus(wantLightbox)
      setSelectedId(parentInList.id)
      return
    }
    const parent = parentId === primary.id ? primary : await fetchAsset(parentId)
    setResolvedDetail(parent ?? primary)
    setFocusSiblingId(targetId)
    setOpenLightboxOnFocus(wantLightbox)
    setSelectedId(parent?.id ?? primary.id)
  }

  function emptyReason(): EmptyReason {
    if (hasFiltersApplied) return 'filtered'
    if (role === 'public') return 'no-access'
    return 'no-assets'
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Filters rail */}
      {railVisible && (
        <FiltersRail
          filters={filters}
          onChange={setFilters}
          onHide={() => setRailVisible(false)}
          tags={effectiveTags}
          dimensionLabels={dimensionLabels}
          statusCounts={statusCounts}
          statusKeys={statusKeys}
          isStaff={isStaff}
          clientId={clientId}
          onDeletedDisconnected={() => reload()}
        />
      )}

      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border shrink-0">
          {!railVisible && (
            <button
              onClick={() => setRailVisible(true)}
              className="text-[11px] font-sans text-text-muted hover:text-cosmos-black transition-colors mr-1"
            >
              Filters
            </button>
          )}
          <input
            type="search"
            placeholder="Search assets…"
            value={filters.search}
            onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
            className="flex-1 text-sm font-sans border border-border rounded-sm px-3 py-1.5 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors"
          />
          <span className="text-[11px] font-sans text-text-muted whitespace-nowrap">
            {loading ? '—' : `${assets.length} of ${total} assets`}
            {usingMock && <span className="ml-1 opacity-50">(demo)</span>}
          </span>
          <button className="text-sm font-sans border border-border rounded-sm px-3 py-1.5 bg-bg text-cosmos-black hover:border-cosmos-black transition-colors whitespace-nowrap">
            Newest ↓
          </button>
        </div>

        {/* Grid / states */}
        <div className="flex-1 overflow-y-auto p-5">
          {error ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-8">
              <p className="font-serif text-lg font-medium text-cosmos-black mb-2">Connection error</p>
              <p className="font-sans text-sm text-text-muted max-w-sm">{error}</p>
            </div>
          ) : loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {Array.from({ length: 8 }).map((_, i) => <CardSkeleton key={i} />)}
            </div>
          ) : assets.length === 0 ? (
            <EmptyState reason={emptyReason()} />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {assets.map(asset => (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  onOpen={(focusId, opts) => { void openAsset(asset, focusId, opts) }}
                  role={role}
                  accent={accent}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Detail drawer */}
      {selectedAsset && (
        <AssetDetail
          asset={selectedAsset}
          onClose={() => {
            setSelectedId(null)
            setFocusSiblingId(null)
            setOpenLightboxOnFocus(false)
            setResolvedDetail(null)
          }}
          mount="drawer"
          onStatusChange={() => reload()}
          activeFacets={{ entities: filters.entities, formats: filters.formats, angles: filters.angles }}
          focusAssetId={focusSiblingId ?? undefined}
          autoOpenLightbox={openLightboxOnFocus}
        />
      )}
    </div>
  )
}

