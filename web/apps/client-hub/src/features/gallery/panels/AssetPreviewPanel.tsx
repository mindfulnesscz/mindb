/* The preview area: a gallery grid/carousel of children, or the asset's own thumbnail.
 *
 * `children` are gallery preview images and `variants` are format siblings — different things that
 * look similar here. This panel only ever shows children; the variant picker lives below it in the
 * detail. The distinction is written by the desktop sync (see exportPlan.ts), so keeping it visible
 * in the UI layer matters.
 *
 * Downloads are tracked BEFORE the file is handed to the browser, and the count is bumped
 * optimistically, so the number moves even though the event write is fire-and-forget.
 */

import type { Dispatch, SetStateAction } from 'react'
import { canDownload, type Asset, type Role } from '@dc-hub/asset-library'
import type { PortalDestination } from '../../../services/destinationService'
import { ImageLightbox } from '../ImageLightbox'
import { StreamPlayer } from '../StreamPlayer'
import { webAssetActions } from '../../../lib/assetActions'
import { trackEvent } from '../../../services/eventService'

export interface AssetPreviewPanelProps {
  asset: Asset
  selectedAsset: Asset
  children: Asset[]
  childView: 'grid' | 'carousel'
  setChildView: Dispatch<SetStateAction<'grid' | 'carousel'>>
  carouselIdx: number
  setCarouselIdx: Dispatch<SetStateAction<number>>
  lightboxIndex: number | null
  setLightboxIndex: Dispatch<SetStateAction<number | null>>
  role: Role
  userId: string | null
  isStaff: boolean
  accent: string
  bumpDownloads: () => void
  /** Destinations this viewer may see — gates the per-destination download links. */
  visibleDests: PortalDestination[]
}

