/* Building a taxonomy document from a client's live tags, and handing it to the browser.
 *
 * The export side of the import format above — the same shape, produced from the database rather
 * than consumed into it, so a client's taxonomy can be copied to another client or version-controlled.
 */

import { TAXONOMY_JSON_VERSION, type TaxonomyDocument, type TaxonomyDimension, type TaxonomyNodeInput } from './validate'

export interface TaxonomyExportTag {
  id: string
  name: string
  key: string | null
  shortcode: string | null
  dimension: TaxonomyDimension
  parentId: string | null
  sortOrder: number
}

function slugifyKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '')
}

/**
 * Build an import-compatible taxonomy document from the client's current tags
 * and dimension labels. Round-trips with importTaxonomyToClient.
 */
export function buildTaxonomyDocument(
  client: {
    name: string
    dimensionLabels?: { entity: string; angle: string; format: string }
  },
  tags: TaxonomyExportTag[],
): TaxonomyDocument {
  const idToKey = new Map<string, string>()
  const usedKeys = new Set<string>()

  function assignKey(t: TaxonomyExportTag): string {
    const existing = idToKey.get(t.id)
    if (existing) return existing
    const base =
      (t.key ?? '').trim() ||
      `${t.dimension}.${slugifyKey(t.name) || t.id.slice(0, 8)}`
    let key = base
    let n = 2
    while (usedKeys.has(key)) key = `${base}.${n++}`
    usedKeys.add(key)
    idToKey.set(t.id, key)
    return key
  }

  const sorted = [...tags].sort(
    (a, b) =>
      a.dimension.localeCompare(b.dimension) ||
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name),
  )
  for (const t of sorted) assignKey(t)

  const nodes: TaxonomyNodeInput[] = sorted.map(t => {
    const parent_key =
      t.parentId && idToKey.has(t.parentId) ? idToKey.get(t.parentId)! : null
    const shortcode = (t.shortcode ?? '').trim() || null
    return {
      key: idToKey.get(t.id)!,
      dimension: t.dimension,
      name: t.name,
      parent_key,
      ...(shortcode ? { shortcode } : {}),
      sort_order: t.sortOrder,
    }
  })

  /* A document that cannot be re-imported is not an export.
   *
   * `parent_key` mirrors whatever `parent_id` the rows carry, so a self-referencing or cyclic row
   * produced a file the portal's own validator rejects — "cannot parent itself", then "cycle
   * detected" for everything beneath it. The user sees that on IMPORT, one step removed from the
   * corruption and with no hint which side is at fault.
   *
   * A self-parent carries no information, so dropping it loses nothing; a cycle has no valid root,
   * so it is broken at the edge that closes it. Both are reported rather than quietly repaired —
   * the rows still need fixing, and this only stops the file from being unusable meanwhile. */
  const parentOf = new Map(nodes.map(n => [n.key, n.parent_key ?? null]))
  const repaired: string[] = []
  const detach = (node: TaxonomyNodeInput) => {
    node.parent_key = null
    parentOf.set(node.key, null)
    repaired.push(node.key)
  }

  for (const node of nodes) {
    if (node.parent_key && node.parent_key === node.key) detach(node)
  }
  for (const node of nodes) {
    const seen = new Set<string>([node.key])
    let cursor = parentOf.get(node.key) ?? null
    while (cursor) {
      if (seen.has(cursor)) { detach(node); break }
      seen.add(cursor)
      cursor = parentOf.get(cursor) ?? null
    }
  }
  if (repaired.length) {
    console.warn(
      `Taxonomy export: ${repaired.length} node(s) had a self-referencing or cyclic parent and were `
      + `exported without one — the underlying tag rows still need fixing: ${repaired.join(', ')}`,
    )
  }

  const labels = client.dimensionLabels
  return {
    version: TAXONOMY_JSON_VERSION,
    name: client.name,
    dimension_labels: {
      entity: labels?.entity?.trim() || 'Entity',
      angle: labels?.angle?.trim() || 'Angle',
      format: labels?.format?.trim() || 'Format',
    },
    nodes,
  }
}

/** Trigger a browser download of the taxonomy JSON. */
export function downloadTaxonomyJson(document: TaxonomyDocument, filename: string): void {
  const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = window.document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
