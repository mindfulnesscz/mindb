/* Gallery view — the portal's main screen.
 *
 * Owns the data (useAssets, useTags); presentation lives in ./AssetCard, ./FiltersRail and
 * ./GalleryStates.
 *
 * The filter state is NOT owned here — it lives in the query string, via useFilterParams. A filtered
 * view is therefore an address: it can be sent to someone, it survives a reload and a magic-link
 * round trip, and Back leaves the portal instead of doing nothing.
 */

import { useState, useMemo, useEffect } from 'react'
import { useNavigate, useLocation, useParams } from 'react-router-dom'
import { useRole } from '../../context/RoleContext'
import { getDefaultFilters, type Asset } from '@sotto/asset-library'
import { useFilterParams } from '../../hooks/useFilterParams'
import { useAssets } from '../../hooks/useAssets'
import { useTags, type TagsByDimension } from '../../hooks/useTags'
import AssetDetail from './AssetDetail'
import { AssetCard } from './AssetCard'
import {
  CardSkeleton, EmptyState, DetailSkeleton, DetailNotAvailable, type EmptyReason,
} from './GalleryStates'
import { readDetailParams, writeDetailParams, type DetailState } from './detailUrl'
import { useOpenAsset } from './hooks/useOpenAsset'
import { FiltersRail } from './FiltersRail'
import { useStreamMedia } from './hooks/useStreamMedia'
import { STATUS_KEYS_STAFF, STATUS_KEYS_CLIENT } from './statusLabels'
import { DEFAULT_DIMENSION_LABELS } from '@sotto/database'

/** How long typing has to stop before the search reaches the URL. */
const SEARCH_DEBOUNCE_MS = 250

