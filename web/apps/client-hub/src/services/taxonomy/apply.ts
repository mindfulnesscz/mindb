/* Applying a validated taxonomy document to a client.
 *
 * The only part of the taxonomy flow that touches the database: it writes dimension_labels and
 * replaces the tag rows. Validation happens first and separately (./validate) so a bad file is
 * rejected before anything is written.
 */

import { supabase } from '../../lib/supabase'
import { createTag, deleteTag, fetchTags } from '../tagService'
import { updateClient } from '../clientService'
import { parseAndValidateTaxonomyJson, type TaxonomyDocument } from './validate'

export interface ImportTaxonomyOptions {
  /** Delete existing client tags before insert (default false). */
  replaceExisting?: boolean
}

export interface ImportTaxonomyResult {
  inserted: number
  dimensionLabels: TaxonomyDocument['dimension_labels']
}

/**
 * Apply a validated taxonomy document to a client:
 * updates dimension_labels, optionally clears tags, inserts the tree.
 */
export async function importTaxonomyToClient(
  clientId: string,
  document: TaxonomyDocument,
  options: ImportTaxonomyOptions = {},
): Promise<ImportTaxonomyResult> {
  if (!supabase) throw new Error('Supabase not configured')

  const replaceExisting = options.replaceExisting ?? false
  const existing = await fetchTags(clientId)

  if (existing.length > 0 && !replaceExisting) {
    throw new Error(
      `Client already has ${existing.length} tag(s). Pass replaceExisting: true to replace them.`,
    )
  }

  if (replaceExisting && existing.length > 0) {
    // Delete roots first? FK is ON DELETE CASCADE from parent — delete all by id.
    // Safer: delete leaves then parents, or delete all without parent first from leaves.
    // Cascade on parent_id means deleting a parent deletes children — delete roots only.
    const roots = existing.filter(t => !t.parentId)
    const orphans = existing.filter(t => t.parentId && !existing.some(p => p.id === t.parentId))
    for (const t of [...orphans, ...roots]) {
      await deleteTag(t.id)
    }
    // Any remaining (shouldn't) — force delete
    const left = await fetchTags(clientId)
    for (const t of left) await deleteTag(t.id)
  }

  await updateClient(clientId, {
    dimensionLabels: {
      entity: document.dimension_labels.entity,
      angle: document.dimension_labels.angle,
      format: document.dimension_labels.format,
    },
  })

  const idByKey = new Map<string, string>()
  const pending = [...document.nodes].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name),
  )

  let inserted = 0
  let guard = 0
  while (pending.length && guard < document.nodes.length + 2) {
    guard += 1
    let progress = false
    for (let i = pending.length - 1; i >= 0; i--) {
      const node = pending[i]
      const parentKey = node.parent_key ?? null
      if (parentKey && !idByKey.has(parentKey)) continue

      const created = await createTag({
        name: node.name,
        key: node.key,
        shortcode: node.shortcode ?? null,
        dimension: node.dimension,
        parentId: parentKey ? idByKey.get(parentKey)! : null,
        sortOrder: node.sort_order ?? 0,
        clientId,
      })
      idByKey.set(node.key, created.id)
      pending.splice(i, 1)
      inserted += 1
      progress = true
    }
    if (!progress) break
  }

  if (pending.length) {
    throw new Error(
      `Could not insert ${pending.length} node(s) — unresolved parents: ${pending.map(n => n.key).join(', ')}`,
    )
  }

  return { inserted, dimensionLabels: document.dimension_labels }
}

/** File → validate → import helper for UI. */
export async function importTaxonomyJsonFile(
  clientId: string,
  file: File,
  options?: ImportTaxonomyOptions,
): Promise<ImportTaxonomyResult> {
  const text = await file.text()
  const result = parseAndValidateTaxonomyJson(text)
  if (!result.ok || !result.document) {
    throw new Error(result.errors.join('; ') || 'Invalid taxonomy JSON')
  }
  return importTaxonomyToClient(clientId, result.document, options)
}

/** Minimal tag shape needed to rebuild a taxonomy document (matches tagService.Tag). */
