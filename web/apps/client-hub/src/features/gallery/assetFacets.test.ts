/* Asset facet logic — the portal's FIRST hermetic tests.
 *
 * The web app had zero test coverage. These need no DOM: the logic below decides what a variant
 * picker reads like, which is the difference between "Slides / PDF / Print" and three chips all
 * saying the same thing.
 */

import { describe, it, expect } from 'vitest'
import { labelSet, sharedLabels, uniqueLabel, matchesActiveFacets } from './assetFacets'
import type { Asset } from '@sotto/asset-library'

const asset = (over: Partial<Asset> = {}): Asset => ({
  id: 'a1', clientId: 'c1', name: 'Product Slides — Deck',
  entityType: 'product', entity: 'Product', formats: ['Slides'], angle: 'Overview',
  status: 'published', perm: 'public', version: 'v1', latest: true,
  avg: 0, count: 0, comments: 0, approval: 'none', updatedAt: '2026-01-01',
  ...over,
})

describe('labelSet', () => {
  it('collects labels from the array fields when present', () => {
    const s = labelSet(asset({ entities: ['Product', 'Acquisition'], angles: ['Overview'], formats: ['Slides'] }))
    expect(s).toEqual(new Set(['Product', 'Acquisition', 'Overview', 'Slides']))
  })

  it('falls back to the singular field when the array is empty', () => {
    // Older rows carry only `entity`/`angle`; both shapes must yield the same labels.
    const s = labelSet(asset({ entities: [], angles: [], entity: 'Product', angle: 'Overview' }))
    expect(s).toEqual(new Set(['Product', 'Overview', 'Slides']))
  })

  it('drops an empty singular value rather than adding a blank label', () => {
    const s = labelSet(asset({ entities: [], angles: [], entity: '', angle: '', formats: ['Slides'] }))
    expect(s).toEqual(new Set(['Slides']))
  })

  it('includes tagsAll when present', () => {
    const s = labelSet(asset({ tagsAll: ['Sales'] }))
    expect(s.has('Sales')).toBe(true)
  })
})

describe('sharedLabels', () => {
  it('returns only labels present on every row', () => {
    const rows = [
      asset({ entities: ['Product'], formats: ['Slides'] }),
      asset({ entities: ['Product'], formats: ['PDF'] }),
    ]
    expect(sharedLabels(rows)).toEqual(['Product', 'Overview'])
  })

  it('returns everything for a single row', () => {
    expect(new Set(sharedLabels([asset()]))).toEqual(new Set(['Product', 'Overview', 'Slides']))
  })

  it('returns nothing when the rows have no label in common', () => {
    const rows = [
      asset({ entities: ['Product'], angles: [], angle: '', formats: ['Slides'] }),
      asset({ entities: ['Acquisition'], angles: [], angle: '', formats: ['PDF'] }),
    ]
    expect(sharedLabels(rows)).toEqual([])
  })

  it('handles an empty group without throwing', () => {
    expect(sharedLabels([])).toEqual([])
  })
})

describe('uniqueLabel', () => {
  it('strips the shared labels to leave what distinguishes a variant', () => {
    const row = asset({ name: 'Product Slides Deck' })
    expect(uniqueLabel(row, ['Product', 'Slides'])).toBe('Deck')
  })

  it('cleans up the separators left behind', () => {
    // "Product — Deck" minus "Product" would otherwise read "— Deck".
    const row = asset({ name: 'Product — Deck' })
    expect(uniqueLabel(row, ['Product'])).toBe('Deck')
  })

  it('collapses the whitespace a removal leaves in the middle', () => {
    const row = asset({ name: 'Product Slides Launch Deck' })
    expect(uniqueLabel(row, ['Slides'])).toBe('Product Launch Deck')
  })

  it('falls back to the full name when nothing distinctive remains', () => {
    // A blank chip is worse than a repeated one.
    const row = asset({ name: 'Product' })
    expect(uniqueLabel(row, ['Product'])).toBe('Product')
  })

  it('is unchanged when no labels are shared', () => {
    const row = asset({ name: 'Product Slides — Deck' })
    expect(uniqueLabel(row, [])).toBe('Product Slides — Deck')
  })
})

describe('matchesActiveFacets', () => {
  it('is false when no facets are active — nothing to highlight', () => {
    expect(matchesActiveFacets(asset(), undefined)).toBe(false)
    expect(matchesActiveFacets(asset(), {})).toBe(false)
  })

  it('matches on any single dimension (OR, not AND)', () => {
    const a = asset({ entities: ['Product'], formats: ['Slides'], angles: ['Overview'] })
    expect(matchesActiveFacets(a, { entities: ['Product'] })).toBe(true)
    expect(matchesActiveFacets(a, { formats: ['Slides'] })).toBe(true)
    expect(matchesActiveFacets(a, { angles: ['Overview'] })).toBe(true)
  })

  it('matches when only ONE of several active facets hits', () => {
    const a = asset({ entities: ['Product'], formats: ['Slides'] })
    expect(matchesActiveFacets(a, { entities: ['Nope'], formats: ['Slides'] })).toBe(true)
  })

  it('is false when no active facet hits', () => {
    const a = asset({ entities: ['Product'], formats: ['Slides'], angles: ['Overview'] })
    expect(matchesActiveFacets(a, { entities: ['Acquisition'], formats: ['PDF'] })).toBe(false)
  })

  it('uses the singular fallback fields for older rows', () => {
    const a = asset({ entities: [], angles: [], entity: 'Product', angle: 'Overview' })
    expect(matchesActiveFacets(a, { entities: ['Product'] })).toBe(true)
    expect(matchesActiveFacets(a, { angles: ['Overview'] })).toBe(true)
  })
})