export default function GalleryView() {
  const { role, activeClient } = useRole()
  /* Filters live in the query string, not in state: a filtered view is a place you can send someone,
     and a reload or a magic-link round trip returns to it. Same [value, setter] shape as the
     useState this replaces, including the updater form. */
  const [filters, setFilters] = useFilterParams()
  const [railVisible, setRailVisible] = useState(true)

  /* Which asset is open, and what is focused inside it, come from the URL — the path segment and the
     `focus`/`lb` params. `slug` types as optional but is always defined at runtime: GalleryView is
     rendered only from ClientPortalPage, which is only reachable on a `:slug` route. */
  const { slug, assetId } = useParams<{ slug: string; assetId?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { focusId: focusParam, lightbox } = readDetailParams(location.search)

  const isStaff = role === 'admin' || role === 'editor' || role === 'super_admin'
  const statusKeys = isStaff ? STATUS_KEYS_STAFF : STATUS_KEYS_CLIENT
  const accent = activeClient?.accent ?? '#161616'

  const clientId = activeClient?.id

  /* ── The search box ───────────────────────────────────────────────────────────────────────────
     Controlled by local state and pushed to the URL on the TRAILING EDGE, so typing writes one
     history-replace per pause rather than one per keystroke. It is not only about history noise:
     writing per keystroke re-parses the URL into a new FilterState mid-word, the input re-renders
     from it, and the caret jumps. The draft is adopted back whenever the URL's search changes from
     anywhere else — a cold load, Back, or Clear. */
  const [searchDraft, setSearchDraft] = useState(filters.search)
  useEffect(() => { setSearchDraft(filters.search) }, [filters.search])
  useEffect(() => {
    if (searchDraft === filters.search) return
    const t = window.setTimeout(
      () => setFilters(f => ({ ...f, search: searchDraft })),
      SEARCH_DEBOUNCE_MS,
    )
    return () => window.clearTimeout(t)
  }, [searchDraft, filters.search, setFilters])

  /* Stable empty filters — the OPTION POOL, not a view, so it deliberately stays out of the URL.
     Never changes → fetches once per client, and the rail keeps offering every tag even when a
     filter is applied. */
  const stableFilters = useMemo(() => getDefaultFilters(), [])
  const { assets: optionPool } = useAssets(stableFilters, role, clientId)

  const { assets, total, loading, error, usingMock, reload } = useAssets(filters, role, clientId)
  const tags = useTags(clientId)

  /* Video cards. Their frame lives on Cloudflare Stream rather than in R2, so `thumbnail_url` is
     null for them and the grid showed a grey tile — 9 of production's 10 videos, before this.
     Resolved here rather than in AssetCard because a gated video's URL needs a token that arrives
     asynchronously, and the card is presentational by contract. */
  const resolveStream = useStreamMedia(assets)
  const cardAssets = useMemo(
    () => assets.map(a => {
      if (!a.streamUid) return { asset: a, frames: undefined }
      const media = resolveStream(a)
      if (!media) return { asset: a, frames: undefined }
      return {
        asset: a.thumbnailUrl ? a : { ...a, thumbnailUrl: media.still },
        /* Only URLs are built here. Nothing is fetched until the card mounts the images, which it
           does on first hover. They span the whole video rather than its opening — Cloudflare's
           animated thumbnail caps at 15 contiguous seconds, so it could never cover a long cut. */
        frames: media.frames,
      }
    }),
    [assets, resolveStream],
  )

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

  // Always fully populated once a client came through `toClientIdentity`; the fallback covers
  // "no client selected yet".
  const dimensionLabels = activeClient?.dimensionLabels ?? DEFAULT_DIMENSION_LABELS

  const hasFiltersApplied =
    (filters.status?.length ?? 0) > 0 ||
    (filters.entityTypes?.length ?? 0) > 0 ||
    (filters.entities?.length ?? 0) > 0 ||
    (filters.formats?.length ?? 0) > 0 ||
    (filters.angles?.length ?? 0) > 0 ||
    (filters.perms?.length ?? 0) > 0 ||
    filters.search?.trim() !== '' ||
    filters.latestOnly

  const open = useOpenAsset(assetId, assets, focusParam)

  /**
   * Open a top-level card, or a hover-tile sibling focused inside its parent's detail.
   *
   * PUSHES. Opening an asset is a new place, and Back closing the drawer is what a
   * modal-over-a-list is expected to do. Filtering, by contrast, replaces.
   *
   * `location.search` is carried forward, so opening an asset cannot drop the filters — without it,
   * Back would return to an unfiltered grid.
   *
   * No fetch here any more. The card's own id goes in the path and the sibling's in `focus`; every
   * bit of resolution — including a path id that turns out to be a child — happens in useOpenAsset,
   * where it also runs for a cold load.
   */
  function openAsset(primary: Asset, focusId?: string, opts?: { lightbox?: boolean }) {
    const focus = focusId && focusId !== primary.id ? focusId : undefined
    navigate({
      pathname: `/${slug}/a/${primary.id}`,
      search: writeDetailParams(location.search, { focusId: focus, lightbox: !!opts?.lightbox }),
    })
  }

  /** Back to the grid, filters intact, `focus`/`lb` dropped. */
  function closeAsset() {
    navigate({ pathname: `/${slug}`, search: writeDetailParams(location.search, {}) })
  }

  /**
   * The drawer's own state — which sibling is focused, whether the lightbox is up — written back.
   *
   * PUSH only when the lightbox OPENS, so Back closes the lightbox and leaves the drawer up. Every
   * other write replaces: selecting a variant and stepping the carousel are refinements, and a
   * 40-frame scrub that pushed would bury the grid 40 entries deep. Closing the lightbox replaces
   * too, so the pair can never grow history on its own.
   */
  function setDetailState(next: DetailState) {
    const opensLightbox = next.lightbox && !lightbox
    navigate(
      { pathname: location.pathname, search: writeDetailParams(location.search, next) },
      { replace: !opensLightbox },
    )
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
            value={searchDraft}
            onChange={e => setSearchDraft(e.target.value)}
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
              {cardAssets.map(({ asset, frames }) => (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  previewFrames={frames}
                  onOpen={(focusId, opts) => openAsset(asset, focusId, opts)}
                  role={role}
                  accent={accent}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Detail drawer. Three states, because it is reachable by address: the asset is in hand
          (a click, or a link into the current grid), it is still being resolved, or the link points
          at something this viewer cannot see. An empty drawer is not one of them. */}
      {open.asset && (
        <AssetDetail
          asset={open.asset}
          onClose={closeAsset}
          mount="drawer"
          onStatusChange={() => reload()}
          activeFacets={{ entities: filters.entities, formats: filters.formats, angles: filters.angles }}
          focusAssetId={open.focusId}
          autoOpenLightbox={lightbox}
          onDetailStateChange={setDetailState}
        />
      )}
      {open.loading   && <DetailSkeleton />}
      {open.notFound  && <DetailNotAvailable onClose={closeAsset} />}
    </div>
  )
}

