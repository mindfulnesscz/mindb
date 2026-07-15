import { useCallback, useEffect, useState } from 'react'
import type { Client } from '@dc-hub/asset-library'
import {
  createTag, deleteTag, fetchTags, updateTag,
  type Tag,
} from '../../services/tagService'

const DIM_LABELS: Record<Tag['dimension'], string> = {
  entity: 'Entity',
  angle: 'Angle',
  format: 'Format',
}

function dimLabel(client: Client | null, dim: Tag['dimension']): string {
  if (!client?.dimensionLabels) return DIM_LABELS[dim]
  return client.dimensionLabels[dim] ?? DIM_LABELS[dim]
}

export function TagsAdmin({ client }: { client: Client }) {
  const [tags, setTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<Record<string, { name: string; shortcode: string }>>({})

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const list = await fetchTags(client.id)
      setTags(list)
      const d: Record<string, { name: string; shortcode: string }> = {}
      for (const t of list) d[t.id] = { name: t.name, shortcode: t.shortcode ?? '' }
      setDraft(d)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [client.id])

  useEffect(() => { load() }, [load])

  async function saveTag(tag: Tag) {
    const d = draft[tag.id]
    if (!d) return
    try {
      await updateTag(tag.id, { name: d.name.trim(), shortcode: d.shortcode.trim() || null })
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function addLeaf(dim: Tag['dimension'], parentId: string | null) {
    const name = window.prompt('Tag name?')
    if (!name?.trim()) return
    const shortcode = window.prompt('Shortcode (3 chars)?')?.trim().slice(0, 8) ?? ''
    try {
      await createTag({
        name: name.trim(),
        shortcode: shortcode || null,
        dimension: dim,
        parentId,
        sortOrder: tags.filter(t => t.dimension === dim).length,
        clientId: client.id,
      })
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const dimensions: Tag['dimension'][] = ['entity', 'angle', 'format']

  if (loading) return <p className="text-sm text-text-muted">Loading tags…</p>
  if (error) return <p className="text-sm text-signal-error">{error}</p>

  return (
    <div className="space-y-6">
      {dimensions.map(dim => {
        const dimTags = tags.filter(t => t.dimension === dim && !t.parentId)
        const leaves = tags.filter(t => t.dimension === dim && t.parentId)
        return (
          <section key={dim}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-sans font-bold uppercase tracking-label text-text-muted">
                {dimLabel(client, dim)}
              </h3>
              <button
                type="button"
                onClick={() => addLeaf(dim, null)}
                className="text-[11px] font-sans text-text-muted hover:text-cosmos-black"
              >
                + Add
              </button>
            </div>
            <div className="border border-border rounded-sm overflow-hidden">
              <table className="w-full text-sm font-sans">
                <thead className="bg-surface-sunken text-[10px] uppercase tracking-label text-text-muted">
                  <tr>
                    <th className="text-left px-3 py-2">Name</th>
                    <th className="text-left px-3 py-2 w-24">Shortcode</th>
                    <th className="w-20" />
                  </tr>
                </thead>
                <tbody>
                  {[...dimTags, ...leaves].map(tag => (
                    <tr key={tag.id} className="border-t border-border">
                      <td className="px-3 py-2">
                        <input
                          value={draft[tag.id]?.name ?? tag.name}
                          onChange={e => setDraft(d => ({ ...d, [tag.id]: { ...d[tag.id], name: e.target.value } }))}
                          className="w-full border border-border rounded-sm px-2 py-1 bg-bg"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={draft[tag.id]?.shortcode ?? ''}
                          onChange={e => setDraft(d => ({ ...d, [tag.id]: { ...d[tag.id], shortcode: e.target.value } }))}
                          className="w-full border border-border rounded-sm px-2 py-1 font-mono bg-bg"
                          maxLength={8}
                        />
                      </td>
                      <td className="px-3 py-2 text-right space-x-2">
                        <button type="button" onClick={() => saveTag(tag)} className="text-[11px] hover:underline">Save</button>
                        <button type="button" onClick={() => deleteTag(tag.id).then(load)} className="text-[11px] text-signal-error hover:underline">Del</button>
                      </td>
                    </tr>
                  ))}
                  {!dimTags.length && !leaves.length && (
                    <tr><td colSpan={3} className="px-3 py-4 text-text-subtle">No tags yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )
      })}
    </div>
  )
}
