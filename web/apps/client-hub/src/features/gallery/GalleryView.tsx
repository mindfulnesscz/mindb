import { useState, useMemo, useEffect } from 'react'
import { useRole } from '../../context/RoleContext'
import { getDefaultFilters, canDownload, type FilterState, type Asset } from '@dc-hub/asset-library'
import { useAssets } from '../../hooks/useAssets'
import { useTags, type TagsByDimension, type TagGroup } from '../../hooks/useTags'
import { deleteDisconnectedAssets, fetchAsset } from '../../services/assetService'
import { webAssetActions } from '../../lib/assetActions'
import AssetDetail from './AssetDetail'
import {
  MultiAssetHoverGrid,
  useSiblingPreviews,
  useDelayedHover,
  type SiblingPreview,
} from './MultiAssetHover'

const STATUS_LABELS: Record<string, string> = {
  draft:        'Draft',
  review:       'In review',
  approved:     'Approved',
  published:    'Published',
  archived:     'Archived',
  disconnected: 'Disconnected',
}

// ── Asset card ────────────────────────────────────────────────

function StackBackdrop({ count }: { count: number }) {
  const layers = Math.min(3, Math.max(1, count > 1 ? 3 : 1))
  return (
    <div className="absolute inset-0 pointer-events-none" aria-hidden>
      {Array.from({ length: layers }).map((_, i) => {
        const offset = (layers - 1 - i) * 3
        return (
          <div
            key={i}
            className="absolute rounded-[2px] border border-black/10 bg-gray-150"
            style={{
              inset: 0,
              transform: `translate(${offset}px, ${-offset}px)`,
              opacity: 0.35 + i * 0.15,
              zIndex: i,
            }}
          />
        )
      })}
    </div>
  )
}

