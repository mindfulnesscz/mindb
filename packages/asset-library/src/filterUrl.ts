/* FilterState ⇄ query string.
 *
 * Lives here because this package already owns `FilterState` and `getDefaultFilters()`. Pure — no
 * React, no `window`, no router — so it runs in plain node under the `packages/*` test include and
 * is testable without booting an app.
 *
 * THE URL IS A PUBLISHED FORMAT. Every param name below appears in links that have already been
 * sent to clients. Renaming one re-points or breaks those links, so treat this module the way
 * `toSlug` is treated: additive changes only.
 *
 * Three properties this module is responsible for, in order of how expensive they are to get wrong:
 *
 * 1. NO SILENT TAG SPLITTING. Multi-value params are REPEATED (`?entity=Sofa&entity=Chair`), never
 *    comma-joined. Tag labels are free text from a client's own vocabulary and one of them will
 *    eventually contain a comma; `getAll()` cannot mis-split, a `split(',')` always will.
 * 2. CANONICAL OUTPUT. One filter set has exactly one string: keys in a fixed order, arrays sorted
 *    and de-duplicated, `search` trimmed. The TanStack Query cache is keyed on that string, so a
 *    non-deterministic ordering would halve the hit rate without any visible symptom.
 * 3. TOLERANT INPUT. A URL is untrusted, hand-editable, and may be months stale. Unknown params are
 *    ignored, a malformed value falls back to the default, and a value outside the allowed
 *    vocabulary is DROPPED rather than forwarded to PostgREST, which would reject the whole query.
 */

import { getDefaultFilters } from './filters.js'
import {
  ASSET_PERMS, ASSET_STATUSES, ENTITY_TYPES,
  type AssetPerm, type AssetStatus, type EntityType, type FilterState,
} from './types.js'

/**
 * URL param name per `FilterState` key.
 *
 * These are stable dimension KEYS, never a client's `dimensionLabels`. A client renaming "Entity"
 * to "Product" must not break links that are already out.
 *
 * `v` is deliberately absent and must stay absent: it is the content-hash cache-buster on asset CDN
 * URLs (`packages/domain/src/assetStorage.ts`), and reusing the name in the app's own namespace is
 * the kind of collision that is discovered by someone debugging a cache miss.
 *
 * Iteration order here is the emission order of the query string. Do not reorder — it changes every
 * canonical string and therefore every cache key.
 */
export const FILTER_PARAMS = {
  search:      'q',
  latestOnly:  'latest',
  status:      'status',
  entityTypes: 'type',
  entities:    'entity',
  formats:     'format',
  angles:      'angle',
  perms:       'perm',
} as const

/**
 * Canonical form for a repeated param: de-duplicated and sorted.
 *
 * Plain `sort()`, NOT `localeCompare` — code-unit order is identical on every engine and in every
 * locale. A locale-sensitive comparator would make the cache key depend on the user's browser
 * language, which is exactly the sort of thing that only shows up in production.
 */
function canonicalList(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

/** Keep only members of a closed vocabulary; drop anything else. */
function only<T extends string>(values: string[], allowed: readonly T[]): T[] {
  const set = new Set<string>(allowed)
  return canonicalList(values).filter((v): v is T => set.has(v))
}

/**
 * `FilterState` → `URLSearchParams`.
 *
 * Only values differing from `getDefaultFilters()` are written, so the default view has an empty
 * query string and `/ess` stays the canonical clean URL for a client's portal.
 *
 * Output is canonical: keys in `FILTER_PARAMS` order, arrays sorted and de-duplicated, `search`
 * trimmed. A `FilterState` carrying unsorted tags or a padded search string is therefore NOT its own
 * round-trip fixed point — the canonical form of it is. See `filterUrl.test.ts`.
 *
 * Note `URLSearchParams.toString()` encodes a space as `+`, not `%20`. That is correct
 * `application/x-www-form-urlencoded` and it round-trips through the same class, so it is left
 * alone; hand-rolling the encoding to get `%20` would risk a serialize/parse mismatch for cosmetics.
 */
export function filtersToSearchParams(filters: FilterState): URLSearchParams {
  const params = new URLSearchParams()

  const search = filters.search?.trim() ?? ''
  if (search) params.set(FILTER_PARAMS.search, search)

  if (filters.latestOnly) params.set(FILTER_PARAMS.latestOnly, '1')

  const lists: [string, readonly string[]][] = [
    [FILTER_PARAMS.status,      filters.status      ?? []],
    [FILTER_PARAMS.entityTypes, filters.entityTypes ?? []],
    [FILTER_PARAMS.entities,    filters.entities    ?? []],
    [FILTER_PARAMS.formats,     filters.formats     ?? []],
    [FILTER_PARAMS.angles,      filters.angles      ?? []],
    [FILTER_PARAMS.perms,       filters.perms       ?? []],
  ]
  for (const [name, values] of lists) {
    for (const value of canonicalList(values)) params.append(name, value)
  }

  return params
}

/**
 * `URLSearchParams` → `FilterState`, merged over `getDefaultFilters()`.
 *
 * Tolerant by contract. A hand-edited, truncated or stale URL must degrade to a valid view — never
 * to a crash, and never to a query PostgREST throws on. The result is already canonical, so it is
 * safe to hand straight to `filterCacheKey`.
 */
export function searchParamsToFilters(params: URLSearchParams): FilterState {
  const defaults = getDefaultFilters()

  const search = params.get(FILTER_PARAMS.search)?.trim()

  return {
    ...defaults,
    search: search || defaults.search,
    // Only the literal '1' is true. Anything else — 'yes', 'true', '0', '' — is the default, so a
    // guessed value reads as "not set" rather than silently flipping the view.
    latestOnly: params.get(FILTER_PARAMS.latestOnly) === '1',
    status:      only<AssetStatus>(params.getAll(FILTER_PARAMS.status),      ASSET_STATUSES),
    perms:       only<AssetPerm>  (params.getAll(FILTER_PARAMS.perms),       ASSET_PERMS),
    entityTypes: only<EntityType> (params.getAll(FILTER_PARAMS.entityTypes), ENTITY_TYPES),
    // Free text from the client's own vocabulary — there is nothing to validate against, and
    // URLSearchParams has already handled the escaping. Empty strings are dropped: `?entity=` is a
    // truncated link, not a filter for the empty tag.
    entities: canonicalList(params.getAll(FILTER_PARAMS.entities).filter(Boolean)),
    formats:  canonicalList(params.getAll(FILTER_PARAMS.formats).filter(Boolean)),
    angles:   canonicalList(params.getAll(FILTER_PARAMS.angles).filter(Boolean)),
  }
}

/**
 * Canonical string form — `''` for the default view.
 *
 * This is the same string the address bar shows and the same string the data cache is keyed on.
 * Those being one value is the point: Back and Forward hit warm cache by construction rather than
 * by a separate memoization that has to be kept in step.
 */
export function filterCacheKey(filters: FilterState): string {
  return filtersToSearchParams(filters).toString()
}
