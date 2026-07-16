import { useState, useEffect, useMemo, useRef } from 'react'
import type { Asset } from '@dc-hub/asset-library'
import { canApprove, canDownload, canRate, canComment, MOCK_COMMENTS } from '@dc-hub/asset-library'
import { useRole } from '../../context/RoleContext'
import { useAuth } from '../../context/AuthContext'
import { webAssetActions } from '../../lib/assetActions'
import { updateAssetStatus, fetchChildAssets, fetchVariants, updateAssetPerm, deleteAsset } from '../../services/assetService'
import { fetchComments, addComment, deleteComment, type RealComment } from '../../services/commentService'
import { fetchMyRating, upsertRating } from '../../services/ratingService'
import { trackEvent, fetchEventCounts, type EventCounts } from '../../services/eventService'
import {
  fetchDestinations,
  destinationsVisibleToRole,
  roleAtLeast,
  type PortalDestination,
} from '../../services/destinationService'
import { revealInDesktop } from '../../services/revealService'
import { ImageLightbox } from './ImageLightbox'
import { isConfigured } from '../../lib/supabase'

// Good-practice naming convention: variants of one asset share the same tags and differ
// only in a distinguishing bit of text/tag before the version. So the asset's displayed
// name is the tags common to every variant, and each variant's own label is just its
// distinguishing part — not the full (repetitive) name.
function labelSet(a: Asset): Set<string> {
  return new Set([
    ...(a.entities?.length ? a.entities : [a.entity].filter(Boolean)),
    ...(a.angles?.length ? a.angles : [a.angle].filter(Boolean)),
    ...a.formats,
    ...(a.tagsAll ?? []),
  ])
}

function sharedLabels(rows: Asset[]): string[] {
  if (rows.length === 0) return []
  const sets = rows.map(labelSet)
  return [...sets[0]].filter(label => sets.every(s => s.has(label)))
}

function uniqueLabel(row: Asset, shared: string[]): string {
  let rest = row.name
  for (const label of shared) rest = rest.split(label).join(' ')
  rest = rest.replace(/\s+/g, ' ').replace(/^[\s—-]+|[\s—-]+$/g, '').trim()
  return rest || row.name
}

const STATUS_OPTIONS: { value: Asset['status']; label: string }[] = [
  { value: 'draft',        label: 'Draft' },
  { value: 'review',       label: 'In review' },
  { value: 'approved',     label: 'Approved' },
  { value: 'published',    label: 'Published' },
  { value: 'archived',     label: 'Archived' },
  { value: 'disconnected', label: 'Disconnected' },
]

const PERM_OPTIONS: { value: Asset['perm']; label: string }[] = [
  { value: 'public',   label: 'Public' },
  { value: 'client',   label: 'Client' },
  { value: 'internal', label: 'Internal' },
]

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

function matchesActiveFacets(a: Asset, facets?: Props['activeFacets']): boolean {
  if (!facets) return false
  const entityPool = a.entities?.length ? a.entities : [a.entity]
  const anglePool   = a.angles?.length ? a.angles : [a.angle]
  return (
    (facets.entities?.some(e => entityPool.includes(e)) ?? false) ||
    (facets.formats?.some(f => a.formats.includes(f)) ?? false) ||
    (facets.angles?.some(g => anglePool.includes(g)) ?? false)
  )
}

function StarRating({ value, onChange }: { value: number; onChange?: (v: number) => void }) {
  const [hovered, setHovered] = useState(0)
  const [selected, setSelected] = useState(value)
  // Sync when parent value changes (initial DB load)
  useEffect(() => { setSelected(value) }, [value])

  const display = hovered || selected
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(n => (
        <button
          key={n}
          type="button"
          onClick={() => { setSelected(n); onChange?.(n) }}
          onMouseEnter={() => onChange && setHovered(n)}
          onMouseLeave={() => onChange && setHovered(0)}
          className={`text-xl leading-none transition-colors ${
            n <= display ? 'text-cosmos-black' : 'text-gray-300'
          } ${onChange ? 'cursor-pointer' : 'cursor-default'}`}
          aria-label={`Rate ${n} star${n > 1 ? 's' : ''}`}
        >
          ★
        </button>
      ))}
    </div>
  )
}


