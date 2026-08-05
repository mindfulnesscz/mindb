/* Filter state, backed by the URL.
 *
 * A drop-in for `useState<FilterState>` in GalleryView — same `[value, setter]` shape, including the
 * updater form, so the call site changes by one line. The encoding itself lives in
 * `@sotto/asset-library/filterUrl`, which is pure; this file is only the React binding.
 *
 * REPLACE, NOT PUSH. A filter change is a refinement of where you are, not a new place. Pushing
 * would add one history entry per checkbox and per debounced keystroke, so Back would become a slow
 * rewind through every intermediate state instead of leaving the portal. Opening an asset pushes
 * (Phase 3); filtering does not.
 *
 * ── Why this is not built on `useSearchParams`'s setter ────────────────────────────────────────
 *
 * `react-router-dom@6.30.4` (`dist/index.js:1030`) closes `setSearchParams` over the `searchParams`
 * value FROM RENDER:
 *
 *     let setSearchParams = React.useCallback((nextInit, navigateOptions) => {
 *       const newSearchParams = createSearchParams(
 *         typeof nextInit === "function" ? nextInit(searchParams) : nextInit)
 *       ...
 *     }, [navigate, searchParams])
 *
 * So the functional form does NOT behave like `useState`'s: two calls in the same tick both see the
 * pre-navigation params and the second silently wins. `GalleryView` already uses the updater form,
 * and Phase 4b adds writers that can fire in one handler. Its identity also churns on every URL
 * change, which poisons any dependency list built on it.
 *
 * Hence `useNavigate` plus a ref mirror of the live search/hash. The ref is re-synced from the
 * router on every render AND written synchronously by the setter, so a second write in the same tick
 * composes on top of the first rather than replacing it.
 */

import { useCallback, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  FILTER_PARAMS, filtersToSearchParams, searchParamsToFilters, type FilterState,
} from '@sotto/asset-library'

type SetFilters = (next: FilterState | ((current: FilterState) => FilterState)) => void

/** Param names this hook owns. Everything else in the query string is left alone. */
const OWNED = Object.values(FILTER_PARAMS) as string[]

/**
 * Filter params, canonical, followed by any param this hook does not own — `focus`, `lb`, a `utm_*`
 * from a mail client — in the order they arrived. Deterministic, so the same filter set over the
 * same foreign params always produces the same string.
 */
function writeFilters(currentSearch: string, filters: FilterState): string {
  const out = filtersToSearchParams(filters)
  for (const [name, value] of new URLSearchParams(currentSearch)) {
    if (!OWNED.includes(name)) out.append(name, value)
  }
  return out.toString()
}

export function useFilterParams(): [FilterState, SetFilters] {
  const navigate = useNavigate()
  const location = useLocation()

  /* The live URL, as far as this hook knows. Assigned during render so it tracks navigations from
     anywhere, and again inside the setter so two writes in one tick compose. An effect would be too
     late: it runs after paint, and the second setter call in a handler needs the first one's result
     immediately. */
  const live = useRef({ search: location.search, hash: location.hash })
  live.current = { search: location.search, hash: location.hash }

  /* Memoized on the search string so the object identity is stable across unrelated re-renders.
     `useAssets` keys its fetch off this value; a fresh object every render would refetch forever. */
  const filters = useMemo(
    () => searchParamsToFilters(new URLSearchParams(location.search)),
    [location.search],
  )

  const setFilters = useCallback<SetFilters>(next => {
    const { search, hash } = live.current
    const value = typeof next === 'function'
      ? next(searchParamsToFilters(new URLSearchParams(search)))
      : next
    const nextSearch = writeFilters(search, value)

    live.current = { search: nextSearch ? `?${nextSearch}` : '', hash }
    // Pathname omitted on purpose: the router resolves a partial path against the current location,
    // so this works unchanged on `/:slug` and on `/:slug/a/:assetId`.
    navigate({ search: nextSearch, hash }, { replace: true })
  }, [navigate])

  return [filters, setFilters]
}