export function AssetPreviewPanel({
  asset, selectedAsset, children, childView, setChildView, carouselIdx, setCarouselIdx,
  lightboxIndex, setLightboxIndex, role, userId, isStaff, accent, bumpDownloads, visibleDests,
}: AssetPreviewPanelProps) {
  return (
    <>
        {/* Preview: a player for video, else children grid/carousel, else the parent thumbnail.
            Video comes first because a video asset has no children and would otherwise fall through
            to the thumbnail branch — where it would render a still of itself that opens a lightbox
            and cannot be played. */}
        {selectedAsset.streamUid ? (
          <StreamPlayer asset={selectedAsset} accent={accent} />
        ) : children.length > 0 ? (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
                Files · {children.length}
              </p>
              <div className="flex gap-1">
                <button
                  onClick={() => setChildView('grid')}
                  className={`text-[10px] font-sans font-bold uppercase tracking-label px-2 py-1 rounded-chip border transition-colors ${
                    childView === 'grid'
                      ? 'bg-cosmos-black text-clear-white border-cosmos-black'
                      : 'border-border text-text-muted hover:border-cosmos-black'
                  }`}
                >
                  Grid
                </button>
                <button
                  onClick={() => { setChildView('carousel'); setCarouselIdx(0) }}
                  className={`text-[10px] font-sans font-bold uppercase tracking-label px-2 py-1 rounded-chip border transition-colors ${
                    childView === 'carousel'
                      ? 'bg-cosmos-black text-clear-white border-cosmos-black'
                      : 'border-border text-text-muted hover:border-cosmos-black'
                  }`}
                >
                  Slide
                </button>
              </div>
            </div>

            {childView === 'grid' ? (
              <div className="grid grid-cols-2 gap-2">
                {children.map((child, i) => (
                  <button
                    key={child.id}
                    type="button"
                    onClick={() => {
                      const withSrc = children.filter(c => c.thumbnailUrl || c.downloadUrl)
                      const idx = withSrc.findIndex(c => c.id === child.id)
                      if (idx >= 0) setLightboxIndex(idx)
                    }}
                    className="aspect-square rounded-sm overflow-hidden relative text-left cursor-zoom-in hover:ring-1 hover:ring-cosmos-black transition-shadow bg-gray-150"
                  >
                    {child.thumbnailUrl
                      ? <img referrerPolicy="no-referrer" src={child.thumbnailUrl} alt={child.name} className="w-full h-full object-cover" />
                      : <div className="w-full h-full flex items-center justify-center text-text-muted text-xs font-sans">{i + 1}</div>
                    }
                  </button>
                ))}
              </div>
            ) : (
              <div className="relative">
                <button
                  type="button"
                  className="aspect-square w-full rounded-sm overflow-hidden cursor-zoom-in"
                  style={{ backgroundColor: `color-mix(in srgb, ${accent} 10%, #000)` }}
                  onClick={() => {
                    const withSrc = children.filter(c => c.thumbnailUrl || c.downloadUrl)
                    const idx = withSrc.findIndex(c => c.id === children[carouselIdx]?.id)
                    if (idx >= 0) setLightboxIndex(idx)
                  }}
                >
                  {children[carouselIdx]?.thumbnailUrl
                    ? <img referrerPolicy="no-referrer" src={children[carouselIdx].thumbnailUrl} alt={children[carouselIdx].name} className="w-full h-full object-contain" />
                    : <div className="w-full h-full bg-gray-150" />
                  }
                </button>
                <div className="flex items-center justify-between mt-2">
                  <button
                    onClick={() => setCarouselIdx(i => Math.max(0, i - 1))}
                    disabled={carouselIdx === 0}
                    className="text-sm font-sans px-3 py-1 border border-border rounded-sm disabled:opacity-30 hover:border-cosmos-black transition-colors"
                  >
                    ←
                  </button>
                  <span className="text-[11px] font-sans text-text-muted">
                    {carouselIdx + 1} / {children.length}
                  </span>
                  <button
                    onClick={() => setCarouselIdx(i => Math.min(children.length - 1, i + 1))}
                    disabled={carouselIdx === children.length - 1}
                    className="text-sm font-sans px-3 py-1 border border-border rounded-sm disabled:opacity-30 hover:border-cosmos-black transition-colors"
                  >
                    →
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            className="aspect-square w-full rounded-sm overflow-hidden cursor-zoom-in"
            style={{ backgroundColor: `color-mix(in srgb, ${accent} 10%, #000)` }}
            onClick={() => selectedAsset.thumbnailUrl && setLightboxIndex(0)}
          >
            {selectedAsset.thumbnailUrl
              ? <img referrerPolicy="no-referrer" src={selectedAsset.thumbnailUrl} alt={selectedAsset.name} className="w-full h-full object-contain" />
              : <div className="w-full h-full bg-gray-150" />
            }
          </button>
        )}

        {lightboxIndex !== null && (
          <ImageLightbox
            items={(children.length > 0 ? children : [selectedAsset])
              .filter(a => a.thumbnailUrl || a.downloadUrl)
              .map(a => {
                const urls = a.downloadUrls ?? []
                const links = urls.filter(link => {
                  const dest = visibleDests.find(d =>
                    (link.destId && d.id === link.destId) || d.name === link.name,
                  )
                  if (!dest) return isStaff
                  return true
                })
                return {
                  src: a.downloadUrl || a.thumbnailUrl || '',
                  thumbSrc: a.thumbnailUrl,
                  alt: a.name,
                  title: a.name,
                  downloadUrl: canDownload(role, asset) ? a.downloadUrl : undefined,
                  cloudLinks: links.map(l => ({
                    label: l.name || l.provider || 'Cloud',
                    url: l.url,
                  })),
                  assetId: a.id,
                }
              })
              .filter(i => i.src)}
            index={lightboxIndex}
            onClose={() => setLightboxIndex(null)}
            onIndexChange={setLightboxIndex}
            onDownload={item => {
              const pool = children.length > 0 ? children : [selectedAsset]
              const target = pool.find(a => a.id === item.assetId)
                ?? pool.find(a => a.downloadUrl === item.downloadUrl)
                ?? selectedAsset
              trackEvent(target.id, 'download', userId, role).catch(() => {})
              bumpDownloads()
              webAssetActions.download?.(target)
            }}
          />
        )}
    </>
  )
}