export default function AssetDetail({ asset, onClose, mount, onStatusChange, activeFacets, focusAssetId, autoOpenLightbox }: Props) {
  const { role, activeClient } = useRole()
  const { session } = useAuth()
  const userId = session?.user?.id ?? null

  const [myRating, setMyRating] = useState(0)
  const [ratingSaved, setRatingSaved] = useState(false)
  const [note, setNote] = useState('')
  const [currentStatus, setCurrentStatus] = useState<Asset['status']>(asset.status)
  const [currentPerm, setCurrentPerm] = useState<Asset['perm']>(asset.perm)
  const [statusBusy, setStatusBusy] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [permBusy, setPermBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [children, setChildren] = useState<Asset[]>([])
  const [childView, setChildView] = useState<'grid' | 'carousel'>('grid')
  const [carouselIdx, setCarouselIdx] = useState(0)
  // Folder-based stable identity variants (Task 3) — format/size siblings of this asset,
  // distinct from legacy gallery `children` above (those are preview images, not download choices).
  const [variants, setVariants] = useState<Asset[]>([])
  const [selectedVariantId, setSelectedVariantId] = useState<string>(asset.id)
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
  const [comments, setComments] = useState<RealComment[]>([])
  const [commentInput, setCommentInput] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  const [commentThanks, setCommentThanks] = useState(false)
  const thanksTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [eventCounts, setEventCounts] = useState<EventCounts>({ views: 0, downloads: 0 })
  const [destinations, setDestinations] = useState<PortalDestination[]>([])
  const [revealBusy, setRevealBusy] = useState(false)
  const [revealMsg, setRevealMsg] = useState('')
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  const accent = activeClient?.accent ?? '#161616'
  const isStaff = role === 'admin' || role === 'editor'

  // Portal destination defs — role-gate cloud share links + Reveal
  useEffect(() => {
    if (!activeClient?.id || !isConfigured()) return
    fetchDestinations(activeClient.id).then(setDestinations).catch(() => setDestinations([]))
  }, [activeClient?.id])

  const visibleDests = useMemo(
    () => destinationsVisibleToRole(destinations, role),
    [destinations, role],
  )

  const cloudLinks = useMemo(() => {
    const urls = selectedAsset.downloadUrls ?? []
    if (urls.length === 0) return []
    return urls.filter(link => {
      const dest = visibleDests.find(d =>
        (link.destId && d.id === link.destId) || d.name === link.name,
      )
      // Unknown dest (legacy link without matching def): show to staff only
      if (!dest) return isStaff
      return true
    })
  }, [selectedAsset.downloadUrls, visibleDests, isStaff])

  const canReveal = useMemo(() => {
    const sid = selectedAsset.stableId ?? asset.stableId
    if (!sid) return false
    // Staff can always try Reveal when the package has a stable id (desktop bridge).
    if (isStaff) return true
    return destinations.some(d =>
      d.enabled && d.allowRevealLocal && roleAtLeast(role, d.minRole),
    )
  }, [destinations, role, selectedAsset.stableId, asset.stableId, isStaff])

  // Track view + load event counts
  useEffect(() => {
    if (!isConfigured()) return
    trackEvent(asset.id, 'view', userId, role).catch(() => {})
    if (isStaff) fetchEventCounts(asset.id).then(setEventCounts).catch(console.error)
  }, [asset.id])

  // Load children (legacy gallery preview images) and variants (Task 3 format/size siblings)
  useEffect(() => {
    if ((asset.childCount ?? 0) > 0) {
      Promise.all([
        fetchChildAssets(asset.id).catch(() => [] as Asset[]),
        fetchVariants(asset.id).catch(() => [] as Asset[]),
      ]).then(([kids, vars]) => {
        setChildren(kids)
        setVariants(vars)
        if (focusAssetId) {
          const childIdx = kids.findIndex(c => c.id === focusAssetId)
          if (childIdx >= 0) {
            setChildView('carousel')
            setCarouselIdx(childIdx)
            setSelectedVariantId(asset.id)
            if (autoOpenLightbox) {
              const withSrc = kids.filter(c => c.thumbnailUrl || c.downloadUrl)
              const lbIdx = withSrc.findIndex(c => c.id === focusAssetId)
              if (lbIdx >= 0) setLightboxIndex(lbIdx)
            }
            return
          }
          if (vars.some(v => v.id === focusAssetId) || focusAssetId === asset.id) {
            setSelectedVariantId(focusAssetId)
          }
        }
        if (autoOpenLightbox && kids.length === 0) {
          // Single / variant focus — open lightbox on the selected asset when it has media
          if (asset.thumbnailUrl || asset.downloadUrl) setLightboxIndex(0)
        }
      })
    } else {
      setChildren([])
      setVariants([])
      if (autoOpenLightbox && (asset.thumbnailUrl || asset.downloadUrl)) {
        setLightboxIndex(0)
      }
    }
    setCarouselIdx(0)
    setSelectedVariantId(focusAssetId && focusAssetId !== asset.id ? focusAssetId : asset.id)
  }, [asset.id, asset.childCount, focusAssetId, autoOpenLightbox])

  // Reset local status/perm when asset changes
  useEffect(() => {
    setCurrentStatus(asset.status)
    setCurrentPerm(asset.perm)
    setStatusError(null)
  }, [asset.id])

  // Load user's existing rating on mount / asset change
  useEffect(() => {
    if (!userId || !canRate(role)) return
    if (!isConfigured()) return
    fetchMyRating(asset.id, userId).then(setMyRating).catch(console.error)
  }, [asset.id, userId, role])

  // Load comments on mount / asset change
  useEffect(() => {
    if (!canComment(role)) return
    if (isConfigured()) {
      fetchComments(asset.id).then(setComments).catch(console.error)
    } else {
      // Fallback to mock comments
      const mock = MOCK_COMMENTS.filter(c => c.assetId === asset.id)
      const realMock: RealComment[] = mock.map(c => ({
        id: c.id,
        assetId: c.assetId,
        userId: '',
        authorName: c.author,
        authorInitials: c.author.split(' ').map(w => w[0]).join('').slice(0, 2),
        authorRole: c.role,
        body: c.body,
        createdAt: c.createdAt,
      }))
      setComments(realMock)
    }
  }, [asset.id, role])

  // Cleanup thanks timer on unmount
  useEffect(() => {
    return () => {
      if (thanksTimerRef.current) clearTimeout(thanksTimerRef.current)
    }
  }, [])

  async function handleStatusChange(newStatus: Asset['status']) {
    if (newStatus === currentStatus || statusBusy) return
    setStatusBusy(true)
    setStatusError(null)
    try {
      await updateAssetStatus(asset.id, newStatus)
      setCurrentStatus(newStatus)
      onStatusChange?.()
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Failed to update status')
    } finally {
      setStatusBusy(false)
    }
  }

  async function handleApprove() {
    await handleStatusChange('approved')
  }

  async function handleDelete() {
    if (deleteBusy) return
    if (!window.confirm(`Permanently delete "${asset.name}"? This cannot be undone.`)) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await deleteAsset(asset.id)
      onStatusChange?.()
      onClose?.()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete asset')
      setDeleteBusy(false)
    }
  }

  async function handlePermChange(newPerm: Asset['perm']) {
    if (newPerm === currentPerm || permBusy) return
    setPermBusy(true)
    try {
      await updateAssetPerm(asset.id, newPerm)
      setCurrentPerm(newPerm)
    } catch (err) {
      console.error('Failed to update perm:', err)
    } finally {
      setPermBusy(false)
    }
  }

  async function handleRatingChange(value: number) {
    setMyRating(value)
    if (!userId) return
    try {
      await upsertRating(asset.id, userId, value)
      setRatingSaved(true)
      setTimeout(() => setRatingSaved(false), 2000)
    } catch (err) {
      console.error('Failed to save rating:', err)
    }
  }

  async function handleSubmitComment() {
    const body = commentInput.trim()
    if (!body || !userId || commentBusy) return
    setCommentBusy(true)
    try {
      const newComment = await addComment(asset.id, userId, body)
      setComments(prev => [...prev, newComment])
      setCommentInput('')
      setCommentThanks(true)
      if (thanksTimerRef.current) clearTimeout(thanksTimerRef.current)
      thanksTimerRef.current = setTimeout(() => setCommentThanks(false), 3000)
    } catch (err) {
      console.error('Failed to add comment:', err)
    } finally {
      setCommentBusy(false)
    }
  }

  async function handleDeleteComment(id: string) {
    try {
      await deleteComment(id)
      setComments(prev => prev.filter(c => c.id !== id))
    } catch (err) {
      console.error('Failed to delete comment:', err)
    }
  }

  function handleCommentKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmitComment()
    }
  }

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
        {/* Preview: show children grid/carousel if they exist, else parent thumbnail */}
        {children.length > 0 ? (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
                Files · {children.length}
              </p>
              <div className="flex gap-1">
                <button
                  onClick={() => setChildView('grid')}
                  className={`text-[10px] font-sans font-bold uppercase tracking-label px-2 py-1 rounded-chip border transition-colors ${
                    childView === 'grid'
                      ? 'bg-cosmos-black text-clear-white border-cosmos-black'
                      : 'border-border text-text-muted hover:border-cosmos-black'
                  }`}
                >
                  Grid
                </button>
                <button
                  onClick={() => { setChildView('carousel'); setCarouselIdx(0) }}
                  className={`text-[10px] font-sans font-bold uppercase tracking-label px-2 py-1 rounded-chip border transition-colors ${
                    childView === 'carousel'
                      ? 'bg-cosmos-black text-clear-white border-cosmos-black'
                      : 'border-border text-text-muted hover:border-cosmos-black'
                  }`}
                >
                  Slide
                </button>
              </div>
            </div>

            {childView === 'grid' ? (
              <div className="grid grid-cols-2 gap-2">
                {children.map((child, i) => (
                  <button
                    key={child.id}
                    type="button"
                    onClick={() => {
                      const withSrc = children.filter(c => c.thumbnailUrl || c.downloadUrl)
                      const idx = withSrc.findIndex(c => c.id === child.id)
                      if (idx >= 0) setLightboxIndex(idx)
                    }}
                    className="aspect-square rounded-sm overflow-hidden relative text-left cursor-zoom-in hover:ring-1 hover:ring-cosmos-black transition-shadow"
                    style={{ backgroundColor: `color-mix(in srgb, ${accent} 50%, #000)` }}
                  >
                    {child.thumbnailUrl
                      ? <img referrerPolicy="no-referrer" src={child.thumbnailUrl} alt={child.name} className="w-full h-full object-contain" />
                      : <div className="w-full h-full flex items-center justify-center text-text-muted text-xs font-sans">{i + 1}</div>
                    }
                  </button>
                ))}
              </div>
            ) : (
              <div className="relative">
                <button
                  type="button"
                  className="aspect-square w-full rounded-sm overflow-hidden cursor-zoom-in"
                  style={{ backgroundColor: `color-mix(in srgb, ${accent} 50%, #000)` }}
                  onClick={() => {
                    const withSrc = children.filter(c => c.thumbnailUrl || c.downloadUrl)
                    const idx = withSrc.findIndex(c => c.id === children[carouselIdx]?.id)
                    if (idx >= 0) setLightboxIndex(idx)
                  }}
                >
                  {children[carouselIdx]?.thumbnailUrl
                    ? <img referrerPolicy="no-referrer" src={children[carouselIdx].thumbnailUrl} alt={children[carouselIdx].name} className="w-full h-full object-contain" />
                    : <div className="w-full h-full bg-gray-150" />
                  }
                </button>
                <div className="flex items-center justify-between mt-2">
                  <button
                    onClick={() => setCarouselIdx(i => Math.max(0, i - 1))}
                    disabled={carouselIdx === 0}
                    className="text-sm font-sans px-3 py-1 border border-border rounded-sm disabled:opacity-30 hover:border-cosmos-black transition-colors"
                  >
                    ←
                  </button>
                  <span className="text-[11px] font-sans text-text-muted">
                    {carouselIdx + 1} / {children.length}
                  </span>
                  <button
                    onClick={() => setCarouselIdx(i => Math.min(children.length - 1, i + 1))}
                    disabled={carouselIdx === children.length - 1}
                    className="text-sm font-sans px-3 py-1 border border-border rounded-sm disabled:opacity-30 hover:border-cosmos-black transition-colors"
                  >
                    →
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            className="aspect-square w-full rounded-sm overflow-hidden cursor-zoom-in"
            style={{ backgroundColor: `color-mix(in srgb, ${accent} 50%, #000)` }}
            onClick={() => selectedAsset.thumbnailUrl && setLightboxIndex(0)}
          >
            {selectedAsset.thumbnailUrl
              ? <img referrerPolicy="no-referrer" src={selectedAsset.thumbnailUrl} alt={selectedAsset.name} className="w-full h-full object-contain" />
              : <div className="w-full h-full bg-gray-150" />
            }
          </button>
        )}

        {lightboxIndex !== null && (
          <ImageLightbox
            items={(children.length > 0 ? children : [selectedAsset])
              .filter(a => a.thumbnailUrl || a.downloadUrl)
              .map(a => {
                const urls = a.downloadUrls ?? []
                const links = urls.filter(link => {
                  const dest = visibleDests.find(d =>
                    (link.destId && d.id === link.destId) || d.name === link.name,
                  )
                  if (!dest) return isStaff
                  return true
                })
                return {
                  src: a.downloadUrl || a.thumbnailUrl || '',
                  alt: a.name,
                  title: a.name,
                  downloadUrl: canDownload(role, asset) ? a.downloadUrl : undefined,
                  cloudLinks: links.map(l => ({
                    label: l.name || l.provider || 'Cloud',
                    url: l.url,
                  })),
                  assetId: a.id,
                }
              })
              .filter(i => i.src)}
            index={lightboxIndex}
            onClose={() => setLightboxIndex(null)}
            onIndexChange={setLightboxIndex}
            onDownload={item => {
              const pool = children.length > 0 ? children : [selectedAsset]
              const target = pool.find(a => a.id === item.assetId)
                ?? pool.find(a => a.downloadUrl === item.downloadUrl)
                ?? selectedAsset
              trackEvent(target.id, 'download', userId, role).catch(() => {})
              setEventCounts(c => ({ ...c, downloads: c.downloads + 1 }))
              webAssetActions.download?.(target)
            }}
          />
        )}

        {/* Title + meta */}
        <div>
          <h2 className="font-serif text-xl font-medium text-cosmos-black leading-tight tracking-tight mb-1">
            {displayName}
          </h2>
          <p className="text-[11px] font-sans text-text-muted">
            {activeClient?.name} · {asset.version} · updated recently
          </p>
        </div>

        {/* Tags */}
        <div className="flex flex-wrap gap-1.5">
          <span className="text-[11px] font-sans font-medium bg-gray-150 px-2 py-1 rounded-chip">
            {asset.entity}
          </span>
          {asset.formats.map(f => (
            <span key={f} className="text-[11px] font-sans font-medium bg-gray-150 px-2 py-1 rounded-chip">
              {f}
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

        {/* Rating — staff only */}
        {canRate(role) && (
          <div className="border border-border rounded-sm p-4 flex items-center justify-between">
            <div>
              <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-2">
                Your rating
              </p>
              <StarRating value={myRating} onChange={handleRatingChange} />
              {ratingSaved && (
                <p className="text-[10px] font-sans text-text-muted mt-1 transition-opacity">
                  Saved
                </p>
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

        {/* Status management (admin/editor) */}
        {isStaff && (
          <div className="space-y-2">
            <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
              Status
            </p>
            <div className="flex gap-2 items-center">
              <select
                value={currentStatus}
                onChange={e => handleStatusChange(e.target.value as Asset['status'])}
                disabled={statusBusy}
                className="flex-1 text-sm font-sans border border-border rounded-sm px-3 py-2 bg-bg text-cosmos-black focus:outline-none focus:border-cosmos-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {STATUS_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {(currentStatus === 'review' || currentStatus === 'draft') && (
                <button
                  onClick={handleApprove}
                  disabled={statusBusy}
                  className="px-4 py-2 text-sm font-sans font-semibold text-clear-white rounded-sm transition-all active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ backgroundColor: accent, boxShadow: `3px 3px 0 #161616` }}
                >
                  {statusBusy ? '…' : '✓ Approve'}
                </button>
              )}
              {currentStatus === 'disconnected' && (
                <button
                  onClick={handleDelete}
                  disabled={deleteBusy}
                  className="px-4 py-2 text-sm font-sans font-semibold text-red-600 border border-red-600 rounded-sm transition-all active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {deleteBusy ? '…' : 'Delete permanently'}
                </button>
              )}
            </div>
            {statusError && (
              <p className="text-xs font-sans text-red-600">{statusError}</p>
            )}
            {deleteError && (
              <p className="text-xs font-sans text-red-600">{deleteError}</p>
            )}
          </div>
        )}

        {/* Publicity / perm selector (staff only) */}
        {isStaff && (
          <div className="space-y-2">
            <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
              Visibility
            </p>
            <select
              value={currentPerm}
              onChange={e => handlePermChange(e.target.value as Asset['perm'])}
              disabled={permBusy}
              className="w-full text-sm font-sans border border-border rounded-sm px-3 py-2 bg-bg text-cosmos-black focus:outline-none focus:border-cosmos-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {PERM_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        )}

        {/* Decision (client-side approval) */}
        {canApprove(role) && !isStaff && (
          <div className="space-y-2">
            <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
              Your decision
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleApprove}
                disabled={statusBusy}
                className="flex-1 py-2.5 text-sm font-sans font-semibold text-clear-white rounded-sm transition-all active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  backgroundColor: accent,
                  boxShadow: `5px 5px 0 #161616`,
                }}
              >
                {statusBusy ? '…' : '✓ Approve'}
              </button>
              <button className="flex-1 py-2.5 text-sm font-sans font-semibold border border-cosmos-black rounded-sm text-cosmos-black hover:bg-gray-100 transition-colors">
                ↩ Request changes
              </button>
            </div>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Add a note for the team (optional)…"
              rows={2}
              className="w-full text-sm font-sans border border-border rounded-sm px-3 py-2 resize-none placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors"
            />
          </div>
        )}

        {/* Download — tracks/downloads whichever variant is selected above, defaulting to this asset */}
        {canDownload(role, asset) && (
          <div className="space-y-2">
            <button
              onClick={() => {
                trackEvent(selectedAsset.id, 'download', userId, role).catch(() => {})
                setEventCounts(c => ({ ...c, downloads: c.downloads + 1 }))
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

        {/* Comments — only for non-public roles */}
        {canComment(role) && (
          <div>
            <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-3">
              Comments · {comments.length}
            </p>
            <div className="space-y-4">
              {comments.map(c => (
                <div key={c.id} className="flex gap-3">
                  <div className="w-7 h-7 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center shrink-0">
                    <span className="text-clear-white text-[9px] font-bold font-sans">
                      {c.authorInitials}
                    </span>
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-sans font-semibold text-cosmos-black">{c.authorName}</span>
                      <span className="text-[9px] font-sans font-bold uppercase tracking-label border border-border px-1.5 py-0.5 rounded-chip text-text-muted">
                        {c.authorRole}
                      </span>
                      {isStaff && (
                        <button
                          onClick={() => handleDeleteComment(c.id)}
                          className="ml-auto text-text-muted hover:text-cosmos-black transition-colors text-base leading-none"
                          aria-label="Delete comment"
                        >
                          ×
                        </button>
                      )}
                    </div>
                    <p className="text-sm font-sans text-cosmos-black leading-snug">{c.body}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Comment composer */}
            <div className="mt-4 space-y-2">
              {commentThanks && (
                <p className="text-[11px] font-sans text-text-muted transition-opacity">
                  Thank you for your comment!
                </p>
              )}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={commentInput}
                  onChange={e => setCommentInput(e.target.value)}
                  onKeyDown={handleCommentKeyDown}
                  placeholder="Add a comment…"
                  disabled={commentBusy || !userId}
                  className="flex-1 text-sm font-sans border border-border rounded-sm px-3 py-2 placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors disabled:opacity-50"
                />
                <button
                  onClick={handleSubmitComment}
                  disabled={commentBusy || !commentInput.trim() || !userId}
                  className="px-4 py-2 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm hover:bg-ink-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {commentBusy ? '…' : 'Send'}
                </button>
              </div>
            </div>
          </div>
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
