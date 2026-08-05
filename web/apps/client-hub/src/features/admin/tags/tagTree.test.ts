/* Group, leaf, orphan — derived from a flat list with no `kind` column.
 *
 * This inference is the contract between the portal and desktop. A row read as a group when it is
 * really a leaf drops a shortcode out of the filename vocabulary; read the other way, a category
 * starts appearing inside asset names.
 *
 * Orphans get their own tests because the tempting simplification — render leaves under their parent,
 * done — makes a leaf with a dangling parentId vanish from the screen while its shortcode stays baked
 * into filenames, uneditable and undeletable.
 */

import { describe, it, expect } from 'vitest'
import type { Client } from '@sotto/asset-library'
import type { Tag } from '../../../services/tagService'
import { isGroup, isLeaf, buildDimensionTree, dimLabel, slugify, defaultTagKey, clientFileSlug } from './tagTree'

const tag = (over: Partial<Tag> = {}): Tag => ({
  id: 'id', clientId: 'c', name: 'Name', key: null, shortcode: null,
  dimension: 'entity', parentId: null, sortOrder: 0, ...over,
} as Tag)

describe('isGroup / isLeaf', () => {
  it('reads a top-level row with no shortcode as a group', () => {
    expect(isGroup(tag({ shortcode: null }))).toBe(true)
    expect(isLeaf(tag({ shortcode: null }))).toBe(false)
  })

  it('reads any row WITH a shortcode as a leaf, grouped or not', () => {
    expect(isLeaf(tag({ shortcode: 'PRD' }))).toBe(true)
    expect(isLeaf(tag({ shortcode: 'PRD', parentId: 'g1' }))).toBe(true)
    expect(isGroup(tag({ shortcode: 'PRD' }))).toBe(false)
  })

  it('treats a whitespace-only shortcode as absent', () => {
    // Otherwise a row saved with a stray space becomes a leaf carrying a blank code into filenames.
    expect(isLeaf(tag({ shortcode: '   ' }))).toBe(false)
    expect(isGroup(tag({ shortcode: '   ' }))).toBe(true)
  })

  it('does not call a NESTED row without a shortcode a group', () => {
    // Groups do not nest. Such a row is neither, and is deliberately not rendered as a category.
    const nested = tag({ parentId: 'g1', shortcode: null })
    expect(isGroup(nested)).toBe(false)
    expect(isLeaf(nested)).toBe(false)
  })
})