function AssetCard({
  asset,
  onOpen,
  role,
}: {
  asset: Asset
  onOpen: (focusId?: string, opts?: { lightbox?: boolean }) => void
  role: string
}) {
  const isMulti = (asset.childCount ?? 0) > 0
  const [pointerIn, setPointerIn] = useState(false)
  const hovered = useDelayedHover(pointerIn, 80)
  // Prefetch siblings for multi cards so a click (even before hover) can focus the first child.
  const { siblings, loading } = useSiblingPreviews(asset, isMulti)
  const restingThumb =
    asset.thumbnailUrl || siblings.find(s => s.thumbnailUrl)?.thumbnailUrl
  const showStack = isMulti
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
      <div className="relative aspect-square overflow-hidden bg-gray-150 cursor-pointer [transform-style:preserve-3d]">
        {showStack && !hovered && <StackBackdrop count={fileCount} />}

        {restingThumb
          ? (
            <img
              referrerPolicy="no-referrer"
              src={restingThumb}
              alt={asset.name}
              className="relative z-[1] w-full h-full object-cover cursor-pointer"
            />
          )
          : <div className="relative z-[1] w-full h-full" />
        }

        {isMulti && (
          <MultiAssetHoverGrid
            open={hovered}
            siblings={siblings}
            loading={loading}
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
        {!isMulti && canDownload(role as 'public' | 'member' | 'editor' | 'admin', asset) && asset.downloadUrl && (
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
          <span className="text-[11px] font-sans font-medium bg-gray-150 px-2 py-0.5 rounded-chip">
            {asset.entity}
          </span>
          {asset.formats.map(f => (
            <span key={f} className="text-[11px] font-sans font-medium bg-gray-150 px-2 py-0.5 rounded-chip">
              {f}
            </span>
          ))}
          <span className="text-[11px] font-sans font-medium border border-border px-2 py-0.5 rounded-chip text-text-muted">
            {asset.version}
          </span>
        </div>
        <div className="flex items-center gap-3 text-text-muted text-xs font-sans">
          {role !== 'public' && (
            <span>★ {asset.avg.toFixed(1)} ({asset.count})</span>
          )}
          {role !== 'public' && <span>💬 {asset.comments}</span>}
        </div>
      </div>
    </button>
  )
}

// ── Skeletons ─────────────────────────────────────────────────

function CardSkeleton() {
  return (
    <div className="border border-border rounded-sm overflow-hidden bg-surface animate-pulse">
      <div className="aspect-square bg-gray-150" />
      <div className="p-3 space-y-2">
        <div className="h-3.5 bg-gray-150 rounded-chip w-3/4" />
        <div className="h-3 bg-gray-150 rounded-chip w-1/2" />
      </div>
    </div>
  )
}

// ── Empty states ──────────────────────────────────────────────

type EmptyReason = 'no-assets' | 'filtered' | 'no-access'

function EmptyState({ reason }: { reason: EmptyReason }) {
  const copy: Record<EmptyReason, { heading: string; body: string }> = {
    'no-assets':  { heading: 'No assets yet.',        body: 'Nothing has been delivered to this workspace yet.' },
    'filtered':   { heading: 'No matches.',           body: 'Nothing fits the current filters. Try clearing some.' },
    'no-access':  { heading: 'Nothing to see here.',  body: "You don't have access to any assets in this workspace." },
  }
  const { heading, body } = copy[reason]
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8">
      <p className="font-serif text-xl font-medium text-cosmos-black mb-2">{heading}</p>
      <p className="font-sans text-sm text-text-muted">{body}</p>
    </div>
  )
}

// ── Filters rail ──────────────────────────────────────────────

const STATUS_KEYS_STAFF: Asset['status'][]  = ['review', 'approved', 'published', 'draft', 'archived', 'disconnected']
const STATUS_KEYS_CLIENT: Asset['status'][] = ['review', 'approved', 'published', 'draft']

function TagItems({
  items,
  filterKey,
  selected,
  onToggle,
}: {
  items: string[]
  filterKey: 'entities' | 'formats' | 'angles'
  selected: string[]
  onToggle: (key: 'entities' | 'formats' | 'angles', val: string) => void
}) {
  return (
    <div className="space-y-0.5">
      {/* Dedupe — the same tag label can arrive twice (e.g. once per tag group),
          and duplicate React keys make rows drop or double. One checkbox per
          label is also the right filtering semantic. */}
      {[...new Set(items)].map(item => (
        <label key={item} className="flex items-center gap-2 py-0.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={selected?.includes(item) ?? false}
            onChange={() => onToggle(filterKey, item)}
            className="rounded-chip border-border accent-cosmos-black"
          />
          <span className="text-sm font-sans text-cosmos-black truncate">{item}</span>
        </label>
      ))}
    </div>
  )
}

function TagSubGroup({
  group,
  filterKey,
  selected,
  onToggle,
  onClear,
  collapseKey,
}: {
  group: TagGroup
  filterKey: 'entities' | 'formats' | 'angles'
  selected: string[]
  onToggle: (key: 'entities' | 'formats' | 'angles', val: string) => void
  onClear: (items: string[]) => void
  collapseKey: number
}) {
  const [open, setOpen] = useState(true)
  useEffect(() => { if (collapseKey > 0) setOpen(false) }, [collapseKey])
  const sel = selected ?? []
  const activeCount = group.items.filter(i => sel.includes(i)).length

  if (!group.name) {
    return <TagItems items={group.items} filterKey={filterKey} selected={sel} onToggle={onToggle} />
  }

  return (
    <div className="mb-1">
      <div className="flex items-center">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1 text-[10px] font-sans font-semibold uppercase tracking-label text-text-muted/60 flex-1 text-left py-0.5 hover:text-text-muted transition-colors"
        >
          <span className="w-3">{open ? '−' : '+'}</span>
          <span className="flex-1">{group.name}</span>
          {activeCount > 0 && (
            <span className="text-[9px] bg-cosmos-black text-clear-white rounded-pill px-1.5 py-0.5 leading-tight">
              {activeCount}
            </span>
          )}
        </button>
        {activeCount > 0 && (
          <button
            onClick={e => { e.stopPropagation(); onClear(group.items) }}
            className="ml-1 text-[17px] leading-none text-text-muted hover:text-cosmos-black transition-colors"
            title={`Clear ${group.name}`}
          >
            ×
          </button>
        )}
      </div>
      <div className={open ? 'mt-0.5 pl-3' : 'hidden'}>
        <TagItems items={group.items} filterKey={filterKey} selected={sel} onToggle={onToggle} />
      </div>
    </div>
  )
}

function TagSection({
  label,
  filterKey,
  items,
  groups,
  selected,
  filterQuery,
  open,
  collapseKey,
  onToggle,
  onClearSection,
  onClearGroup,
  onToggleItem,
}: {
  label: string
  filterKey: 'entities' | 'formats' | 'angles'
  items: string[]
  groups?: TagGroup[]
  selected: string[]
  filterQuery: string
  open: boolean
  collapseKey: number
  onToggle: () => void
  onClearSection: () => void
  onClearGroup: (items: string[]) => void
  onToggleItem: (key: 'entities' | 'formats' | 'angles', val: string) => void
}) {
  const q = (filterQuery ?? '').toLowerCase().trim()
  const safeItems = items ?? []
  const filteredItems = q ? safeItems.filter(i => i.toLowerCase().includes(q)) : safeItems
  const filteredGroups = groups
    ? (q
        ? groups.map(g => ({ ...g, items: g.items.filter(i => i.toLowerCase().includes(q)) })).filter(g => g.items.length > 0)
        : groups)
    : undefined

  if (filteredItems.length === 0 && !filteredGroups?.some(g => g.items.length > 0)) return null

  const useGroups = filteredGroups && filteredGroups.length > 0 && (filteredGroups.length > 1 || filteredGroups[0].name !== '')
  const selectedCount = selected?.length ?? 0

  return (
    <div className="mb-3">
      <div className="flex items-center">
        <button
          onClick={onToggle}
          className="flex items-center gap-1 text-[10px] font-sans font-bold uppercase tracking-label text-text-muted flex-1 text-left py-0.5 hover:text-cosmos-black transition-colors"
        >
          <span className="w-3">{open ? '−' : '+'}</span>
          <span className="flex-1">{label}</span>
          {selectedCount > 0 && (
            <span className="text-[9px] bg-cosmos-black text-clear-white rounded-pill px-1.5 py-0.5 leading-tight">
              {selectedCount}
            </span>
          )}
        </button>
        {selectedCount > 0 && (
          <button
            onClick={onClearSection}
            className="ml-1 text-[17px] leading-none text-text-muted hover:text-cosmos-black transition-colors"
            title={`Clear all ${label}`}
          >
            ×
          </button>
        )}
      </div>
      {/* CSS hide — preserves subgroup collapse states through parent toggle */}
      <div className={open ? 'mt-1 pl-4' : 'hidden'}>
        {useGroups ? (
          <div className="space-y-0.5">
            {filteredGroups!.map((g, i) => (
              <TagSubGroup
                key={g.id || i}
                group={g}
                filterKey={filterKey}
                selected={selected}
                onToggle={onToggleItem}
                onClear={onClearGroup}
                collapseKey={collapseKey}
              />
            ))}
          </div>
        ) : (
          <TagItems items={filteredItems} filterKey={filterKey} selected={selected} onToggle={onToggleItem} />
        )}
      </div>
    </div>
  )
}

function FiltersRail({
  filters,
  onChange,
  onHide,
  tags,
  dimensionLabels,
  statusCounts,
  statusKeys,
  isStaff,
  clientId,
  onDeletedDisconnected,
}: {
  filters: FilterState
  onChange: (f: FilterState) => void
  onHide: () => void
  tags: TagsByDimension
  dimensionLabels: { entity: string; format: string; angle: string }
  statusCounts: Record<string, number>
  statusKeys: Asset['status'][]
  isStaff: boolean
  clientId?: string
  onDeletedDisconnected: () => void
}) {
  const [filterQuery, setFilterQuery] = useState('')
  const [sectionsOpen, setSectionsOpen] = useState({ entity: true, format: true, angle: true })
  const [collapseKey, setCollapseKey] = useState(0)
  const [deletingDisconnected, setDeletingDisconnected] = useState(false)

  async function handleDeleteDisconnected() {
    if (!clientId || deletingDisconnected) return
    const count = statusCounts.disconnected ?? 0
    if (!count) return
    if (!window.confirm(`Permanently delete ${count} disconnected asset${count === 1 ? '' : 's'}? This cannot be undone.`)) return
    setDeletingDisconnected(true)
    try {
      const { deleted, blocked } = await deleteDisconnectedAssets(clientId)
      if (blocked.length) {
        window.alert(`Deleted ${deleted}. Skipped ${blocked.length} still referenced by other assets: ${blocked.join(', ')}`)
      }
      onDeletedDisconnected()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to delete disconnected assets')
    } finally {
      setDeletingDisconnected(false)
    }
  }

  function toggleSection(k: 'entity' | 'format' | 'angle') {
    setSectionsOpen(s => ({ ...s, [k]: !s[k] }))
  }

  function collapseAll() {
    setSectionsOpen({ entity: false, format: false, angle: false })
    setCollapseKey(k => k + 1)
  }

  function toggleTag(key: 'entities' | 'formats' | 'angles', val: string) {
    const cur = (filters[key] as string[] | undefined) ?? []
    onChange({ ...filters, [key]: cur.includes(val) ? cur.filter(x => x !== val) : [...cur, val] })
  }

  function clearSection(key: 'entities' | 'formats' | 'angles') {
    onChange({ ...filters, [key]: [] })
  }

  function clearGroup(key: 'entities' | 'formats' | 'angles', groupItems: string[]) {
    const cur = (filters[key] as string[] | undefined) ?? []
    onChange({ ...filters, [key]: cur.filter(x => !groupItems.includes(x)) })
  }

  return (
    <aside className="w-[236px] shrink-0 border-r border-border overflow-y-auto bg-surface p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">Filters</span>
        <div className="flex items-center gap-2">
          <button
            onClick={collapseAll}
            className="text-[17px] leading-none text-text-muted hover:text-cosmos-black transition-colors"
            title="Collapse all"
          >
            ⊟
          </button>
          <button onClick={onHide} className="text-[11px] font-sans text-text-muted hover:text-cosmos-black transition-colors">Hide</button>
        </div>
      </div>

      <input
        type="search"
        placeholder="Search filters…"
        value={filterQuery}
        onChange={e => setFilterQuery(e.target.value)}
        className="w-full text-xs font-sans border border-border rounded-sm px-2 py-1 mb-4 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors"
      />

      {/* Latest only */}
      <label className="flex items-center gap-2 mb-5 cursor-pointer select-none">
        <div
          onClick={() => onChange({ ...filters, latestOnly: !filters.latestOnly })}
          className={`w-9 h-5 rounded-pill relative shrink-0 transition-colors duration-base cursor-pointer ${
            filters.latestOnly ? 'bg-cosmos-black' : 'bg-gray-300'
          }`}
        >
          <span className={`absolute top-0.5 w-4 h-4 bg-clear-white rounded-pill transition-transform duration-base ${
            filters.latestOnly ? 'translate-x-4' : 'translate-x-0.5'
          }`} />
        </div>
        <span className="text-sm font-sans text-cosmos-black">Latest version only</span>
      </label>

      {/* Status */}
      <div className="mb-5">
        <div className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-2">— Status</div>
        {statusKeys.map(s => (
          <label key={s} className="flex items-center justify-between py-0.5 cursor-pointer select-none">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={filters.status.includes(s)}
                onChange={e => onChange({
                  ...filters,
                  status: e.target.checked
                    ? [...filters.status, s]
                    : filters.status.filter(x => x !== s),
                })}
                className="rounded-chip border-border accent-cosmos-black"
              />
              <span className="text-sm font-sans text-cosmos-black">{STATUS_LABELS[s]}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-sans text-text-muted">{statusCounts[s] ?? 0}</span>
              {isStaff && s === 'disconnected' && (statusCounts.disconnected ?? 0) > 0 && (
                <button
                  type="button"
                  onClick={e => { e.preventDefault(); e.stopPropagation(); handleDeleteDisconnected() }}
                  disabled={deletingDisconnected}
                  title="Delete all disconnected assets permanently"
                  className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {deletingDisconnected ? '…' : '🗑'}
                </button>
              )}
            </div>
          </label>
        ))}
      </div>

      {/* Client tag dimensions */}
      <TagSection
        label={dimensionLabels.entity} filterKey="entities"
        items={tags.entity} groups={tags.groups.entity}
        selected={filters.entities} filterQuery={filterQuery}
        open={sectionsOpen.entity} collapseKey={collapseKey}
        onToggle={() => toggleSection('entity')}
        onClearSection={() => clearSection('entities')}
        onClearGroup={items => clearGroup('entities', items)}
        onToggleItem={toggleTag}
      />
      <TagSection
        label={dimensionLabels.format} filterKey="formats"
        items={tags.format} groups={tags.groups.format}
        selected={filters.formats} filterQuery={filterQuery}
        open={sectionsOpen.format} collapseKey={collapseKey}
        onToggle={() => toggleSection('format')}
        onClearSection={() => clearSection('formats')}
        onClearGroup={items => clearGroup('formats', items)}
        onToggleItem={toggleTag}
      />
      <TagSection
        label={dimensionLabels.angle} filterKey="angles"
        items={tags.angle} groups={tags.groups.angle}
        selected={filters.angles} filterQuery={filterQuery}
        open={sectionsOpen.angle} collapseKey={collapseKey}
        onToggle={() => toggleSection('angle')}
        onClearSection={() => clearSection('angles')}
        onClearGroup={items => clearGroup('angles', items)}
        onToggleItem={toggleTag}
      />
    </aside>
  )
}

// ── Gallery view ──────────────────────────────────────────────

export default function GalleryView() {
  const { role, activeClient } = useRole()
  const [filters, setFilters] = useState<FilterState>(getDefaultFilters())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusSiblingId, setFocusSiblingId] = useState<string | null>(null)
  const [openLightboxOnFocus, setOpenLightboxOnFocus] = useState(false)
  const [resolvedDetail, setResolvedDetail] = useState<Asset | null>(null)
  const [railVisible, setRailVisible] = useState(true)

  const isStaff = role === 'admin' || role === 'editor'
  const statusKeys = isStaff ? STATUS_KEYS_STAFF : STATUS_KEYS_CLIENT

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
