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
 */

import { useEffect, useState } from 'react'
import type { Asset } from '@dc-hub/asset-library'
import { fetchChildAssets, fetchVariants } from '../../../services/assetService'

export function useAssetChildren(
  asset: Asset,
  focusAssetId?: string,
  autoOpenLightbox?: boolean,
) {
  const [children, setChildren] = useState<Asset[]>([])
  const [variants, setVariants] = useState<Asset[]>([])
  const [childView, setChildView] = useState<'grid' | 'carousel'>('grid')
  const [carouselIdx, setCarouselIdx] = useState(0)
  const [selectedVariantId, setSelectedVariantId] = useState<string>(asset.id)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  // Load children (gallery preview images) and variants (format/size siblings)
  useEffect(() => {
    if ((asset.childCount ?? 0) > 0) {
      Promise.all([
        fetchChildAssets(asset.id).catch(() => [] as Asset[]),
        fetchVariants(asset.id).catch(() => [] as Asset[]),
      ]).then(([kids, vars]) => {
        setChildren(kids)
        setVariants(vars)
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
      if (autoOpenLightbox && (asset.thumbnailUrl || asset.downloadUrl)) {
        setLightboxIndex(0)
      }
    }
    setCarouselIdx(0)
    setSelectedVariantId(focusAssetId && focusAssetId !== asset.id ? focusAssetId : asset.id)
     
  }, [asset.id, asset.childCount, focusAssetId, autoOpenLightbox])

  return {
    children, variants, childView, setChildView, carouselIdx, setCarouselIdx,
    selectedVariantId, setSelectedVariantId, lightboxIndex, setLightboxIndex,
  }
}
