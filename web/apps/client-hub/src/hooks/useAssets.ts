/* The grid's data.
 *
 * Backed by TanStack Query. What that replaced was a `JSON.stringify({filters, role, clientId, rev})`
 * key compared inside an effect, a `hasData` ref to decide whether to show a skeleton, and a `rev`
 * counter to force a refetch. Those three between them were a cache — just one with no sharing, no
 * dedupe, and no memory of anything you had already looked at.
 *
 * THE CACHE KEY IS THE URL. `filterCacheKey(filters)` is the same canonical string the address bar
 * shows, so navigating Back to a view you had open hits warm cache by construction rather than by a
 * second memoization that has to be kept in step with the first.
 *
 * The StrictMode double-mount hazard the old comment here warned about is gone: Query owns dedupe, so
 * two mounts with one key make one request.
 */

import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import type { Asset, FilterState, Role } from '@sotto/asset-library'
import { MOCK_ASSETS, applyFilters, filterCacheKey } from '@sotto/asset-library'
import { fetchAssets } from '../services/assetService'
import { isConfigured } from '../lib/supabase'

interface UseAssetsResult {
  assets: Asset[]
  allAssets: Asset[]
  total: number
  loading: boolean
  error: string | null
  usingMock: boolean
  reload: () => void
}

/** How long a fetched grid is served without a background refetch. */
const ASSETS_STALE_MS = 30_000

const EMPTY: Asset[] = []

export function useAssets(
  filters: FilterState,
  role: Role,
  clientId?: string,
): UseAssetsResult {
  const usingMock = !isConfigured()
  const client = useQueryClient()

  const query = useQuery({
    queryKey: ['assets', clientId, role, filterCacheKey(filters)],
    queryFn: async () => {
      // Demo mode: the same branch as before, moved inside the fetcher so the caching, the dedupe and
      // the return shape are identical whether or not there is a Supabase to talk to.
      if (usingMock) {
        return {
          assets: applyFilters(MOCK_ASSETS, filters, role, clientId),
          allAssets: MOCK_ASSETS,
          total: MOCK_ASSETS.length,
        }
      }
      const { assets, allAssets } = await fetchAssets({ filters, role, clientId })
      return { assets, allAssets, total: assets.length }
    },
    staleTime: ASSETS_STALE_MS,
    /* Keeps the previous grid on screen while a new filter's query is in flight — what the `hasData`
       ref used to do, minus the ref. The skeleton therefore appears on the very first load only. */
    placeholderData: keepPreviousData,
  })

  return {
    assets: query.data?.assets ?? EMPTY,
    allAssets: query.data?.allAssets ?? EMPTY,
    total: query.data?.total ?? 0,
    loading: query.isPending,
    error: query.error ? (query.error as Error).message : null,
    usingMock,
    /**
     * Refetch after a mutation — a status change, or a sweep of disconnected assets.
     *
     * A PREFIX match, deliberately: it invalidates the option-pool query alongside the visible one.
     * Both callers of this are real mutations, and after one of them the pool is genuinely stale —
     * delete an asset and its tags may no longer be in the vocabulary the rail offers. Scoping this
     * to the live key would save one query and leave the rail listing a tag nothing has.
     */
    reload: () => { void client.invalidateQueries({ queryKey: ['assets'] }) },
  }
}
