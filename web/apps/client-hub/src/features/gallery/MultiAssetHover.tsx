import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { Asset } from '@dc-hub/asset-library'
import { fetchChildAssets, fetchVariants } from '../../services/assetService'

export interface SiblingPreview {
  id: string
  name: string
  thumbnailUrl?: string
  downloadUrl?: string
  /** True when this row is a gallery child (image under parent_id), not a format variant. */
  isGalleryChild?: boolean
}

/** Max tiles in the hover mosaic (4×4). Beyond this, last tile shows +N. */
export const MAX_HOVER_TILES = 16

/** Primary + children + variants for hover preview (deduped).
 * Gallery shells without their own thumb are omitted so the mosaic starts with real images. */
export async function fetchSiblingPreviews(primary: Asset): Promise<SiblingPreview[]> {
  const [children, variants] = await Promise.all([
    fetchChildAssets(primary.id).catch(() => [] as Asset[]),
    fetchVariants(primary.id).catch(() => [] as Asset[]),
  ])
  const seen = new Set<string>()
  const list: SiblingPreview[] = []

  const push = (a: Asset, opts?: { isGalleryChild?: boolean; requireThumb?: boolean }) => {
    if (seen.has(a.id)) return
    if (opts?.requireThumb && !a.thumbnailUrl) return
    seen.add(a.id)
    list.push({
      id: a.id,
      name: a.name,
      thumbnailUrl: a.thumbnailUrl,
      downloadUrl: a.downloadUrl,
      isGalleryChild: opts?.isGalleryChild,
    })
  }

  // If this is a gallery parent (has children), mosaic is the images only — skip the shell tile.
  const isGalleryShell = children.length > 0
  if (!isGalleryShell) push(primary)

  for (const a of children) push(a, { isGalleryChild: true })
  for (const a of variants) push(a)

  // Fallback: if somehow empty, show primary anyway
  if (list.length === 0) push(primary)

  return list
}

/** Adaptive mosaic: 2 → 1×2, 3–4 → 2×2, 5–9 → 3×3, 10–16 → 4×4. */
export function gridGeometry(count: number): { cols: number; className: string } {
  const n = Math.max(1, Math.min(count, MAX_HOVER_TILES))
  if (n <= 1) return { cols: 1, className: 'grid-cols-1 max-w-[46%]' }
  if (n === 2) return { cols: 2, className: 'grid-cols-2 max-w-[78%]' }
  if (n <= 4) return { cols: 2, className: 'grid-cols-2' }
  if (n <= 9) return { cols: 3, className: 'grid-cols-3' }
  return { cols: 4, className: 'grid-cols-4' }
}

const springIn = { type: 'spring' as const, stiffness: 380, damping: 26, mass: 0.65 }
const springHover = { type: 'spring' as const, stiffness: 460, damping: 24, mass: 0.55 }

/** Accent used only as contain letterbox — darkened ~50% so artwork stays readable. */
export function thumbLetterbox(accent: string): string {
  return `color-mix(in srgb, ${accent} 50%, #000)`
}

function ShimmerBlock() {
  return (
    <div className="absolute inset-0 overflow-hidden rounded-[2px] bg-black/20">
      <motion.div
        className="absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-white/25 to-transparent"
        initial={{ x: '-120%' }}
        animate={{ x: '220%' }}
        transition={{ duration: 1.1, repeat: Infinity, ease: 'linear' }}
      />
    </div>
  )
}

/**
 * Hover overlay: sibling thumbnails fan into an adaptive square mosaic.
 * Tile click opens that asset; download chip fetches CDN original without opening detail.
 */
