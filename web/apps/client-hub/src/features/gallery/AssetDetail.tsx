import { useState, useMemo } from 'react'
import type { Asset } from '@dc-hub/asset-library'
import { canDownload, canRate, canReadComments, canSeeStats } from '@dc-hub/asset-library'
import { useRole } from '../../context/RoleContext'
import { useAuth } from '../../context/AuthContext'
import { webAssetActions } from '../../lib/assetActions'
import { assetFacetLabels } from '../../services/assetService'
import { trackEvent } from '../../services/eventService'
import { revealInDesktop } from '../../services/revealService'
import { sharedLabels, uniqueLabel, matchesActiveFacets } from './assetFacets'
import { StarRating } from './StarRating'
import { AssetCommentsPanel } from './panels/AssetCommentsPanel'
import { AssetStatusPanel } from './panels/AssetStatusPanel'
import { AssetPreviewPanel } from './panels/AssetPreviewPanel'
import { useAssetChildren } from './hooks/useAssetChildren'
import { useAssetRating } from './hooks/useAssetRating'
import { useAssetEvents } from './hooks/useAssetEvents'
import { useAssetComments } from './hooks/useAssetComments'
import { useAssetLifecycle } from './hooks/useAssetLifecycle'
import { useAssetDestinations } from './hooks/useAssetDestinations'
// Good-practice naming convention: variants of one asset share the same tags and differ
// only in a distinguishing bit of text/tag before the version. So the asset's displayed
// name is the tags common to every variant, and each variant's own label is just its
// distinguishing part — not the full (repetitive) name.

interface Props {
  asset: Asset
  onClose?: () => void
  mount: 'drawer' | 'page'
  onStatusChange?: () => void
  // Facets currently applied in the gallery filter rail — used to surface whichever variant
  // actually matched the filter (e.g. a tag that only lives on one variant) instead of leaving
  // it buried in alphabetical order.
  activeFacets?: { entities?: string[]; formats?: string[]; angles?: string[] }
  /** When opening from a hover tile, focus this child/variant id inside the detail. */
  focusAssetId?: string
  /** Also open the lightbox on the focused child (gallery tile click). */
  autoOpenLightbox?: boolean
}

