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
  const [draft, setDraft] = useState<Record<string, { name: string; shortcode: string }>>({})
  const fileRef = useRef<HTMLInputElement>(null)

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
    const slug = name.trim().toLowerCase().replace(/\s+/g, '-')
    const parent = parentId ? tags.find(t => t.id === parentId) : null
    const key = parent?.key ? `${parent.key}.${slug}` : `${dim}.${slug}`
    try {
      await createTag({
        name: name.trim(),
        key,
        shortcode: shortcode || null,
        dimension: dim,
        parentId,
        sortOrder: tags.filter(t => t.dimension === dim).length,
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
          Loads dimension labels + tag tree from a local file.
        </span>
      </div>
      {importMsg && <p className="text-[11px] font-sans text-cosmos-black">{importMsg}</p>}
      {error && <p className="text-sm font-sans text-signal-error">{error}</p>}

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
                    <tr><td colSpan={3} className="px-3 py-4 text-text-subtle">No tags yet — import JSON or add manually.</td></tr>
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
