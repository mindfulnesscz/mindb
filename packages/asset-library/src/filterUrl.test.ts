/* FilterState ⇄ query string.
 *
 * Two of these tests are load-bearing rather than thorough:
 *
 * — COMMA SAFETY is the whole reason multi-value params are repeated rather than joined. Tag labels
 *   are free text from a client's vocabulary, so one will contain a comma eventually, and a
 *   `split(',')` would turn one tag into two silently. Pinned so nobody "simplifies" the encoding.
 *
 * — THE EXACT CANONICAL STRING is asserted, not merely that two orderings agree. Phase 5 keys the
 *   TanStack Query cache on that string. If it drifts, nothing breaks visibly — the hit rate just
 *   falls, which is not the sort of regression anyone notices from the UI.
 *
 * The round trip is stated as IDEMPOTENCE, not as a fixed point. Serializing sorts arrays and trims
 * `search`, so a FilterState with unsorted tags or a padded query is deliberately not its own
 * round-trip identity; its canonical form is.
 */

import { describe, it, expect } from 'vitest'
import { getDefaultFilters } from './filters.js'
import { filterCacheKey, filtersToSearchParams, searchParamsToFilters, FILTER_PARAMS } from './filterUrl.js'
import type { FilterState } from './types.js'

const filters = (over: Partial<FilterState> = {}): FilterState => ({ ...getDefaultFilters(), ...over })

const CASES: [string, FilterState][] = [
  ['defaults',            filters()],
  ['search only',         filters({ search: 'oak chair' })],
  ['latest only',         filters({ latestOnly: true })],
  ['one status',          filters({ status: ['approved'] })],
  ['two statuses',        filters({ status: ['published', 'approved'] })],
  ['perms',               filters({ perms: ['client', 'public'] })],
  ['entity types',        filters({ entityTypes: ['product', 'event'] })],
  ['free-text tags',      filters({ entities: ['Sofa', 'Chair'], formats: ['Web'], angles: ['Front'] })],
  ['everything at once',  filters({
    search: 'hero', latestOnly: true, status: ['approved', 'published'], perms: ['client'],
    entityTypes: ['product'], entities: ['Sofa'], formats: ['Web', 'Print'], angles: ['Front'],
  })],
  ['awkward labels',      filters({ entities: ['Sofa, 3-seat', 'A&B', 'q=1', '100% wool', 'ü/ö'] })],
]

describe('round trip', () => {
  it.each(CASES)('is idempotent over the canonical form — %s', (_name, f) => {
    const canonical = searchParamsToFilters(filtersToSearchParams(f))
    expect(searchParamsToFilters(filtersToSearchParams(canonical))).toEqual(canonical)
  })

  it.each(CASES)('preserves every value — %s', (_name, f) => {
    const back = searchParamsToFilters(filtersToSearchParams(f))
    expect(back.search).toBe(f.search.trim())
    expect(back.latestOnly).toBe(f.latestOnly)
    expect([...back.status].sort()).toEqual([...f.status].sort())
    expect([...back.perms].sort()).toEqual([...f.perms].sort())
    expect([...back.entityTypes].sort()).toEqual([...f.entityTypes].sort())
    expect([...back.entities].sort()).toEqual([...f.entities].sort())
    expect([...back.formats].sort()).toEqual([...f.formats].sort())
    expect([...back.angles].sort()).toEqual([...f.angles].sort())
  })
})

describe('canonicalization', () => {
  it('sorts arrays on write', () => {
    const params = filtersToSearchParams(filters({ entities: ['Sofa', 'Chair', 'Bed'] }))
    expect(params.getAll('entity')).toEqual(['Bed', 'Chair', 'Sofa'])
  })

  it('sorts arrays on read', () => {
    const back = searchParamsToFilters(new URLSearchParams('entity=Sofa&entity=Bed&entity=Chair'))
    expect(back.entities).toEqual(['Bed', 'Chair', 'Sofa'])
  })

  it('trims search on write', () => {
    expect(filtersToSearchParams(filters({ search: '  chair  ' })).get('q')).toBe('chair')
  })

  it('omits a search that is only whitespace', () => {
    expect(filtersToSearchParams(filters({ search: '   ' })).toString()).toBe('')
  })

  it('de-duplicates repeated values', () => {
    const back = searchParamsToFilters(new URLSearchParams('entity=Sofa&entity=Sofa&status=approved&status=approved'))
    expect(back.entities).toEqual(['Sofa'])
    expect(back.status).toEqual(['approved'])
  })

  it('emits keys in FILTER_PARAMS order, whatever order the state was built in', () => {
    const key = filterCacheKey(filters({
      angles: ['Front'], perms: ['client'], search: 'x', latestOnly: true,
      status: ['approved'], entityTypes: ['product'], entities: ['Sofa'], formats: ['Web'],
    }))
    expect(key).toBe('q=x&latest=1&status=approved&type=product&entity=Sofa&format=Web&angle=Front&perm=client')
    // The order above IS the declaration order of FILTER_PARAMS. If that object is reordered this
    // fails, which is the intent — reordering it changes every cache key and every shared link.
    expect(Object.values(FILTER_PARAMS)).toEqual(['q', 'latest', 'status', 'type', 'entity', 'format', 'angle', 'perm'])
  })
})

