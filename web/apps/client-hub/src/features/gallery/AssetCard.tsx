/* The asset card — one tile in the gallery grid.
 *
 * Presentational: everything it renders comes from props. That is what will let the desktop app
 * mount the same card once the display layer is shared. Keep data fetching out of here.
 */

import { useEffect, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { canDownload, canSeeStats, canReadComments, type Asset, type Role } from '@dc-hub/asset-library'
import { assetFacetLabels } from '../../services/assetService'
import { webAssetActions } from '../../lib/assetActions'
import { MultiAssetHoverGrid, useSiblingPreviews, useDelayedHover, type SiblingPreview } from './MultiAssetHover'
import { STATUS_LABELS } from './statusLabels'

export function AssetCard({
  asset,
  onOpen,
  role,
  accent,
  animatedThumbUrl,
}: {
  asset: Asset
  onOpen: (focusId?: string, opts?: { lightbox?: boolean }) => void
  role: Role
  accent: string
  /** Cloudflare Stream animated preview, for video. Resolved upstream — see GalleryView. */
  animatedThumbUrl?: string
}) {
  const isMulti = (asset.childCount ?? 0) > 0
  const [pointerIn, setPointerIn] = useState(false)
  const hovered = useDelayedHover(pointerIn, 100)

  /* The animated preview is LAZY, and the reason is that its size is unpredictable. Measured on
     two real videos: 37 KB for a simple clip at the parameters used here, and 2.7 MB for a
     detailed one at Stream's defaults. Two orders of magnitude apart, decided by content nobody
     controls — so a grid that loaded them eagerly would be fine in testing and ruinous on the
     wrong shoot. The <img> is not rendered until the card has been hovered once, and once
     rendered it stays mounted and fades, so a second hover is instant off the browser cache.

     Reduced motion holds the still. An auto-playing loop is exactly what that preference is for,
     and the card is still fully usable without it. */
  const reduceMotion = useReducedMotion()
  const [everHovered, setEverHovered] = useState(false)
  useEffect(() => { if (hovered) setEverHovered(true) }, [hovered])
  // Not on multi cards: their hover belongs to the sibling grid, which covers this anyway, so
  // fetching a preview underneath it would be paid for and never seen.
  const showPreview = !!animatedThumbUrl && !reduceMotion && !isMulti && everHovered
  // Prefetch siblings for multi cards so a click (even before hover) can focus the first child.
  const { siblings, loading } = useSiblingPreviews(asset, isMulti)
  const restingThumb =
    asset.thumbnailUrl || siblings.find(s => s.thumbnailUrl)?.thumbnailUrl
  const fileCount = siblings.length > 1
    ? siblings.length
    : isMulti
      ? (asset.childCount ?? 0)
      : 1

  function handleSiblingSelect(s: SiblingPreview) {
    // Lightbox only for true gallery children (folder-of-images), not format/size variants.
    onOpen(s.id, { lightbox: !!s.isGalleryChild })
  }

  function handleCardOpen() {
    // Multi-asset / gallery: focus the first child or variant in detail (no lightbox).
    const first = siblings.find(s => s.id !== asset.id) ?? siblings[0]
    if (isMulti && first && first.id !== asset.id) {
      onOpen(first.id)
      return
    }
    onOpen()
  }

  return (
    <button
      type="button"
      onClick={handleCardOpen}
      onMouseEnter={() => setPointerIn(true)}
      onMouseLeave={() => setPointerIn(false)}
      onFocus={() => setPointerIn(true)}
      onBlur={() => setPointerIn(false)}
      className="group text-left w-full border border-border rounded-sm overflow-hidden bg-surface hover:border-cosmos-black transition-colors duration-base cursor-pointer"
    >
      <div className="relative aspect-square overflow-hidden cursor-pointer [transform-style:preserve-3d]">
        {restingThumb
          ? (
            <img
              referrerPolicy="no-referrer"
              src={restingThumb}
              alt={asset.name}
              className="relative z-[1] w-full h-full object-cover cursor-pointer"
            />
          )
          : <div className="relative z-[1] w-full h-full bg-gray-150" />
        }

        {showPreview && (
          <img
            referrerPolicy="no-referrer"
            src={animatedThumbUrl}
            alt=""
            aria-hidden
            className={`absolute inset-0 z-[2] w-full h-full object-cover pointer-events-none transition-opacity duration-base ${
              hovered ? 'opacity-100' : 'opacity-0'
            }`}
          />
        )}

        {/* A video card is otherwise indistinguishable from an image one until you open it. */}
        {asset.streamUid && (
          <span
            aria-hidden
            className="absolute inset-0 z-[3] flex items-center justify-center pointer-events-none"
          >
            <span className="w-9 h-9 rounded-full bg-cosmos-black/55 flex items-center justify-center transition-opacity duration-base group-hover:opacity-0">
              <span className="ml-[3px] border-y-[7px] border-y-transparent border-l-[11px] border-l-clear-white" />
            </span>
          </span>
        )}

        {isMulti && (
          <MultiAssetHoverGrid
            open={hovered}
            siblings={siblings}
            loading={loading}
            accent={accent}
            onSelect={handleSiblingSelect}
          />
        )}

        <div className="absolute top-2 left-2 flex gap-1 z-20 pointer-events-none">
          <span className="text-[10px] font-sans font-bold uppercase tracking-label border border-cosmos-black bg-clear-white px-1.5 py-0.5 rounded-chip">
            {STATUS_LABELS[asset.status]}
          </span>
          {isMulti && (
            <span
              className="text-[10px] font-sans font-bold uppercase tracking-label border border-cosmos-black bg-cosmos-black text-clear-white px-1.5 py-0.5 rounded-chip"
            >
              {fileCount} files
            </span>
          )}
        </div>
        {!asset.latest && (
          <div className="absolute bottom-2 left-2 z-20 text-[9px] font-sans font-bold uppercase tracking-label border border-cosmos-black bg-clear-white/90 px-1.5 py-0.5 rounded-chip pointer-events-none">
            older version
          </div>
        )}
        {asset.approval === 'pending' && (
          <div className="absolute bottom-2 right-2 z-20 text-[9px] font-sans font-bold uppercase tracking-label border border-cosmos-black bg-clear-white/90 px-1.5 py-0.5 rounded-chip pointer-events-none">
            awaiting you
          </div>
        )}
        {!isMulti && canDownload(role, asset) && asset.downloadUrl && (
          <span
            role="button"
            tabIndex={0}
            title="Download"
            className="absolute bottom-2 right-2 z-20 w-7 h-7 flex items-center justify-center rounded-[3px] border border-cosmos-black bg-clear-white/95 text-cosmos-black text-xs font-bold opacity-0 group-hover:opacity-100 focus-within:opacity-100 hover:!opacity-100 transition-opacity"
            onClick={e => {
              e.stopPropagation()
              void webAssetActions.download?.(asset)
            }}
            onMouseDown={e => e.stopPropagation()}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                void webAssetActions.download?.(asset)
              }
            }}
          >
            ↓
          </span>
        )}
      </div>

      <div className="px-3 pt-2.5 pb-3">
        <h3 className="font-sans text-sm font-semibold text-cosmos-black leading-tight mb-2">
          {asset.name}
        </h3>
        <div className="flex flex-wrap gap-1 mb-3">
          {assetFacetLabels(asset).map(label => (
            <span key={label} className="text-[11px] font-sans font-medium bg-gray-150 px-2 py-0.5 rounded-chip">
              {label}
            </span>
          ))}
          {asset.version?.trim() ? (
            <span className="text-[11px] font-sans font-medium border border-border px-2 py-0.5 rounded-chip text-text-muted">
              {asset.version}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-3 text-text-muted text-xs font-sans">
          {canSeeStats(role) && (
            <span>★ {asset.avg.toFixed(1)} ({asset.count})</span>
          )}
          {canReadComments(role) && <span>💬 {asset.comments}</span>}
        </div>
      </div>
    </button>
  )
}

// ── Skeletons ─────────────────────────────────────────────────