export function MultiAssetHoverGrid({
  open,
  siblings,
  loading,
  accent = '#161616',
  onSelect,
}: {
  open: boolean
  siblings: SiblingPreview[]
  loading: boolean
  accent?: string
  onSelect?: (sibling: SiblingPreview) => void
}) {
  const reduceMotion = useReducedMotion()
  const overflow = Math.max(0, siblings.length - MAX_HOVER_TILES)
  const visible = siblings.slice(0, MAX_HOVER_TILES)
  const n = visible.length
  const { className: cols } = gridGeometry(Math.max(n, 1))
  const showShimmer = loading && n <= 1
  const letterbox = thumbLetterbox(accent)

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-10 flex items-center justify-center p-2"
          style={{
            background: 'rgba(22,22,22,0.18)',
            perspective: 900,
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
          transition={{ duration: reduceMotion ? 0.01 : 0.18 }}
          onClick={e => e.stopPropagation()}
        >
          {showShimmer ? (
            <div className={`grid ${cols} gap-1.5 w-full place-items-center`}>
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="relative aspect-square w-full rounded-[2px] overflow-hidden" style={{ backgroundColor: letterbox }}>
                  <ShimmerBlock />
                </div>
              ))}
            </div>
          ) : (
            <motion.div
              className={`grid ${cols} gap-1.5 w-full ${n === 2 ? 'items-center' : ''}`}
              style={{ transformStyle: 'preserve-3d' }}
              initial="hidden"
              animate="show"
              exit="hidden"
              variants={{
                hidden: {
                  transition: {
                    staggerChildren: reduceMotion ? 0 : 0.02,
                    staggerDirection: -1,
                  },
                },
                show: {
                  transition: {
                    staggerChildren: reduceMotion ? 0 : 0.035,
                    delayChildren: reduceMotion ? 0 : 0.04,
                  },
                },
              }}
            >
              {visible.map((s, i) => {
                const isLastOverflow = overflow > 0 && i === visible.length - 1
                return (
                  <motion.button
                    type="button"
                    key={s.id}
                    className="relative aspect-square rounded-[2px] overflow-hidden origin-center cursor-pointer ring-1 ring-black/10 text-left group/tile"
                    style={{
                      backgroundColor: letterbox,
                      boxShadow: '0 6px 16px rgba(0,0,0,0.22)',
                      transformStyle: 'preserve-3d',
                    }}
                    variants={{
                      hidden: reduceMotion
                        ? { opacity: 0 }
                        : {
                            opacity: 0,
                            scale: 0.42,
                            y: 14,
                            rotateX: 10,
                          },
                      show: {
                        opacity: 1,
                        scale: 1,
                        y: 0,
                        rotateX: 0,
                        transition: springIn,
                      },
                    }}
                    whileHover={
                      reduceMotion
                        ? undefined
                        : {
                            scale: 1.08,
                            y: -2,
                            zIndex: 3,
                            boxShadow: '0 14px 28px rgba(0,0,0,0.35)',
                            transition: springHover,
                          }
                    }
                    title={s.name}
                    onClick={e => {
                      e.stopPropagation()
                      onSelect?.(s)
                    }}
                  >
                    {loading && !s.thumbnailUrl ? (
                      <ShimmerBlock />
                    ) : s.thumbnailUrl ? (
                      <img
                        referrerPolicy="no-referrer"
                        src={s.thumbnailUrl}
                        alt={s.name}
                        className="w-full h-full object-cover pointer-events-none"
                        draggable={false}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[10px] font-sans text-clear-white/70">
                        {i + 1}
                      </div>
                    )}

                    {s.isGalleryChild && !isLastOverflow && (
                      <span className="absolute top-1 left-1 z-[1] w-3.5 h-3.5 rounded-[2px] border border-white/50 bg-cosmos-black/35 shadow-[2px_2px_0_rgba(0,0,0,0.25)] pointer-events-none" />
                    )}

                    {isLastOverflow && (
                      <div className="absolute inset-0 flex items-center justify-center bg-cosmos-black/45">
                        <span className="text-sm font-sans font-semibold text-clear-white">
                          +{overflow}
                        </span>
                      </div>
                    )}
                  </motion.button>
                )
              })}
            </motion.div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Prefetch sibling previews when a multi-asset card is hovered (after a short open delay). */
export function useSiblingPreviews(primary: Asset, enabled: boolean) {
  const [siblings, setSiblings] = useState<SiblingPreview[]>([
    { id: primary.id, name: primary.name, thumbnailUrl: primary.thumbnailUrl, downloadUrl: primary.downloadUrl },
  ])
  const [loading, setLoading] = useState(false)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    if (loadedFor === primary.id) return
    let cancelled = false
    setLoading(true)
    fetchSiblingPreviews(primary)
      .then(list => {
        if (!cancelled) {
          setSiblings(list)
          setLoadedFor(primary.id)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [enabled, primary.id, loadedFor])

  return { siblings, loading }
}

/** Debounced hover so quick mouse passes don't flash the overlay. */
export function useDelayedHover(active: boolean, delayMs = 90): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!active) {
      setOpen(false)
      return
    }
    const t = window.setTimeout(() => setOpen(true), delayMs)
    return () => window.clearTimeout(t)
  }, [active, delayMs])
  return open
}
