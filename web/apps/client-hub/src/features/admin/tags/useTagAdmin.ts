/* Tag editing: load, per-row drafts, create, save, import, export.
 *
 * Rows are edited as DRAFTS and saved one at a time, rather than written on every keystroke. A tag's
 * shortcode is embedded in asset filenames, so a half-typed value must never reach the database.
 *
 * A save is followed by a reload rather than a local patch: the server normalises keys and shortcodes,
 * and showing the stored value is the only way the operator sees what was actually kept.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Client } from '@sotto/asset-library'
import { createTag, deleteTag, fetchTags, updateTag, type Tag } from '../../../services/tagService'
import { importTaxonomyJsonFile, buildTaxonomyDocument, downloadTaxonomyJson } from '../../../services/taxonomyImport'
import { isGroup, defaultTagKey, clientFileSlug } from './tagTree'

export interface TagDraft { name: string; shortcode: string; key: string }

export function useTagAdmin(client: Client, onClientUpdated?: () => void) {
  const [tags, setTags]           = useState<Tag[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')
  const [importMsg, setImportMsg] = useState('')
  const [importing, setImporting] = useState(false)
  const [draft, setDraft]         = useState<Record<string, TagDraft>>({})
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const list = await fetchTags(client.id)
      setTags(list)
      const d: Record<string, TagDraft> = {}
      for (const t of list) {
        d[t.id] = { name: t.name, shortcode: t.shortcode ?? '', key: t.key ?? '' }
      }
      setDraft(d)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [client.id])

  useEffect(() => { void load() }, [load])

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e))

  function patchDraft(id: string, patch: Partial<TagDraft>) {
    setDraft(d => ({ ...d, [id]: { ...d[id], ...patch } }))
  }

  async function saveTag(tag: Tag) {
    const d = draft[tag.id]
    if (!d) return
    try {
      await updateTag(tag.id, {
        name: d.name.trim(),
        key: d.key.trim() || null,
        // A group must stay shortcode-less, or it would start appearing in filenames.
        shortcode: isGroup(tag) ? null : (d.shortcode.trim() || null),
      })
      await load()
    } catch (e) { fail(e) }
  }

  async function removeTag(id: string) {
    try { await deleteTag(id); await load() } catch (e) { fail(e) }
  }

  async function addGroup(dim: Tag['dimension']) {
    const name = window.prompt('Parent group name?')
    if (!name?.trim()) return
    const keyDefault = defaultTagKey(dim, name, null)
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
    } catch (e) { fail(e) }
  }

  async function addLeaf(dim: Tag['dimension'], parentId: string | null) {
    const name = window.prompt('Leaf tag name?')
    if (!name?.trim()) return
    const shortcode = window.prompt('Shortcode (required for filename tags)?')?.trim().slice(0, 12) ?? ''
    if (!shortcode) {
      // Without one the row would read as a group, and desktop would treat it as a category.
      setError('Leaf tags need a shortcode. Parent groups are added with “+ Group”.')
      return
    }
    const parent = parentId ? tags.find(t => t.id === parentId) ?? null : null
    const keyDefault = defaultTagKey(dim, name, parent)
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
    } catch (e) { fail(e) }
  }

  async function importFile(file: File | undefined) {
    if (!file) return
    setImportMsg(''); setError('')
    // An import REPLACES the whole taxonomy, so it needs explicit confirmation whenever there is
    // anything to lose.
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
      const result = await importTaxonomyJsonFile(client.id, file, { replaceExisting: hasTags })
      setImportMsg(
        `Imported ${result.inserted} tag(s). Labels: ${result.dimensionLabels.entity} / ${result.dimensionLabels.angle} / ${result.dimensionLabels.format}`,
      )
      await load()
      onClientUpdated?.()
    } catch (e) {
      fail(e)
    } finally {
      setImporting(false)
      // Clear the input, or picking the same file again fires no change event.
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function exportJson() {
    setError('')
    try {
      const doc  = buildTaxonomyDocument(client, tags)
      const slug = clientFileSlug(client)
      downloadTaxonomyJson(doc, `taxonomy.${slug}.json`)
      setImportMsg(`Exported ${doc.nodes.length} tag(s) to taxonomy.${slug}.json`)
    } catch (e) {
      fail(e)
    }
  }

  return {
    tags, loading, error, importMsg, importing, draft, fileRef,
    patchDraft, saveTag, removeTag, addGroup, addLeaf, importFile, exportJson,
  }
}

export type TagAdmin = ReturnType<typeof useTagAdmin>
