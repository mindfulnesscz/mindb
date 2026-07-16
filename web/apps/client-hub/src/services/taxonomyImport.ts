/**
 * Taxonomy JSON import — parse, validate, write dimension_labels + tags for a client.
 * Templates stay as local JSON files; nothing is seeded into taxonomy_templates.
 */
import { supabase } from '../lib/supabase'
import { createTag, deleteTag, fetchTags } from './tagService'
import { updateClient } from './clientService'

export const TAXONOMY_JSON_VERSION = 1

export type TaxonomyDimension = 'entity' | 'angle' | 'format'

export interface TaxonomyNodeInput {
  key: string
  dimension: TaxonomyDimension
  name: string
  parent_key?: string | null
  shortcode?: string | null
  sort_order?: number
}

export interface TaxonomyDocument {
  version: number
  name?: string
  description?: string
  dimension_labels: {
    entity: string
    angle: string
    format: string
  }
  nodes: TaxonomyNodeInput[]
}

export interface TaxonomyValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  document?: TaxonomyDocument
}

const DIMENSIONS: TaxonomyDimension[] = ['entity', 'angle', 'format']

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}

/** Parse raw JSON text into an unknown value (does not validate schema). */
export function parseTaxonomyJsonText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON' }
  }
}

/** Validate unknown JSON against the taxonomy document schema. */
export function validateTaxonomyDocument(raw: unknown): TaxonomyValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['Root must be a JSON object'], warnings }
  }

  if (raw.version !== TAXONOMY_JSON_VERSION) {
    errors.push(`version must be ${TAXONOMY_JSON_VERSION}`)
  }

  if (!isPlainObject(raw.dimension_labels)) {
    errors.push('dimension_labels is required (object with entity, angle, format)')
  }

  const labelsRaw = isPlainObject(raw.dimension_labels) ? raw.dimension_labels : {}
  const dimension_labels = {
    entity: asNonEmptyString(labelsRaw.entity) ?? '',
    angle: asNonEmptyString(labelsRaw.angle) ?? '',
    format: asNonEmptyString(labelsRaw.format) ?? '',
  }
  for (const dim of DIMENSIONS) {
    if (!dimension_labels[dim]) errors.push(`dimension_labels.${dim} is required`)
  }

  if (!Array.isArray(raw.nodes)) {
    errors.push('nodes must be an array')
    return { ok: false, errors, warnings }
  }

  const nodes: TaxonomyNodeInput[] = []
  const keys = new Set<string>()

  raw.nodes.forEach((item, index) => {
    const path = `nodes[${index}]`
    if (!isPlainObject(item)) {
      errors.push(`${path} must be an object`)
      return
    }

    const key = asNonEmptyString(item.key)
    const name = asNonEmptyString(item.name)
    const dimension = asNonEmptyString(item.dimension) as TaxonomyDimension | null

    if (!key) errors.push(`${path}.key is required`)
    if (!name) errors.push(`${path}.name is required`)
    if (!dimension || !DIMENSIONS.includes(dimension)) {
      errors.push(`${path}.dimension must be one of entity|angle|format`)
    }

    if (key) {
      if (keys.has(key)) errors.push(`${path}.key "${key}" is duplicated`)
      else keys.add(key)
    }

    let parent_key: string | null = null
    if (item.parent_key !== undefined && item.parent_key !== null && item.parent_key !== '') {
      parent_key = asNonEmptyString(item.parent_key)
      if (!parent_key) errors.push(`${path}.parent_key must be a non-empty string or null`)
    }

    const shortcode =
      item.shortcode === undefined || item.shortcode === null || item.shortcode === ''
        ? null
        : asNonEmptyString(item.shortcode)

    if (item.shortcode !== undefined && item.shortcode !== null && item.shortcode !== '' && !shortcode) {
      errors.push(`${path}.shortcode must be a non-empty string when set`)
    }
    if (shortcode && shortcode.length > 12) {
      errors.push(`${path}.shortcode max length is 12`)
    }

    let sort_order = 0
    if (item.sort_order !== undefined) {
      if (typeof item.sort_order !== 'number' || !Number.isFinite(item.sort_order)) {
        errors.push(`${path}.sort_order must be a number`)
      } else {
        sort_order = Math.trunc(item.sort_order)
      }
    }

    if (item.meta !== undefined) {
      warnings.push(`${path}.meta is ignored — use parent_key for grouping and key as the Obsidian tag`)
    }

    if (key && name && dimension && DIMENSIONS.includes(dimension)) {
      nodes.push({
        key,
        name,
        dimension,
        parent_key,
        shortcode,
        sort_order,
      })
    }
  })

  for (const node of nodes) {
    if (node.parent_key && !keys.has(node.parent_key)) {
      errors.push(`node "${node.key}" parent_key "${node.parent_key}" not found`)
    }
    if (node.parent_key === node.key) {
      errors.push(`node "${node.key}" cannot parent itself`)
    }
  }

  // Cycle check
  const parentOf = new Map(nodes.map(n => [n.key, n.parent_key ?? null]))
  for (const node of nodes) {
    const seen = new Set<string>()
    let cur: string | null = node.key
    while (cur) {
      if (seen.has(cur)) {
        errors.push(`cycle detected involving "${node.key}"`)
        break
      }
      seen.add(cur)
      cur = parentOf.get(cur) ?? null
    }
  }

  if (nodes.length === 0) warnings.push('nodes array is empty — only dimension labels will be applied')

  if (errors.length) return { ok: false, errors, warnings }

  const document: TaxonomyDocument = {
    version: TAXONOMY_JSON_VERSION,
    name: asNonEmptyString(raw.name) ?? undefined,
    description: asNonEmptyString(raw.description) ?? undefined,
    dimension_labels,
    nodes,
  }

  return { ok: true, errors: [], warnings, document }
}

export function parseAndValidateTaxonomyJson(text: string): TaxonomyValidationResult {
  const parsed = parseTaxonomyJsonText(text)
  if (!parsed.ok) return { ok: false, errors: [parsed.error], warnings: [] }
  return validateTaxonomyDocument(parsed.value)
}

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
