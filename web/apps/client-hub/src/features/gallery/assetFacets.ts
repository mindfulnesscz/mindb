/* Asset facet logic — what a group of assets has in common, and what distinguishes each one.
 *
 * Extracted from AssetDetail so it can be tested without a DOM. `sharedLabels` and `uniqueLabel`
 * are what make a variant picker readable: the shared tags name the GROUP, and each variant is
 * labelled by whatever is left of its own name. Get it wrong and every chip in the picker reads
 * identically.
 */

import type { Asset } from '@dc-hub/asset-library'

/** Every taxonomy label on an asset, from whichever field carries it. */
export function labelSet(a: Asset): Set<string> {
  return new Set([
    ...(a.entities?.length ? a.entities : [a.entity].filter(Boolean)),
    ...(a.angles?.length ? a.angles : [a.angle].filter(Boolean)),
    ...a.formats,
    ...(a.tagsAll ?? []),
  ])
}

/** Labels present on EVERY row — the group's identity. */
export function sharedLabels(rows: Asset[]): string[] {
  if (rows.length === 0) return []
  const sets = rows.map(labelSet)
  return [...sets[0]].filter(label => sets.every(s => s.has(label)))
}

/**
 * What is left of a row's name once the group's shared labels are removed — the chip text in a
 * variant picker. Falls back to the full name when nothing distinctive remains, so a chip is
 * never blank.
 */
export function uniqueLabel(row: Asset, shared: string[]): string {
  let rest = row.name
  for (const label of shared) rest = rest.split(label).join(' ')
  rest = rest.replace(/\s+/g, ' ').replace(/^[\s—-]+|[\s—-]+$/g, '').trim()
  return rest || row.name
}

export interface ActiveFacets {
  entities?: string[]
  formats?: string[]
  angles?: string[]
}

/** True when the asset matches ANY active facet — used to highlight why it is in the results. */
export function matchesActiveFacets(a: Asset, facets?: ActiveFacets): boolean {
  if (!facets) return false
  const entityPool = a.entities?.length ? a.entities : [a.entity]
  const anglePool  = a.angles?.length ? a.angles : [a.angle]
  return (
    (facets.entities?.some(e => entityPool.includes(e)) ?? false) ||
    (facets.formats?.some(f => a.formats.includes(f)) ?? false) ||
    (facets.angles?.some(g => anglePool.includes(g)) ?? false)
  )
}
