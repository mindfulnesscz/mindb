/* Taxonomy document validation.
 *
 * This is the gate on an IMPORT path: a client's whole tag tree is replaced from a JSON file, and
 * the tags are what every filter, Obsidian export and asset row references by key. A malformed
 * document that slips through does not fail loudly — it quietly reshapes a client's taxonomy.
 *
 * So the rules are pinned individually, including the ones that are easy to regress: duplicate
 * keys, a parent that does not exist, self-parenting, and cycles.
 */

import { describe, it, expect } from 'vitest'
import { parseTaxonomyJsonText, validateTaxonomyDocument, parseAndValidateTaxonomyJson } from './validate'

const TAXONOMY_JSON_VERSION = 1

const doc = (over: Record<string, unknown> = {}) => ({
  version: TAXONOMY_JSON_VERSION,
  dimension_labels: { entity: 'Entity', angle: 'Angle', format: 'Format' },
  nodes: [],
  ...over,
})

const node = (over: Record<string, unknown> = {}) => ({
  key: 'entity.product', dimension: 'entity', name: 'Product', ...over,
})

describe('parseTaxonomyJsonText', () => {
  it('returns the parsed value for valid JSON', () => {
    expect(parseTaxonomyJsonText('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
  })

  it('reports the parser message rather than throwing', () => {
    const r = parseTaxonomyJsonText('{nope}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeTruthy()
  })

  it('does NOT validate the schema — that is a separate step', () => {
    // A syntactically fine but semantically wrong document parses cleanly here.
    expect(parseTaxonomyJsonText('42')).toEqual({ ok: true, value: 42 })
  })
})

describe('validateTaxonomyDocument — document shape', () => {
  it('accepts a minimal valid document', () => {
    const r = validateTaxonomyDocument(doc())
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.document?.dimension_labels).toEqual({ entity: 'Entity', angle: 'Angle', format: 'Format' })
  })

  it('rejects a non-object root, including an array', () => {
    expect(validateTaxonomyDocument(null).ok).toBe(false)
    expect(validateTaxonomyDocument('x').ok).toBe(false)
    // An array is an object to typeof — this is the check that catches it.
    expect(validateTaxonomyDocument([]).ok).toBe(false)
  })

  it('rejects a wrong or missing version', () => {
    expect(validateTaxonomyDocument(doc({ version: 999 })).ok).toBe(false)
    expect(validateTaxonomyDocument(doc({ version: undefined })).ok).toBe(false)
  })

  it('requires all three dimension labels, individually', () => {
    const r = validateTaxonomyDocument(doc({ dimension_labels: { entity: 'E' } }))
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('angle'))).toBe(true)
    expect(r.errors.some(e => e.includes('format'))).toBe(true)
  })

  it('treats a whitespace-only label as missing', () => {
    const r = validateTaxonomyDocument(doc({ dimension_labels: { entity: '  ', angle: 'A', format: 'F' } }))
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('entity'))).toBe(true)
  })

  it('stops at a non-array nodes rather than reporting per-node noise', () => {
    const r = validateTaxonomyDocument(doc({ nodes: 'not-an-array' }))
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('nodes must be an array'))).toBe(true)
  })

  it('warns — but does not fail — on an empty node list', () => {
    const r = validateTaxonomyDocument(doc({ nodes: [] }))
    expect(r.ok).toBe(true)
    expect(r.warnings.some(w => w.includes('empty'))).toBe(true)
  })

  it('carries optional name and description through, and omits them when blank', () => {
    expect(validateTaxonomyDocument(doc({ name: 'ESS', description: 'd' })).document)
      .toMatchObject({ name: 'ESS', description: 'd' })
    expect(validateTaxonomyDocument(doc({ name: '   ' })).document?.name).toBeUndefined()
  })
})

