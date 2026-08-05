/* Group / leaf / orphan — the shape of a client's taxonomy, derived from a flat tag list.
 *
 * There is no `kind` column. What a row IS is inferred from two fields, and the inference is the whole
 * contract between the portal and desktop:
 *
 *   GROUP  top-level, no shortcode   a portal-only category. Desktop shows it as a collapsible header
 *                                    and never writes one.
 *   LEAF   has a shortcode           filename vocabulary. Its shortcode goes into every asset name, so
 *                                    both apps read and write these.
 *
 * A leaf whose parent is missing (or is itself a leaf) is an ORPHAN. Those must stay VISIBLE: a leaf
 * that renders nowhere is a shortcode still baked into filenames that nobody can edit or delete.
 */

import type { Client } from '@sotto/asset-library'
import type { Tag } from '../../../services/tagService'

const DIM_LABELS: Record<Tag['dimension'], string> = {
  entity: 'Entity',
  angle: 'Angle',
  format: 'Format',
}

/** Clients rename the three dimensions; fall back to the generic label. */
export function dimLabel(client: Client | null, dim: Tag['dimension']): string {
  if (!client?.dimensionLabels) return DIM_LABELS[dim]
  return client.dimensionLabels[dim] ?? DIM_LABELS[dim]
}

export function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '')
}

/** Parent groups: top-level rows without a shortcode (portal-managed categories). */
export function isGroup(t: Tag): boolean {
  return !t.parentId && !(t.shortcode ?? '').trim()
}

/** Leaves: rows with a shortcode (filename vocabulary). */
export function isLeaf(t: Tag): boolean {
  return !!(t.shortcode ?? '').trim()
}

export interface DimensionTree {
  groups:          Tag[]
  ungroupedLeaves: Tag[]
  /** Leaves pointing at a parent that is absent or is not a group — shown so they stay editable. */
  orphanLeaves:    Tag[]
  leavesOf:        (groupId: string) => Tag[]
}

const byOrder = (a: Tag, b: Tag) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)

export function buildDimensionTree(tags: Tag[], dim: Tag['dimension']): DimensionTree {
  const inDim  = tags.filter(t => t.dimension === dim)
  const groups = inDim.filter(isGroup).sort(byOrder)
  const groupIds = new Set(groups.map(g => g.id))

  return {
    groups,
    ungroupedLeaves: inDim.filter(t => isLeaf(t) && !t.parentId).sort(byOrder),
    orphanLeaves:    inDim.filter(t => isLeaf(t) && t.parentId && !groupIds.has(t.parentId)).sort(byOrder),
    leavesOf: groupId => inDim.filter(t => isLeaf(t) && t.parentId === groupId).sort(byOrder),
  }
}

/**
 * The default key for a new tag. Keys are the Obsidian tag path, so a child's key extends its
 * parent's — that is what makes `entity.product.launch` nest under `entity.product` in a vault.
 */
export function defaultTagKey(dim: Tag['dimension'], name: string, parent: Tag | null): string {
  const slug = slugify(name)
  return parent?.key ? `${parent.key}.${slug}` : `${dim}.${slug}`
}

/** Filename-safe slug for the exported taxonomy file. */
export function clientFileSlug(client: Client): string {
  return client.slug?.trim() || slugify(client.name) || 'client'
}