export default function AssetDetail({ asset, onClose, mount, onStatusChange, activeFacets, focusAssetId, autoOpenLightbox }: Props) {
  const { role, activeClient } = useRole()
  const { session } = useAuth()
  const userId = session?.user?.id ?? null
  const accent = activeClient?.accent ?? '#161616'
  const isStaff = role === 'admin' || role === 'editor' || role === 'super_admin'

  /* State lives in ./hooks/* — one hook per concern, so an effect's dependencies are visible
     next to the state they drive rather than buried among 22 useState calls. */
  const {
    children, variants, childView, setChildView, carouselIdx, setCarouselIdx,
    selectedVariantId, setSelectedVariantId, lightboxIndex, setLightboxIndex,
  } = useAssetChildren(asset, focusAssetId, autoOpenLightbox)
  const { myRating, ratingSaved, changeRating: handleRatingChange } = useAssetRating(asset.id, userId, role)
  const { eventCounts, bumpDownloads } = useAssetEvents(asset.id, userId, role, isStaff)
  const {
    comments, commentInput, setCommentInput, commentBusy, commentThanks,
    submitComment: handleSubmitComment, removeComment: handleDeleteComment,
    onCommentKeyDown: handleCommentKeyDown,
  } = useAssetComments(asset.id, userId, role)
  const {
    currentStatus, currentPerm, statusBusy, statusError, permBusy, deleteBusy, deleteError,
    changeStatus: handleStatusChange, approve: handleApprove,
    changePerm: handlePermChange, removeAsset: handleDelete,
  } = useAssetLifecycle(asset, onStatusChange, onClose)

  const [note, setNote] = useState('')
  // Folder-based stable identity variants (Task 3) — format/size siblings of this asset,
  // distinct from gallery `children` above (those are preview images, not download choices).
  // Whichever variant actually matched the active gallery filter (e.g. a tag that only lives
  // on this one variant) leads the list, rather than sitting wherever it falls alphabetically.
  const sortedVariants = useMemo(() => {
    if (!activeFacets) return variants
    return [...variants].sort((a, b) => {
      const aMatch = matchesActiveFacets(a, activeFacets)
      const bMatch = matchesActiveFacets(b, activeFacets)
      return aMatch === bMatch ? 0 : aMatch ? -1 : 1
    })
  }, [variants, activeFacets])
  const selectedAsset = sortedVariants.find(v => v.id === selectedVariantId) ?? asset
  const shared      = sortedVariants.length > 0 ? sharedLabels([asset, ...sortedVariants]) : []
  const displayName = shared.length > 0 ? shared.join(' ') : asset.name

  // Comments

  const {
    visibleDests, cloudLinks, canReveal,
    revealBusy, setRevealBusy, revealMsg, setRevealMsg,
  } = useAssetDestinations(activeClient?.id, role, isStaff, selectedAsset, asset)

  const content = (
    <div className="flex flex-col h-full overflow-y-auto bg-bg">
      {/* Close / header */}
      {onClose && (
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <span className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
            {activeClient?.name ?? ''} · {asset.version}
          </span>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-cosmos-black transition-colors text-lg leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>
      )}

      <div className="px-6 py-5 space-y-6">
        <AssetPreviewPanel
          asset={asset}
          selectedAsset={selectedAsset}
          children={children}
          childView={childView}
          setChildView={setChildView}
          carouselIdx={carouselIdx}
          setCarouselIdx={setCarouselIdx}
          lightboxIndex={lightboxIndex}
          setLightboxIndex={setLightboxIndex}
          role={role}
          userId={userId}
          isStaff={isStaff}
          accent={accent}
          bumpDownloads={bumpDownloads}
          visibleDests={visibleDests}
        />

        {/* Title + meta */}
        <div>
          <h2 className="font-serif text-xl font-medium text-cosmos-black leading-tight tracking-tight mb-1">
            {displayName}
          </h2>
          <p className="text-[11px] font-sans text-text-muted">
            {activeClient?.name} · {asset.version} · updated recently
          </p>
        </div>

        {/* Tags — entity / angle / format, deduped if the same label appears in more than one dimension */}
        <div className="flex flex-wrap gap-1.5">
          {assetFacetLabels(asset).map(label => (
            <span key={label} className="text-[11px] font-sans font-medium bg-gray-150 px-2 py-1 rounded-chip">
              {label}
            </span>
          ))}
        </div>

        {/* Variant selector — format/size siblings sharing one folder identity (Task 3).
            Deliberately NOT called "version" — DC Hub already has a separate, unrelated
            version-history concept (semantic version numbers, latest flag); this is about
            different renditions of the same asset (format, size, background, etc). */}
        {sortedVariants.length > 0 && (
          <div>
            <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-2">
              Variants · {sortedVariants.length + 1}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {[asset, ...sortedVariants].map((v, i) => (
                <button
                  key={v.id}
                  onClick={() => setSelectedVariantId(v.id)}
                  title={v.name}
                  className={`text-[11px] font-sans font-medium px-2.5 py-1.5 rounded-chip border transition-colors max-w-35 truncate ${
                    selectedVariantId === v.id
                      ? 'bg-cosmos-black text-clear-white border-cosmos-black'
                      : 'border-border text-text-muted hover:border-cosmos-black'
                  }`}
                >
                  {uniqueLabel(v, shared) || v.name || `Variant ${i + 1}`}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* View / download counts — staff only */}
        {isStaff && (
          <div className="flex gap-4 text-[11px] font-sans text-text-muted">
            <span>👁 {eventCounts.views} views</span>
            <span>↓ {eventCounts.downloads} downloads</span>
          </div>
        )}

        {/* Rating — stats visible to all; the star input needs a user session */}
        {canSeeStats(role) && (
          <div className="border border-border rounded-sm p-4 flex items-center justify-between">
            <div>
              <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-2">
                {userId && canRate(role) ? 'Your rating' : 'Rating'}
              </p>
              {userId && canRate(role) && (
                <>
                  <StarRating value={myRating} onChange={handleRatingChange} />
                  {ratingSaved && (
                    <p className="text-[10px] font-sans text-text-muted mt-1 transition-opacity">
                      Saved
                    </p>
                  )}
                </>
              )}
            </div>
            <div className="text-right">
              <p className="font-serif text-3xl font-medium leading-none text-cosmos-black">
                {asset.avg.toFixed(1)}
              </p>
              <p className="text-[11px] font-sans text-text-muted mt-1">
                {asset.count} ratings
              </p>
            </div>
          </div>
        )}

        <AssetStatusPanel
          role={role}
          isStaff={isStaff}
          accent={accent}
          currentStatus={currentStatus}
          currentPerm={currentPerm}
          statusBusy={statusBusy}
          statusError={statusError}
          permBusy={permBusy}
          deleteBusy={deleteBusy}
          deleteError={deleteError}
          onStatusChange={handleStatusChange}
          onPermChange={handlePermChange}
          onApprove={handleApprove}
          onDelete={handleDelete}
          note={note}
          setNote={setNote}
        />
        {/* Download — tracks/downloads whichever variant is selected above, defaulting to this asset */}
        {canDownload(role, asset) && (
          <div className="space-y-2">
            <button
              onClick={() => {
                trackEvent(selectedAsset.id, 'download', userId, role).catch(() => {})
                bumpDownloads()
                webAssetActions.download?.(selectedAsset)
              }}
              className="w-full py-3 text-sm font-sans font-semibold text-clear-white rounded-sm transition-all active:translate-y-px"
              style={{
                backgroundColor: accent,
                boxShadow: `5px 5px 0 #161616`,
              }}
            >
              ↓ Download
            </button>

            {cloudLinks.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
                  Source links
                </p>
                {cloudLinks.map(link => (
                  <a
                    key={`${link.destId ?? link.name}-${link.url}`}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between gap-2 w-full px-3 py-2 text-[12px] font-sans border border-border rounded-sm hover:border-cosmos-black transition-colors"
                  >
                    <span className="font-semibold truncate">{link.name || link.provider}</span>
                    <span className="text-[10px] uppercase tracking-label text-text-muted shrink-0">
                      {link.provider}
                    </span>
                  </a>
                ))}
              </div>
            )}

            {canReveal && (
              <div className="space-y-1">
                <button
                  type="button"
                  disabled={revealBusy}
                  onClick={async () => {
                    const sid = selectedAsset.stableId ?? asset.stableId
                    if (!sid || !activeClient?.id) return
                    setRevealBusy(true)
                    setRevealMsg('')
                    const result = await revealInDesktop(activeClient.id, sid)
                    setRevealBusy(false)
                    setRevealMsg(result.ok ? 'Opened in Finder / Explorer' : result.error)
                  }}
                  className="w-full py-2.5 text-sm font-sans font-semibold border border-cosmos-black rounded-sm text-cosmos-black hover:bg-gray-100 transition-colors disabled:opacity-50"
                >
                  {revealBusy ? 'Revealing…' : 'Reveal in Finder'}
                </button>
                {revealMsg && (
                  <p className="text-[11px] font-sans text-text-muted">{revealMsg}</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Reveal for staff even when download is gated (e.g. draft) */}
        {!canDownload(role, asset) && canReveal && isStaff && (
          <div className="space-y-1">
            <button
              type="button"
              disabled={revealBusy}
              onClick={async () => {
                const sid = selectedAsset.stableId ?? asset.stableId
                if (!sid || !activeClient?.id) return
                setRevealBusy(true)
                setRevealMsg('')
                const result = await revealInDesktop(activeClient.id, sid)
                setRevealBusy(false)
                setRevealMsg(result.ok ? 'Opened in Finder / Explorer' : result.error)
              }}
              className="w-full py-2.5 text-sm font-sans font-semibold border border-cosmos-black rounded-sm text-cosmos-black hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              {revealBusy ? 'Revealing…' : 'Reveal in Finder'}
            </button>
            {revealMsg && (
              <p className="text-[11px] font-sans text-text-muted">{revealMsg}</p>
            )}
            <p className="text-[10px] font-sans text-text-subtle">
              Requires the desktop app running with this client’s source folder set.
            </p>
          </div>
        )}

        {/* Comments — members can read; only staff can post */}
        {canReadComments(role) && (
          <AssetCommentsPanel
            role={role}
            userId={userId}
            isStaff={isStaff}
            comments={comments}
            commentInput={commentInput}
            setCommentInput={setCommentInput}
            commentBusy={commentBusy}
            commentThanks={commentThanks}
            onSubmit={handleSubmitComment}
            onDelete={handleDeleteComment}
            onKeyDown={handleCommentKeyDown}
          />
        )}
      </div>
    </div>
  )

  if (mount === 'page') return <div className="max-w-xl mx-auto py-10 px-5">{content}</div>

  return (
    <div
      className="w-[400px] shrink-0 border-l border-border h-full overflow-hidden"
      style={{ animation: `dc-drawer-in var(--duration-base) var(--ease-dc) both` }}
    >
      {content}
    </div>
  )
}
