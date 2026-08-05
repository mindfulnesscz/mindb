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
import { DocumentPagesPanel } from './panels/DocumentPagesPanel'
import { DisconnectedSubAssetsPanel } from './panels/DisconnectedSubAssetsPanel'
import { useAssetChildren } from './hooks/useAssetChildren'
import { useDetailFocus } from './hooks/useDetailFocus'
import type { DetailState } from './detailUrl'
import { useAssetRating } from './hooks/useAssetRating'
import { useAssetEvents } from './hooks/useAssetEvents'
import { useAssetComments } from './hooks/useAssetComments'
import { useAssetLifecycle } from './hooks/useAssetLifecycle'
import { useAssetDestinations } from './hooks/useAssetDestinations'
import { useStreamMedia } from './hooks/useStreamMedia'
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
  /** The child or variant focused inside the detail — a carousel position and a variant selection. */
  focusAssetId?: string
  /**
   * Whether the lightbox is up, on the focused item.
   *
   * Named for its original use — opening straight into the lightbox from a gallery hover tile. It is
   * now simply the lightbox's open state, because the portal keeps that in the URL as `lb=1` and
   * Back has to be able to close it.
   */
  autoOpenLightbox?: boolean
  /**
   * `focusAssetId` / `autoOpenLightbox` changed through interaction — a variant picked, the carousel
   * stepped, the lightbox opened or closed.
   *
   * Supplying this makes those two props CONTROLLED; the portal does, and writes them to the URL.
   * Omitting it leaves the detail to keep them locally, which is what `/share/:id` needs.
   *
   * One callback carrying both values, not two: see useDetailFocus.
   */
  onDetailStateChange?: (next: DetailState) => void
}

export default function AssetDetail({
  asset, onClose, mount, onStatusChange, activeFacets,
  focusAssetId, autoOpenLightbox, onDetailStateChange,
}: Props) {
  const { role, activeClient } = useRole()
  const { session } = useAuth()
  const userId = session?.user?.id ?? null
  const accent = activeClient?.accent ?? '#161616'
  const isStaff = role === 'admin' || role === 'editor' || role === 'super_admin'

  /* State lives in ./hooks/* — one hook per concern, so an effect's dependencies are visible
     next to the state they drive rather than buried among 22 useState calls. */
  const focus = useDetailFocus(asset.id, {
    focusAssetId, lightbox: autoOpenLightbox, onChange: onDetailStateChange,
  })
  const {
    children, variants, staleChildren, staleVariants, removeSubAsset,
    childView, setChildView,
  } = useAssetChildren(asset, isStaff, focus.focusId)
  const { myRating, ratingSaved, changeRating: handleRatingChange } = useAssetRating(asset.id, userId, role)
  const { eventCounts, bumpDownloads } = useAssetEvents(asset.id, userId, role, isStaff)
  const {
    comments, commentInput, setCommentInput, commentBusy, commentThanks,
    submitComment: handleSubmitComment, removeComment: handleDeleteComment,
    onCommentKeyDown: handleCommentKeyDown,
  } = useAssetComments(asset.id, userId, role)
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
  /* DERIVED from the focused id, not stored alongside it. An id survives a sibling being added or
     disconnected; an index does not, which is why the URL carries ids and the positions are computed
     here. A `focus` naming neither a child nor a variant of this asset is simply ignored — a stale or
     hand-edited link then opens the parent normally instead of showing nothing. */
  const selectedVariantId = focus.focusId && sortedVariants.some(v => v.id === focus.focusId)
    ? focus.focusId
    : asset.id
  const selectedAsset = sortedVariants.find(v => v.id === selectedVariantId) ?? asset
  const focusedChildIdx = focus.focusId ? children.findIndex(c => c.id === focus.focusId) : -1
  const carouselIdx = focusedChildIdx >= 0 ? focusedChildIdx : 0

  /* Gallery children that are videos. A folder of cuts is now recognised as a gallery (see
     dam/scan.ts), so the children grid can hold videos whose frame lives on Stream rather than in
     R2 — without this they render as empty tiles, the same way top-level video cards did. */
  const resolveStream = useStreamMedia(children)
  const previewChildren = useMemo(
    () => children.map(c => {
      if (c.thumbnailUrl || !c.streamUid) return c
      const media = resolveStream(c)
      return media ? { ...c, thumbnailUrl: media.still } : c
    }),
    [children, resolveStream],
  )

  /* The lightbox's index, also derived. The pool is the one the preview panel builds: gallery children
     when there are any, else the selected asset alone, minus anything with no media at all. */
  const lightboxPool = (previewChildren.length > 0 ? previewChildren : [selectedAsset])
    .filter(a => a.thumbnailUrl || a.downloadUrl)
  const focusedInPool = lightboxPool.findIndex(a => a.id === (focus.focusId ?? selectedAsset.id))
  const lightboxIndex = !focus.lightbox || lightboxPool.length === 0
    ? null
    // `lb=1` pointing at something with no media of its own still opens — on the first item that has.
    : Math.max(0, focusedInPool)

  const shared      = sortedVariants.length > 0 ? sharedLabels([asset, ...sortedVariants]) : []
  const displayName = shared.length > 0 ? shared.join(' ') : asset.name

  /* The lifecycle panel is bound to the SELECTED variant, not to the primary.
     It used to take `asset`, which is always the top-level row the grid opened — so the panel
     showed the primary's status and level whichever variant was picked, and switching between
     versions appeared to "remember" whatever was set last. Worse, an edit made while looking at
     one variant silently landed on the primary. A panel must act on the row it displays. */
  const {
    currentStatus, currentPerm, statusBusy, statusError, permBusy, permError,
    deleteBusy, deleteError,
    changeStatus: handleStatusChange, approve: handleApprove,
    changePerm: handlePermChange, removeAsset: handleDelete,
    isGalleryChild, canApplyToVariants, variantCount, applyToVariants, setApplyToVariants,
  } = useAssetLifecycle(selectedAsset, onStatusChange, onClose, variants)

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
          children={previewChildren}
          childView={childView}
          setChildView={setChildView}
          carouselIdx={carouselIdx}
          lightboxIndex={lightboxIndex}
          onFocus={focus.setFocus}
          onCloseLightbox={focus.closeLightbox}
          role={role}
          userId={userId}
          isStaff={isStaff}
          accent={accent}
          bumpDownloads={bumpDownloads}
          visibleDests={visibleDests}
        />

        {/* Page previews for a document. Renders nothing for anything without them, so it sits
            unconditionally between the preview and the title rather than behind a branch here. */}
        <DocumentPagesPanel
          asset={selectedAsset}
          onDownload={bumpDownloads}
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
                  /* The primary is `undefined` focus, not its own id: the URL's clean form for
                     "nothing special selected" is no `focus` param at all. */
                  onClick={() => focus.setFocus(v.id === asset.id ? undefined : v.id)}
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

        {/* Sub-assets whose file left the disk. Staff only, and deliberately NOT merged into the
            files grid or the variant picker above — a removed image is a loose end, not something
            to browse. This is the only surface in the portal that can reach them; see the panel's
            own header for why. */}
        {isStaff && (
          <DisconnectedSubAssetsPanel
            staleChildren={staleChildren}
            staleVariants={staleVariants}
            onRemove={removeSubAsset}
          />
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
          permError={permError}
          deleteBusy={deleteBusy}
          deleteError={deleteError}
          isGalleryChild={isGalleryChild}
          canApplyToVariants={canApplyToVariants}
          variantCount={variantCount}
          applyToVariants={applyToVariants}
          setApplyToVariants={setApplyToVariants}
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
