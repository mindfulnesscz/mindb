import { useCallback, useEffect, useRef, useState } from 'react'
import type { Client } from '@dc-hub/asset-library'
import {
  createTag, deleteTag, fetchTags, updateTag,
  type Tag,
} from '../../services/tagService'
import { importTaxonomyJsonFile } from '../../services/taxonomyImport'

const DIM_LABELS: Record<Tag['dimension'], string> = {
  entity: 'Entity',
  angle: 'Angle',
  format: 'Format',
}

function dimLabel(client: Client | null, dim: Tag['dimension']): string {
  if (!client?.dimensionLabels) return DIM_LABELS[dim]
  return client.dimensionLabels[dim] ?? DIM_LABELS[dim]
}

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '')
}

/** Parent groups: top-level rows without a shortcode (portal-managed categories). */
function isGroup(t: Tag): boolean {
  return !t.parentId && !(t.shortcode ?? '').trim()
}

/** Leaves: rows with a shortcode (filename vocabulary). */
function isLeaf(t: Tag): boolean {
  return !!(t.shortcode ?? '').trim()
}

export function TagsAdmin({
  client,
  onClientUpdated,
}: {
  client: Client
  onClientUpdated?: () => void
}) {
  const [tags, setTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [importMsg, setImportMsg] = useState('')
  const [importing, setImporting] = useState(false)
  const [draft, setDraft] = useState<Record<string, { name: string; shortcode: string; key: string }>>({})
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const list = await fetchTags(client.id)
      setTags(list)
      const d: Record<string, { name: string; shortcode: string; key: string }> = {}
      for (const t of list) {
        d[t.id] = { name: t.name, shortcode: t.shortcode ?? '', key: t.key ?? '' }
      }
      setDraft(d)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [client.id])

  useEffect(() => { load() }, [load])

  async function saveTag(tag: Tag) {
    const d = draft[tag.id]
    if (!d) return
    try {
      await updateTag(tag.id, {
        name: d.name.trim(),
        key: d.key.trim() || null,
        shortcode: isGroup(tag) ? null : (d.shortcode.trim() || null),
      })
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function addGroup(dim: Tag['dimension']) {
    const name = window.prompt('Parent group name?')
    if (!name?.trim()) return
    const keyDefault = `${dim}.${slugify(name)}`
    const key = window.prompt('Group key (stable id / Obsidian path prefix)?', keyDefault)?.trim() || keyDefault
    try {
      await createTag({
        name: name.trim(),
        key,
        shortcode: null,
        dimension: dim,
        parentId: null,
        sortOrder: tags.filter(t => t.dimension === dim && isGroup(t)).length,
        clientId: client.id,
      })
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function addLeaf(dim: Tag['dimension'], parentId: string | null) {
    const name = window.prompt('Leaf tag name?')
    if (!name?.trim()) return
    const shortcode = window.prompt('Shortcode (required for filename tags)?')?.trim().slice(0, 12) ?? ''
    if (!shortcode) {
      setError('Leaf tags need a shortcode. Parent groups are added with “+ Group”.')
      return
    }
    const slug = slugify(name)
    const parent = parentId ? tags.find(t => t.id === parentId) : null
    const keyDefault = parent?.key ? `${parent.key}.${slug}` : `${dim}.${slug}`
    const key = window.prompt('Tag key (used as Obsidian tag)?', keyDefault)?.trim() || keyDefault
    try {
      await createTag({
        name: name.trim(),
        key,
        shortcode,
        dimension: dim,
        parentId,
        sortOrder: tags.filter(t => t.dimension === dim && t.parentId === parentId).length,
        clientId: client.id,
      })
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handleImportFile(file: File | undefined) {
    if (!file) return
    setImportMsg(''); setError('')
    const hasTags = tags.length > 0
    const replace = hasTags
      ? window.confirm(`Replace all ${tags.length} existing tag(s) with this JSON?`)
      : false
    if (hasTags && !replace) {
      if (fileRef.current) fileRef.current.value = ''
      return
    }

    setImporting(true)
    try {
      const result = await importTaxonomyJsonFile(client.id, file, {
        replaceExisting: hasTags ? true : false,
      })
      setImportMsg(
        `Imported ${result.inserted} tag(s). Labels: ${result.dimensionLabels.entity} / ${result.dimensionLabels.angle} / ${result.dimensionLabels.format}`,
      )
      await load()
      onClientUpdated?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const dimensions: Tag['dimension'][] = ['entity', 'angle', 'format']

  if (loading) return <p className="text-sm text-text-muted">Loading tags…</p>

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 p-3 border border-border rounded-sm bg-surface-sunken">
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={e => void handleImportFile(e.target.files?.[0])}
        />
        <button
          type="button"
          disabled={importing}
          onClick={() => fileRef.current?.click()}
          className="px-3 py-1.5 text-[11px] font-sans font-semibold border border-cosmos-black rounded-sm hover:bg-cosmos-black hover:text-clear-white transition-colors disabled:opacity-40"
        >
          {importing ? 'Importing…' : 'Import from JSON'}
        </button>
        <a
          href="/taxonomy.sample.json"
          download="taxonomy.sample.json"
          className="text-[11px] font-sans text-text-muted hover:text-cosmos-black underline"
        >
          Download sample JSON
        </a>
        <span className="text-[11px] font-sans text-text-subtle">
          Parent groups are portal-only. Leaves (shortcodes) can also be added from desktop.
        </span>
      </div>
      {importMsg && <p className="text-[11px] font-sans text-cosmos-black">{importMsg}</p>}
      {error && <p className="text-sm font-sans text-signal-error">{error}</p>}

      {dimensions.map(dim => {
        const groups = tags.filter(t => t.dimension === dim && isGroup(t))
          .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
        const ungroupedLeaves = tags.filter(t => t.dimension === dim && isLeaf(t) && !t.parentId)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
        // Orphans: have parentId but parent missing / not a group
        const groupIds = new Set(groups.map(g => g.id))
        const orphanLeaves = tags.filter(
          t => t.dimension === dim && isLeaf(t) && t.parentId && !groupIds.has(t.parentId),
        )

        return (
          <section key={dim} className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-sans font-bold uppercase tracking-label text-text-muted">
                {dimLabel(client, dim)}
              </h3>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => addGroup(dim)}
                  className="text-[11px] font-sans text-text-muted hover:text-cosmos-black"
                >
                  + Group
                </button>
                <button
                  type="button"
                  onClick={() => addLeaf(dim, null)}
                  className="text-[11px] font-sans text-text-muted hover:text-cosmos-black"
                >
                  + Ungrouped leaf
                </button>
              </div>
            </div>

            {!groups.length && !ungroupedLeaves.length && !orphanLeaves.length && (
              <p className="text-[11px] font-sans text-text-subtle border border-border rounded-sm px-3 py-4">
                No tags yet — add a parent group, import JSON, or add an ungrouped leaf.
              </p>
            )}

            {groups.map(group => {
              const leaves = tags
                .filter(t => t.dimension === dim && isLeaf(t) && t.parentId === group.id)
                .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
              return (
                <div key={group.id} className="border border-border rounded-sm overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2 bg-surface-sunken border-b border-border">
                    <span className="text-[10px] font-sans uppercase tracking-label text-text-muted shrink-0">Group</span>
                    <input
                      value={draft[group.id]?.name ?? group.name}
                      onChange={e => setDraft(d => ({
                        ...d,
                        [group.id]: { ...d[group.id], name: e.target.value },
                      }))}
                      className="flex-1 min-w-0 border border-border rounded-sm px-2 py-1 text-sm font-sans font-semibold bg-bg"
                    />
                    <input
                      value={draft[group.id]?.key ?? group.key ?? ''}
                      onChange={e => setDraft(d => ({
                        ...d,
                        [group.id]: { ...d[group.id], key: e.target.value },
                      }))}
                      className="w-48 border border-border rounded-sm px-2 py-1 text-[11px] font-mono bg-bg"
                      placeholder="key"
                      title="Stable key"
                    />
                    <button type="button" onClick={() => saveTag(group)} className="text-[11px] hover:underline shrink-0">Save</button>
                    <button
                      type="button"
                      onClick={() => {
                        if (leaves.length && !window.confirm(`Delete group “${group.name}” and its ${leaves.length} leaf tag(s)?`)) return
                        void deleteTag(group.id).then(load)
                      }}
                      className="text-[11px] text-signal-error hover:underline shrink-0"
                    >
                      Del
                    </button>
                    <button
                      type="button"
                      onClick={() => addLeaf(dim, group.id)}
                      className="text-[11px] font-sans text-cosmos-black hover:underline shrink-0"
                    >
                      + Leaf
                    </button>
                  </div>
                  <table className="w-full text-sm font-sans">
                    <thead className="text-[10px] uppercase tracking-label text-text-muted">
                      <tr>
                        <th className="text-left px-3 py-1.5 font-normal">Leaf</th>
                        <th className="text-left px-3 py-1.5 font-normal w-28">Shortcode</th>
                        <th className="text-left px-3 py-1.5 font-normal">Key</th>
                        <th className="w-24" />
                      </tr>
                    </thead>
                    <tbody>
                      {leaves.map(tag => (
                        <LeafRow
                          key={tag.id}
                          tag={tag}
                          draft={draft[tag.id]}
                          onDraft={(patch) => setDraft(d => ({
                            ...d,
                            [tag.id]: { ...d[tag.id], ...patch },
                          }))}
                          onSave={() => saveTag(tag)}
                          onDelete={() => void deleteTag(tag.id).then(load)}
                        />
                      ))}
                      {!leaves.length && (
                        <tr>
                          <td colSpan={4} className="px-3 py-3 text-[11px] text-text-subtle">
                            No leaves in this group yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )
            })}

            {(ungroupedLeaves.length > 0 || orphanLeaves.length > 0) && (
              <div className="border border-border rounded-sm overflow-hidden">
                <div className="px-3 py-2 bg-surface-sunken border-b border-border text-[10px] font-sans uppercase tracking-label text-text-muted">
                  Ungrouped leaves
                </div>
                <table className="w-full text-sm font-sans">
                  <thead className="text-[10px] uppercase tracking-label text-text-muted">
                    <tr>
                      <th className="text-left px-3 py-1.5 font-normal">Leaf</th>
                      <th className="text-left px-3 py-1.5 font-normal w-28">Shortcode</th>
                      <th className="text-left px-3 py-1.5 font-normal">Key</th>
                      <th className="w-24" />
                    </tr>
                  </thead>
                  <tbody>
                    {[...ungroupedLeaves, ...orphanLeaves].map(tag => (
                      <LeafRow
                        key={tag.id}
                        tag={tag}
                        draft={draft[tag.id]}
                        onDraft={(patch) => setDraft(d => ({
                          ...d,
                          [tag.id]: { ...d[tag.id], ...patch },
                        }))}
                        onSave={() => saveTag(tag)}
                        onDelete={() => void deleteTag(tag.id).then(load)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

function LeafRow({
  tag,
  draft,
  onDraft,
  onSave,
  onDelete,
}: {
  tag: Tag
  draft?: { name: string; shortcode: string; key: string }
  onDraft: (patch: Partial<{ name: string; shortcode: string; key: string }>) => void
  onSave: () => void
  onDelete: () => void
}) {
  return (
    <tr className="border-t border-border">
      <td className="px-3 py-2">
        <input
          value={draft?.name ?? tag.name}
          onChange={e => onDraft({ name: e.target.value })}
          className="w-full border border-border rounded-sm px-2 py-1 bg-bg"
        />
      </td>
      <td className="px-3 py-2">
        <input
          value={draft?.shortcode ?? tag.shortcode ?? ''}
          onChange={e => onDraft({ shortcode: e.target.value })}
          className="w-full border border-border rounded-sm px-2 py-1 font-mono bg-bg"
          maxLength={12}
        />
      </td>
      <td className="px-3 py-2">
        <input
          value={draft?.key ?? tag.key ?? ''}
          onChange={e => onDraft({ key: e.target.value })}
          className="w-full border border-border rounded-sm px-2 py-1 font-mono text-[11px] bg-bg"
        />
      </td>
      <td className="px-3 py-2 text-right space-x-2 whitespace-nowrap">
        <button type="button" onClick={onSave} className="text-[11px] hover:underline">Save</button>
        <button type="button" onClick={onDelete} className="text-[11px] text-signal-error hover:underline">Del</button>
      </td>
    </tr>
  )
}
