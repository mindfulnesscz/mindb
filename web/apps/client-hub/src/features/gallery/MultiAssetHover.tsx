import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { Asset } from '@dc-hub/asset-library'
import { fetchChildAssets, fetchVariants } from '../../services/assetService'

export interface SiblingPreview {
  id: string
  name: string
  thumbnailUrl?: string
}

const MAX_TILES = 6

/** Primary + children + variants for hover preview (deduped). */
export async function fetchSiblingPreviews(primary: Asset): Promise<SiblingPreview[]> {
  const [children, variants] = await Promise.all([
    fetchChildAssets(primary.id).catch(() => [] as Asset[]),
    fetchVariants(primary.id).catch(() => [] as Asset[]),
  ])
  const seen = new Set<string>([primary.id])
  const list: SiblingPreview[] = [{
    id: primary.id,
    name: primary.name,
    thumbnailUrl: primary.thumbnailUrl,
  }]
  for (const a of [...children, ...variants]) {
    if (seen.has(a.id)) continue
    seen.add(a.id)
    list.push({ id: a.id, name: a.name, thumbnailUrl: a.thumbnailUrl })
  }
  return list
}

function gridCols(n: number): string {
  if (n <= 1) return 'grid-cols-1'
  if (n === 2) return 'grid-cols-2'
  if (n <= 4) return 'grid-cols-2'
  return 'grid-cols-3'
}

const springIn = { type: 'spring' as const, stiffness: 380, damping: 26, mass: 0.65 }
const springHover = { type: 'spring' as const, stiffness: 460, damping: 24, mass: 0.55 }

/**
 * Hover overlay: sibling thumbnails fan into a grid and scale toward the viewer
 * with staggered springs + depth shadows. Individual tiles enlarge on their own hover.
 */
export function MultiAssetHoverGrid({
  open,
  siblings,
  loading,
}: {
  open: boolean
  siblings: SiblingPreview[]
  loading: boolean
}) {
  const reduceMotion = useReducedMotion()
  const overflow = Math.max(0, siblings.length - MAX_TILES)
  const visible = siblings.slice(0, MAX_TILES)
  const n = visible.length
  const cols = gridCols(Math.max(n, 1))

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-10 flex items-center justify-center p-2.5"
          style={{
            background:
              'radial-gradient(ellipse at center, rgba(22,22,22,0.35) 0%, rgba(22,22,22,0.72) 100%)',
            perspective: 900,
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
          transition={{ duration: reduceMotion ? 0.01 : 0.22 }}
        >
          {loading && n <= 1 ? (
            <motion.div
              className="text-[11px] font-sans text-clear-white/85 tracking-wide"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              Loading files…
            </motion.div>
          ) : (
            <motion.div
              className={`grid ${cols} gap-2 w-full max-w-full`}
              style={{ transformStyle: 'preserve-3d' }}
              initial="hidden"
              animate="show"
              exit="hidden"
              variants={{
                hidden: {
                  transition: {
                    staggerChildren: reduceMotion ? 0 : 0.03,
                    staggerDirection: -1,
                  },
                },
                show: {
                  transition: {
                    staggerChildren: reduceMotion ? 0 : 0.05,
                    delayChildren: reduceMotion ? 0 : 0.05,
                  },
                },
              }}
            >
              {visible.map((s, i) => {
                const isLastOverflow = overflow > 0 && i === visible.length - 1
                return (
                  <motion.div
                    key={s.id}
                    className="relative aspect-video rounded-[3px] overflow-hidden bg-gray-150 origin-center cursor-pointer ring-1 ring-white/15"
                    variants={{
                      hidden: reduceMotion
                        ? { opacity: 0 }
                        : {
                            opacity: 0,
                            scale: 0.42,
                            y: 18,
                            rotateX: 12,
                            filter: 'brightness(0.55)',
                          },
                      show: {
                        opacity: 1,
                        scale: 1,
                        y: 0,
                        rotateX: 0,
                        filter: 'brightness(1)',
                        transition: springIn,
                      },
                    }}
                    whileHover={
                      reduceMotion
                        ? undefined
                        : {
                            scale: 1.14,
                            y: -4,
                            zIndex: 3,
                            boxShadow:
                              '0 22px 48px rgba(0,0,0,0.5), 0 8px 16px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.2)',
                            transition: springHover,
                          }
                    }
                    style={{
                      boxShadow: '0 8px 20px rgba(0,0,0,0.32), 0 2px 6px rgba(0,0,0,0.2)',
                      transformStyle: 'preserve-3d',
                    }}
                    title={s.name}
                  >
                    {s.thumbnailUrl ? (
                      <img
                        referrerPolicy="no-referrer"
                        src={s.thumbnailUrl}
                        alt={s.name}
                        className="w-full h-full object-cover pointer-events-none"
                        draggable={false}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[10px] font-sans text-text-muted bg-gray-150">
                        {i + 1}
                      </div>
                    )}
                    {isLastOverflow && (
                      <div className="absolute inset-0 flex items-center justify-center bg-cosmos-black/55">
                        <span className="text-sm font-sans font-semibold text-clear-white">
                          +{overflow}
                        </span>
                      </div>
                    )}
                  </motion.div>
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
    { id: primary.id, name: primary.name, thumbnailUrl: primary.thumbnailUrl },
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