describe('defaults are omitted', () => {
  it('the default view has an empty query string', () => {
    expect(filtersToSearchParams(getDefaultFilters()).toString()).toBe('')
    expect(filterCacheKey(getDefaultFilters())).toBe('')
  })

  it('latestOnly false writes nothing', () => {
    expect(filtersToSearchParams(filters({ latestOnly: false })).has('latest')).toBe(false)
  })

  it('an empty array writes nothing', () => {
    expect(filtersToSearchParams(filters({ entities: [], status: [] })).toString()).toBe('')
  })
})

describe('the cache key is canonical', () => {
  it('same tags in different array order produce the same string', () => {
    const a = filterCacheKey(filters({ entities: ['Sofa', 'Chair'], formats: ['Print', 'Web'] }))
    const b = filterCacheKey(filters({ entities: ['Chair', 'Sofa'], formats: ['Web', 'Print'] }))
    expect(a).toBe(b)
    expect(a).toBe('entity=Chair&entity=Sofa&format=Print&format=Web')
  })

  it('a padded search and its trimmed twin produce the same string', () => {
    expect(filterCacheKey(filters({ search: ' hero ' }))).toBe(filterCacheKey(filters({ search: 'hero' })))
  })

  it('different filters produce different strings', () => {
    expect(filterCacheKey(filters({ entities: ['Sofa'] })))
      .not.toBe(filterCacheKey(filters({ entities: ['Chair'] })))
  })
})

describe('comma and ampersand safety — the reason params are repeated', () => {
  it('a tag containing a comma survives as ONE tag', () => {
    const f = filters({ entities: ['Sofa, 3-seat', 'Chair'] })
    const back = searchParamsToFilters(filtersToSearchParams(f))
    expect(back.entities).toEqual(['Chair', 'Sofa, 3-seat'])
    expect(back.entities).toHaveLength(2)
  })

  it('a tag containing an ampersand survives intact', () => {
    const back = searchParamsToFilters(filtersToSearchParams(filters({ formats: ['Black & White'] })))
    expect(back.formats).toEqual(['Black & White'])
  })

  it('a tag that looks like a query string of its own survives intact', () => {
    // The nastiest case: a label whose text is `q=1&latest=1` must not become two more params.
    const back = searchParamsToFilters(filtersToSearchParams(filters({ angles: ['q=1&latest=1'] })))
    expect(back.angles).toEqual(['q=1&latest=1'])
    expect(back.search).toBe('')
    expect(back.latestOnly).toBe(false)
  })

  it('a tag containing a plus sign survives intact', () => {
    // `+` decodes to a space in form encoding, so this is where a naive decoder corrupts a label.
    const back = searchParamsToFilters(filtersToSearchParams(filters({ entities: ['A+B'] })))
    expect(back.entities).toEqual(['A+B'])
  })
})

describe('tolerance — a stale or hand-edited URL degrades, never crashes', () => {
  it('junk yields the defaults', () => {
    expect(searchParamsToFilters(new URLSearchParams('status=banana&unknown=1&latest=yes')))
      .toEqual(getDefaultFilters())
  })

  it('an empty query string yields the defaults', () => {
    expect(searchParamsToFilters(new URLSearchParams(''))).toEqual(getDefaultFilters())
  })

  it('an unknown status is dropped and the valid ones kept', () => {
    // Dropped rather than forwarded: PostgREST rejects the whole query on an unknown enum value, so
    // passing it through would turn one bad character in a link into a connection error.
    expect(searchParamsToFilters(new URLSearchParams('status=approved&status=banana&status=published')).status)
      .toEqual(['approved', 'published'])
  })

  it('an unknown perm or entity type is dropped', () => {
    const back = searchParamsToFilters(new URLSearchParams('perm=superuser&type=spaceship&type=product'))
    expect(back.perms).toEqual([])
    expect(back.entityTypes).toEqual(['product'])
  })

  it('archived and disconnected are accepted — a staff link must not be silently narrowed', () => {
    // The trap the spec calls out: validating against STATUS_KEYS_CLIENT would drop these two.
    expect(searchParamsToFilters(new URLSearchParams('status=archived&status=disconnected')).status)
      .toEqual(['archived', 'disconnected'])
  })

  it('an empty repeated value is dropped rather than filtered on', () => {
    expect(searchParamsToFilters(new URLSearchParams('entity=&entity=Sofa')).entities).toEqual(['Sofa'])
  })

  it('unknown params are ignored, not lost from the parse', () => {
    const back = searchParamsToFilters(new URLSearchParams('foo=1&entity=Sofa&utm_source=email'))
    expect(back.entities).toEqual(['Sofa'])
  })

  it('param order does not matter', () => {
    const a = searchParamsToFilters(new URLSearchParams('entity=A&q=x'))
    const b = searchParamsToFilters(new URLSearchParams('q=x&entity=A'))
    expect(a).toEqual(b)
  })

  it('latest accepts only the literal 1', () => {
    for (const v of ['yes', 'true', '0', '', 'on', '2']) {
      expect(searchParamsToFilters(new URLSearchParams(`latest=${v}`)).latestOnly).toBe(false)
    }
    expect(searchParamsToFilters(new URLSearchParams('latest=1')).latestOnly).toBe(true)
  })

  it('a search of only whitespace parses as no search', () => {
    expect(searchParamsToFilters(new URLSearchParams('q=%20%20')).search).toBe('')
  })
})
