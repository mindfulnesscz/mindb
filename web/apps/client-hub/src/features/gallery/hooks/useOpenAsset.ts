/* Which asset the drawer is showing, resolved from the URL.
 *
 * This used to be the body of `GalleryView.openAsset` — an async click handler that fetched a
 * sibling, walked up to its parent, and set four pieces of state. It had to move because the same
 * resolution now runs on a COLD LOAD of `/:slug/a/<id>`, where there is no card in hand to start
 * from and no click to hang the work off.
 *
 * The two jobs it does:
 *
 * 1. THE ID IN THE PATH MAY NOT BE A TOP-LEVEL ROW. A gallery child and a format variant are never
 *    cards in the grid, so `/ess/a/<child-id>` has to open the child's PARENT with the child
 *    focused. That tolerance is what makes a link forwarded from someone's lightbox work.
 * 2. THE ID MAY NOT BE IN THE LIST. A link is months old, or points at an asset excluded by the
 *    recipient's own filters. One `fetchAsset` covers it, and the result is cached per path id —
 *    it is a fetch result, not view state, which is why it stays here rather than in the URL.
 *
 * `notFound` covers both "no such row" and "not visible to this viewer", deliberately: RLS returns
 * nothing in either case, and this hook must not try to tell them apart. A client-side check is not
 * a perimeter, and distinguishing the two would leak the existence of an asset the viewer may not
 * see.
 */

import { useEffect, useRef, useState } from 'react'
import type { Asset } from '@sotto/asset-library'
import { fetchAsset } from '../../../services/assetService'
import { reportError } from '../../../lib/reportError'

export interface OpenAsset {
  /** The asset the drawer shows. Always a top-level row — never a child or a variant. */
  asset: Asset | null
  /** Child or variant to focus inside it. */
  focusId?: string
  /** The URL names an asset that is still being resolved. */
  loading: boolean
  /** The URL names an id that does not resolve, or that this viewer may not see. */
  notFound: boolean
}

const NOTHING: OpenAsset = { asset: null, focusId: undefined, loading: false, notFound: false }

/** What one `fetchAsset` round produced, tagged with the path id it was for. */
interface Resolution {
  pathId: string
  asset: Asset | null
  /** Set when `pathId` turned out to be a child or a variant of `asset`. */
  focusId?: string
}

export function useOpenAsset(
  assetId: string | undefined,
  assets: Asset[],
  focusId?: string,
): OpenAsset {
  const inList = assetId ? assets.find(a => a.id === assetId) : undefined
  const [resolution, setResolution] = useState<Resolution | null>(null)

  /* The list, readable from inside the async body without making it an effect dependency. Re-running
     the resolution every time the grid refetches would fire a query per refetch for an asset that is
     already resolved. */
  const listRef = useRef(assets)
  listRef.current = assets

  useEffect(() => {
    // Already a card in the grid, or nothing open: no round-trip needed.
    if (!assetId || inList) return

    let cancelled = false
    void (async () => {
      try {
        const row = await fetchAsset(assetId)
        if (cancelled) return
        if (!row) { setResolution({ pathId: assetId, asset: null }); return }

        const parentId = row.parentId || row.variantOf
        if (!parentId) { setResolution({ pathId: assetId, asset: row }); return }

        const parent = listRef.current.find(a => a.id === parentId) ?? await fetchAsset(parentId)
        if (cancelled) return
        // A child or a variant was named: open the parent, focus what was named.
        setResolution(parent
          ? { pathId: assetId, asset: parent, focusId: assetId }
          : { pathId: assetId, asset: row })
      } catch (err) {
        // fetchAsset returns null for a missing row and for a malformed id; a throw here means the
        // transport failed, or Supabase is not configured at all (demo mode).
        if (cancelled) return
        reportError('asset.GalleryView.resolveOpenAsset', err)
        setResolution({ pathId: assetId, asset: null })
      }
    })()

    return () => { cancelled = true }
    // `inList?.id` rather than `inList`: the object identity changes on every grid refetch.
  }, [assetId, inList?.id])

  if (!assetId) return NOTHING
  if (inList) return { asset: inList, focusId, loading: false, notFound: false }

  if (resolution?.pathId === assetId) {
    return {
      asset: resolution.asset,
      // An explicit `focus` param wins over the id in the path — the path id being a child is the
      // fallback for a link that has no param at all.
      focusId: focusId ?? resolution.focusId,
      loading: false,
      notFound: resolution.asset === null,
    }
  }

  // Between "the URL names an id" and "we know what it is".
  return { asset: null, focusId: undefined, loading: true, notFound: false }
}
