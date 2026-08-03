/* Children, variants, and which of them is on screen as a grid or a carousel.
 *
 * `children` are gallery preview images (a grid); `variants` are format/size siblings sharing one
 * folder identity (a picker). They are fetched together but mean different things — see
 * exportPlan.ts on the desktop side, which is what writes the distinction.
 *
 * LIVE AND STALE ARE KEPT APART. A sub-asset whose file left the disk is `disconnected`, and mixing
 * those back into `children`/`variants` would put them in the files grid, the carousel, the lightbox
 * and the "Files · N" count — i.e. present a removed image as a deliverable. They come back in
 * `staleChildren`/`staleVariants` instead, for the review section to label and act on, and only for
 * staff, who are the only role that fetches them at all.
 *
 * ── What used to be here, and why it left ─────────────────────────────────────────────────────────
 *
 * This hook also owned `carouselIdx`, `selectedVariantId` and `lightboxIndex`, all set by the same
 * effect that did the fetching — one decision about `focusAssetId` picked the child, switched to
 * carousel view, set the index, chose the variant and possibly opened the lightbox.
 *
 * That coupling is gone because those three are now DERIVED from `focusAssetId` and the lightbox
 * flag, which the portal keeps in the URL. Deriving them is not a style preference: while they were
 * state set by the fetching effect, `focusAssetId` was a dependency of that effect, so every arrow
 * press on the carousel — each of which now rewrites `focus` — would have re-run both queries.
 *
 * `childView` stays, because it is the one value with no URL representation: which way you are
 * looking at a set of files is not worth an entry in a shared link. It gets its own effect, which
 * fetches nothing.
 */

import { useCallback, useEffect, useState } from 'react'
import type { Asset } from '@dc-hub/asset-library'
import { fetchChildAssets, fetchVariants, deleteAssetAndMedia } from '../../../services/assetService'

export function useAssetChildren(asset: Asset, isStaff: boolean, focusAssetId?: string) {
  const [children, setChildren] = useState<Asset[]>([])
  const [variants, setVariants] = useState<Asset[]>([])
  const [staleChildren, setStaleChildren] = useState<Asset[]>([])
  const [staleVariants, setStaleVariants] = useState<Asset[]>([])
  const [childView, setChildView] = useState<'grid' | 'carousel'>('grid')

  // Load children (gallery preview images) and variants (format/size siblings)
  useEffect(() => {
    /* `childCount` counts LIVE sub-assets only, so it is exactly zero for a family whose every
       child or variant has been disconnected — the case that most needs reviewing. Staff therefore
       ask unconditionally; the two extra queries land alongside the five the detail already makes.
       Everyone else keeps the short-circuit, so a plain single asset still costs no round-trips. */
    if ((asset.childCount ?? 0) > 0 || isStaff) {
      const opts = { includeDisconnected: isStaff }
      Promise.all([
        fetchChildAssets(asset.id, opts).catch(() => [] as Asset[]),
        fetchVariants(asset.id, opts).catch(() => [] as Asset[]),
      ]).then(([allKids, allVars]) => {
        const isStale = (a: Asset) => a.status === 'disconnected'
        setChildren(allKids.filter(a => !isStale(a)))
        setVariants(allVars.filter(a => !isStale(a)))
        setStaleChildren(allKids.filter(isStale))
        setStaleVariants(allVars.filter(isStale))
      })
    } else {
      setChildren([])
      setVariants([])
      setStaleChildren([])
      setStaleVariants([])
    }
  }, [asset.id, asset.childCount, isStaff])

  /* A new asset starts in the grid, so one drawer does not inherit the last one's mode. Declared
     BEFORE the promotion below, because effects run in order and this one has to lose the tie on the
     render where both fire. */
  useEffect(() => { setChildView('grid') }, [asset.id])

  /* Opening on a specific gallery child means looking at that one image, so the carousel is the right
     view — the grid would show it as one tile among twenty.
     Only ever PROMOTES. Demoting here would fight the Grid button: `children` gets a new identity on
     every refetch of the parent, so a symmetric effect would silently undo the viewer's choice
     whenever anything else in the drawer reloaded. */
  useEffect(() => {
    if (focusAssetId && children.some(c => c.id === focusAssetId)) setChildView('carousel')
  }, [focusAssetId, children])

  /**
   * Permanently remove a disconnected sub-asset.
   *
   * Pruned from local state rather than refetched: the parent's own row has not changed, so a
   * refetch would re-run five other queries to learn one thing this already knows. `force` is
   * passed through for the "Cloudflare is unreachable, remove the record anyway" case.
   */
  const removeSubAsset = useCallback(async (target: Asset, opts?: { force?: boolean }) => {
    await deleteAssetAndMedia(target, opts)
    setStaleChildren(list => list.filter(a => a.id !== target.id))
    setStaleVariants(list => list.filter(a => a.id !== target.id))
  }, [])

  return {
    children, variants, staleChildren, staleVariants, removeSubAsset,
    childView, setChildView,
  }
}
