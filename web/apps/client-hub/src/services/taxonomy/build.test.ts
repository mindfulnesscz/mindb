/* The export must round-trip: whatever it produces has to pass the importer's own validator.
 *
 * It did not. `parent_key` mirrored `parent_id` faithfully, so a self-referencing tag row produced a
 * file the portal then refused — the failure surfaced on IMPORT, one step away from the corruption,
 * reading as "your file is bad" rather than "these rows are bad".
 */

import { describe, expect, it, vi } from 'vitest'
import { buildTaxonomyDocument, type TaxonomyExportTag } from './build'
import { validateTaxonomyDocument } from './validate'

const client = { name: 'Mucha Family' }

const tag = (over: Partial<TaxonomyExportTag> & { id: string }): TaxonomyExportTag => ({
  name: over.id,
  key: null,
  shortcode: null,
  dimension: 'format',
  parentId: null,
  sortOrder: 0,
  ...over,
})

describe('buildTaxonomyDocument', () => {
  it('drops a self-referencing parent, and the result validates', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The shape reported from the field: a row whose parent_id is its own id.
    const doc = buildTaxonomyDocument(client, [tag({ id: 'a', name: 'Document', parentId: 'a' })])

    expect(doc.nodes[0].parent_key).toBeNull()
    expect(validateTaxonomyDocument(doc).errors).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('still need fixing'))
    warn.mockRestore()
  })

  it('breaks a two-node cycle rather than emitting it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const doc = buildTaxonomyDocument(client, [
      tag({ id: 'a', name: 'Asset', parentId: 'b' }),
      tag({ id: 'b', name: 'Package', parentId: 'a' }),
    ])

    expect(validateTaxonomyDocument(doc).errors).toEqual([])
    // Exactly one edge is cut — breaking the cycle must not flatten the whole branch.
    expect(doc.nodes.filter(n => n.parent_key === null)).toHaveLength(1)
    warn.mockRestore()
  })

  it('leaves an ordinary hierarchy completely alone', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const doc = buildTaxonomyDocument(client, [
      tag({ id: 'group', name: 'Type' }),
      tag({ id: 'leaf', name: 'Image', shortcode: 'Img', parentId: 'group' }),
    ])

    const leaf = doc.nodes.find(n => n.name === 'Image')!
    const group = doc.nodes.find(n => n.name === 'Type')!
    expect(leaf.parent_key).toBe(group.key)
    expect(group.parent_key).toBeNull()
    expect(validateTaxonomyDocument(doc).errors).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('produces a document that validates for the real reported taxonomy shape', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Three self-parents plus two children hanging off them — the exact failing export.
    const doc = buildTaxonomyDocument(client, [
      tag({ id: 'asset1', name: 'Asset', parentId: 'asset1' }),
      tag({ id: 'asset2', name: 'Asset', parentId: 'asset2' }),
      tag({ id: 'doc', name: 'Document', parentId: 'doc' }),
      tag({ id: 'pkg', name: 'Package', parentId: 'asset2' }),
      tag({ id: '3d', name: '3D', parentId: 'doc' }),
    ])

    const result = validateTaxonomyDocument(doc)
    expect(result.errors).toEqual([])
    // The children keep their (now valid) parents; only the self-loops were cut.
    expect(doc.nodes.find(n => n.name === 'Package')!.parent_key).not.toBeNull()
    warn.mockRestore()
  })
})