describe('validateTaxonomyDocument — per-node rules', () => {
  it('requires key, name and dimension', () => {
    const r = validateTaxonomyDocument(doc({ nodes: [{}] }))
    expect(r.ok).toBe(false)
    for (const field of ['key', 'name', 'dimension']) {
      expect(r.errors.some(e => e.includes(`nodes[0].${field}`))).toBe(true)
    }
  })

  it('restricts dimension to the three real ones', () => {
    const r = validateTaxonomyDocument(doc({ nodes: [node({ dimension: 'colour' })] }))
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('entity|angle|format'))).toBe(true)
  })

  it('names the offending index, so a 200-node file is diagnosable', () => {
    const r = validateTaxonomyDocument(doc({ nodes: [node(), node({ key: 'a', name: '' })] }))
    expect(r.errors.some(e => e.startsWith('nodes[1]'))).toBe(true)
  })

  it('rejects a duplicate key — keys are the addresses everything else references', () => {
    const r = validateTaxonomyDocument(doc({ nodes: [node(), node()] }))
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('duplicated'))).toBe(true)
  })

  it('rejects a non-object node', () => {
    expect(validateTaxonomyDocument(doc({ nodes: ['nope'] })).ok).toBe(false)
  })

  it('treats absent, null and empty-string parent_key alike as "no parent"', () => {
    for (const parent_key of [undefined, null, '']) {
      const r = validateTaxonomyDocument(doc({ nodes: [node({ parent_key })] }))
      expect(r.ok).toBe(true)
      expect(r.document?.nodes[0].parent_key).toBeNull()
    }
  })

  it('caps shortcode at 12 characters', () => {
    expect(validateTaxonomyDocument(doc({ nodes: [node({ shortcode: 'a'.repeat(12) })] })).ok).toBe(true)
    expect(validateTaxonomyDocument(doc({ nodes: [node({ shortcode: 'a'.repeat(13) })] })).ok).toBe(false)
  })

  it('normalises an absent or blank shortcode to null instead of an empty string', () => {
    expect(validateTaxonomyDocument(doc({ nodes: [node()] })).document?.nodes[0].shortcode).toBeNull()
    expect(validateTaxonomyDocument(doc({ nodes: [node({ shortcode: '' })] })).document?.nodes[0].shortcode).toBeNull()
  })

  it('requires sort_order to be a finite number, and truncates it', () => {
    expect(validateTaxonomyDocument(doc({ nodes: [node({ sort_order: '3' })] })).ok).toBe(false)
    expect(validateTaxonomyDocument(doc({ nodes: [node({ sort_order: Infinity })] })).ok).toBe(false)
    expect(validateTaxonomyDocument(doc({ nodes: [node({ sort_order: 3.9 })] })).document?.nodes[0].sort_order).toBe(3)
  })

  it('defaults sort_order to 0 when absent', () => {
    expect(validateTaxonomyDocument(doc({ nodes: [node()] })).document?.nodes[0].sort_order).toBe(0)
  })

  it('warns that `meta` is ignored rather than silently dropping it', () => {
    const r = validateTaxonomyDocument(doc({ nodes: [node({ meta: { x: 1 } })] }))
    expect(r.ok).toBe(true)
    expect(r.warnings.some(w => w.includes('meta is ignored'))).toBe(true)
  })
})

describe('validateTaxonomyDocument — hierarchy integrity', () => {
  it('rejects a parent_key that no node declares', () => {
    const r = validateTaxonomyDocument(doc({ nodes: [node({ parent_key: 'entity.missing' })] }))
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('not found'))).toBe(true)
  })

  it('accepts a valid parent reference in either declaration order', () => {
    // The parent may appear AFTER the child in the file — keys are collected before linking.
    const child = node({ key: 'entity.product.launch', parent_key: 'entity.product' })
    expect(validateTaxonomyDocument(doc({ nodes: [child, node()] })).ok).toBe(true)
  })

  it('rejects a node parenting itself', () => {
    const r = validateTaxonomyDocument(doc({ nodes: [node({ parent_key: 'entity.product' })] }))
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('cannot parent itself'))).toBe(true)
  })

  it('detects a two-node cycle', () => {
    // a → b → a. Without this check the import would build an infinite tree.
    const r = validateTaxonomyDocument(doc({
      nodes: [
        node({ key: 'a', name: 'A', parent_key: 'b' }),
        node({ key: 'b', name: 'B', parent_key: 'a' }),
      ],
    }))
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('cycle detected'))).toBe(true)
  })

  it('detects a longer cycle', () => {
    const r = validateTaxonomyDocument(doc({
      nodes: [
        node({ key: 'a', name: 'A', parent_key: 'c' }),
        node({ key: 'b', name: 'B', parent_key: 'a' }),
        node({ key: 'c', name: 'C', parent_key: 'b' }),
      ],
    }))
    expect(r.ok).toBe(false)
    expect(r.errors.some(e => e.includes('cycle detected'))).toBe(true)
  })

  it('does NOT mistake a deep valid chain for a cycle', () => {
    const r = validateTaxonomyDocument(doc({
      nodes: [
        node({ key: 'a', name: 'A' }),
        node({ key: 'b', name: 'B', parent_key: 'a' }),
        node({ key: 'c', name: 'C', parent_key: 'b' }),
        node({ key: 'd', name: 'D', parent_key: 'c' }),
      ],
    }))
    expect(r.ok).toBe(true)
  })

  it('does not report a cycle for a node whose parent is merely missing', () => {
    // The walk stops at an unknown key, so a dangling parent is one error, not two.
    const r = validateTaxonomyDocument(doc({ nodes: [node({ parent_key: 'nope' })] }))
    expect(r.errors.some(e => e.includes('cycle detected'))).toBe(false)
  })
})

describe('parseAndValidateTaxonomyJson', () => {
  it('reports a JSON syntax error as a validation failure', () => {
    const r = parseAndValidateTaxonomyJson('{oops}')
    expect(r.ok).toBe(false)
    expect(r.errors.length).toBeGreaterThan(0)
  })

  it('validates a well-formed document end to end', () => {
    const r = parseAndValidateTaxonomyJson(JSON.stringify(doc({ nodes: [node()] })))
    expect(r.ok).toBe(true)
    expect(r.document?.nodes).toHaveLength(1)
  })
})