describe('buildDimensionTree', () => {
  const group = (id: string, over: Partial<Tag> = {}) => tag({ id, name: id, ...over })
  const leaf  = (id: string, over: Partial<Tag> = {}) => tag({ id, name: id, shortcode: id.toUpperCase(), ...over })

  it('keeps only the requested dimension', () => {
    const tree = buildDimensionTree([
      group('g1'), leaf('l1', { parentId: 'g1' }),
      group('g2', { dimension: 'angle' }), leaf('l2', { dimension: 'angle' }),
    ], 'entity')

    expect(tree.groups.map(g => g.id)).toEqual(['g1'])
    expect(tree.leavesOf('g1').map(l => l.id)).toEqual(['l1'])
    expect(tree.ungroupedLeaves).toEqual([])
  })

  it('separates grouped leaves from ungrouped ones', () => {
    const tree = buildDimensionTree([group('g1'), leaf('a', { parentId: 'g1' }), leaf('b')], 'entity')

    expect(tree.leavesOf('g1').map(l => l.id)).toEqual(['a'])
    expect(tree.ungroupedLeaves.map(l => l.id)).toEqual(['b'])
  })

  it('surfaces a leaf whose parent does not exist as an ORPHAN', () => {
    // Its shortcode is in filenames; hiding it makes the tag uneditable and undeletable.
    const tree = buildDimensionTree([leaf('lost', { parentId: 'deleted-group' })], 'entity')

    expect(tree.orphanLeaves.map(l => l.id)).toEqual(['lost'])
    expect(tree.ungroupedLeaves).toEqual([])
  })

  it('treats a leaf parented to another LEAF as an orphan too', () => {
    // Leaves cannot nest, so this row would otherwise render nowhere.
    const tree = buildDimensionTree([leaf('parent'), leaf('child', { parentId: 'parent' })], 'entity')
    expect(tree.orphanLeaves.map(l => l.id)).toEqual(['child'])
  })

  it('does not double-count: every leaf lands in exactly one bucket', () => {
    const tags = [
      group('g1'),
      leaf('grouped', { parentId: 'g1' }),
      leaf('loose'),
      leaf('orphan', { parentId: 'gone' }),
    ]
    const tree = buildDimensionTree(tags, 'entity')
    const shown = [
      ...tree.groups.flatMap(g => tree.leavesOf(g.id)),
      ...tree.ungroupedLeaves,
      ...tree.orphanLeaves,
    ].map(t => t.id)

    expect(shown.sort()).toEqual(['grouped', 'loose', 'orphan'])
    expect(new Set(shown).size).toBe(shown.length)
  })

  it('sorts by sortOrder, then by name for ties', () => {
    const tree = buildDimensionTree([
      group('b', { sortOrder: 1 }), group('a', { sortOrder: 1 }), group('first', { sortOrder: 0 }),
    ], 'entity')
    expect(tree.groups.map(g => g.name)).toEqual(['first', 'a', 'b'])
  })

  it('lists an empty group — that is where a new leaf gets filed', () => {
    const tree = buildDimensionTree([group('empty')], 'entity')
    expect(tree.groups).toHaveLength(1)
    expect(tree.leavesOf('empty')).toEqual([])
  })
})

describe('defaultTagKey', () => {
  it('extends the parent key, so Obsidian nests the tag', () => {
    const parent = tag({ key: 'entity.product' })
    expect(defaultTagKey('entity', 'Launch Deck', parent)).toBe('entity.product.launch-deck')
  })

  it('roots at the dimension when there is no parent', () => {
    expect(defaultTagKey('angle', 'How To', null)).toBe('angle.how-to')
  })

  it('falls back to the dimension when the parent has no key of its own', () => {
    expect(defaultTagKey('format', 'One Pager', tag({ key: null }))).toBe('format.one-pager')
  })
})

describe('slugify', () => {
  it('lowercases, hyphenates spaces and drops everything unsafe', () => {
    expect(slugify('  Product Launch (2026)!  ')).toBe('product-launch-2026')
  })

  it('keeps dots, underscores and hyphens — they are meaningful in keys', () => {
    expect(slugify('a.b_c-d')).toBe('a.b_c-d')
  })
})

describe('dimLabel', () => {
  const client = (labels?: Record<string, string>) => ({ dimensionLabels: labels } as unknown as Client)

  it('uses the client’s own label when set', () => {
    expect(dimLabel(client({ entity: 'Product line' }), 'entity')).toBe('Product line')
  })

  it('falls back per dimension, not all-or-nothing', () => {
    const c = client({ entity: 'Product line' })
    expect(dimLabel(c, 'angle')).toBe('Angle')
    expect(dimLabel(c, 'format')).toBe('Format')
  })

  it('falls back for a client with no labels at all', () => {
    expect(dimLabel(null, 'entity')).toBe('Entity')
    expect(dimLabel({} as Client, 'format')).toBe('Format')
  })
})

describe('clientFileSlug', () => {
  it('prefers the client slug', () => {
    expect(clientFileSlug({ slug: 'ess', name: 'ESS Pricing' } as Client)).toBe('ess')
  })

  it('derives one from the name when there is no slug', () => {
    expect(clientFileSlug({ slug: '  ', name: 'ESS Pricing' } as Client)).toBe('ess-pricing')
  })

  it('never produces an empty filename', () => {
    expect(clientFileSlug({ slug: '', name: '!!!' } as Client)).toBe('client')
  })
})
