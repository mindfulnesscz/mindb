/* The filters rail — status, plus the three-dimension tag tree.
 *
 * Staff and clients see DIFFERENT status keys: a client must not be offered `archived` or
 * `disconnected`, which are internal lifecycle states. Hence two STATUS_KEYS lists rather than one
 * filtered at render time.
 */

import { useState, useEffect } from 'react'
import { type FilterState, type Asset } from '@dc-hub/asset-library'
import { type TagsByDimension, type TagGroup } from '../../hooks/useTags'
import { deleteDisconnectedAssets } from '../../services/assetService'
import { STATUS_LABELS } from './statusLabels'


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

export function FiltersRail({
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

      {/* Latest only.
          A real `role="switch"` button, not a <div onClick> inside a <label>. That is what this was,
          and the words "Latest version only" were dead to the click — a <label> only forwards a click
          when it labels a form control, and it labelled a div. It was also unreachable by keyboard and
          nameless to a screen reader. */}
      <button
        type="button"
        role="switch"
        aria-checked={filters.latestOnly}
        onClick={() => onChange({ ...filters, latestOnly: !filters.latestOnly })}
        className="flex items-center gap-2 mb-5 cursor-pointer select-none w-full text-left"
      >
        <span
          aria-hidden
          className={`w-9 h-5 rounded-pill relative shrink-0 block transition-colors duration-base ${
            filters.latestOnly ? 'bg-cosmos-black' : 'bg-gray-300'
          }`}
        >
          <span className={`absolute top-0.5 w-4 h-4 bg-clear-white rounded-pill transition-transform duration-base ${
            filters.latestOnly ? 'translate-x-4' : 'translate-x-0.5'
          }`} />
        </span>
        <span className="text-sm font-sans text-cosmos-black">Latest version only</span>
      </button>

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

