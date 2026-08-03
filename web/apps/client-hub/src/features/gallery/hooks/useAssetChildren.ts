/* Children, variants, and which one is focused — deliberately ONE hook.
 *
 * These six pieces of state are set together by a single effect and cannot be separated without
 * making the coupling implicit: opening the detail from a hover tile has to pick the child, switch
 * to carousel view, set the carousel index, choose the variant, and possibly open the lightbox —
 * all from one decision about `focusAssetId`. Splitting that into six hooks would replace one
 * readable effect with six that must fire in the right order.
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
 */

import { useCallback, useEffect, useState } from 'react'
import type { Asset } from '@dc-hub/asset-library'
import { fetchChildAssets, fetchVariants, deleteAssetAndMedia } from '../../../services/assetService'

export function useAssetChildren(
  asset: Asset,
  isStaff: boolean,
  focusAssetId?: string,
  autoOpenLightbox?: boolean,
) {
  const [children, setChildren] = useState<Asset[]>([])
  const [variants, setVariants] = useState<Asset[]>([])
  const [staleChildren, setStaleChildren] = useState<Asset[]>([])
  const [staleVariants, setStaleVariants] = useState<Asset[]>([])
  const [childView, setChildView] = useState<'grid' | 'carousel'>('grid')
  const [carouselIdx, setCarouselIdx] = useState(0)
  const [selectedVariantId, setSelectedVariantId] = useState<string>(asset.id)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

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
        const kids = allKids.filter(a => !isStale(a))
        const vars = allVars.filter(a => !isStale(a))
        setChildren(kids)
        setVariants(vars)
        setStaleChildren(allKids.filter(isStale))
        setStaleVariants(allVars.filter(isStale))
        if (focusAssetId) {
          const childIdx = kids.findIndex(c => c.id === focusAssetId)
          if (childIdx >= 0) {
            setChildView('carousel')
            setCarouselIdx(childIdx)
            setSelectedVariantId(asset.id)
            if (autoOpenLightbox) {
              const withSrc = kids.filter(c => c.thumbnailUrl || c.downloadUrl)
              const lbIdx = withSrc.findIndex(c => c.id === focusAssetId)
              if (lbIdx >= 0) setLightboxIndex(lbIdx)
            }
            return
          }
          if (vars.some(v => v.id === focusAssetId) || focusAssetId === asset.id) {
            setSelectedVariantId(focusAssetId)
          }
        }
        if (autoOpenLightbox && kids.length === 0) {
          // Single / variant focus — open lightbox on the selected asset when it has media
          if (asset.thumbnailUrl || asset.downloadUrl) setLightboxIndex(0)
        }
      })
    } else {
      setChildren([])
      setVariants([])
      setStaleChildren([])
      setStaleVariants([])
      if (autoOpenLightbox && (asset.thumbnailUrl || asset.downloadUrl)) {
        setLightboxIndex(0)
      }
    }
    setCarouselIdx(0)
    setSelectedVariantId(focusAssetId && focusAssetId !== asset.id ? focusAssetId : asset.id)

  }, [asset.id, asset.childCount, isStaff, focusAssetId, autoOpenLightbox])

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
    childView, setChildView, carouselIdx, setCarouselIdx,
    selectedVariantId, setSelectedVariantId, lightboxIndex, setLightboxIndex,
  }
}
