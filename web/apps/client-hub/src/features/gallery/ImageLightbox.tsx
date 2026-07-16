import { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

export interface LightboxCloudLink {
  label: string
  url: string
}

export interface LightboxItem {
  src: string
  alt?: string
  title?: string
  /** CDN original — enables download chip when present. */
  downloadUrl?: string
  /** Role-filtered cloud share links for this slide. */
  cloudLinks?: LightboxCloudLink[]
  /** Asset id for download tracking / lookup. */
  assetId?: string
}

/** Full-viewport lightbox for gallery images (lightGallery-style). */
export function ImageLightbox({
  items,
  index,
  onClose,
  onIndexChange,
  onDownload,
}: {
  items: LightboxItem[]
  index: number
  onClose: () => void
  onIndexChange: (i: number) => void
  onDownload?: (item: LightboxItem) => void
}) {
  const reduceMotion = useReducedMotion()
  const safeIndex = ((index % items.length) + items.length) % items.length
  const current = items[safeIndex]
  const cloud = current?.cloudLinks?.[0]

  const go = useCallback((delta: number) => {
    if (items.length === 0) return
    onIndexChange(((safeIndex + delta) % items.length + items.length) % items.length)
  }, [items.length, onIndexChange, safeIndex])

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') go(1)
      if (e.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [go, onClose])

  if (!current?.src) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-cosmos-black/92"
      role="dialog"
      aria-modal="true"
      aria-label="Image lightbox"
      onClick={onClose}
    >
      <div
        className="flex items-center justify-between px-4 py-3 shrink-0"
        onClick={e => e.stopPropagation()}
      >
        <p className="text-[12px] font-sans text-clear-white/80 truncate max-w-[70%]">
          {current.title || current.alt || ''}
          {items.length > 1 && (
            <span className="text-clear-white/50 ml-2">
              {safeIndex + 1} / {items.length}
            </span>
          )}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="text-clear-white/80 hover:text-clear-white text-lg leading-none px-2"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {/* Void clicks on this region close; only chrome + image stopPropagation */}
      <div className="flex-1 relative flex items-center justify-center min-h-0 px-12 pb-16">
        {items.length > 1 && (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation()
              go(-1)
            }}
            className="absolute left-3 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-sm border border-white/25 text-clear-white text-xl hover:bg-white/10"
            aria-label="Previous"
          >
            ←
          </button>
        )}

        <AnimatePresence mode="wait" initial={false}>
          <motion.img
            key={current.src + String(safeIndex)}
            referrerPolicy="no-referrer"
            src={current.src}
            alt={current.alt ?? ''}
            className="max-w-full max-h-full object-contain select-none"
            draggable={false}
            onClick={e => e.stopPropagation()}
            initial={reduceMotion ? false : { opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0, scale: 0.985 }}
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: 'easeOut' }}
          />
        </AnimatePresence>

        {items.length > 1 && (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation()
              go(1)
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-sm border border-white/25 text-clear-white text-xl hover:bg-white/10"
            aria-label="Next"
          >
            →
          </button>
        )}

        {(current.downloadUrl || cloud) && (
          <div
            className="absolute bottom-4 right-4 z-10 flex items-center gap-2"
            onClick={e => e.stopPropagation()}
          >
            {cloud && (
              <a
                href={cloud.url}
                target="_blank"
                rel="noopener noreferrer"
                title={cloud.label}
                className="h-9 px-3 flex items-center gap-1.5 rounded-sm border border-white/30 bg-cosmos-black/60 text-clear-white text-[11px] font-sans font-semibold hover:bg-white/15 transition-colors"
              >
                ☁ {cloud.label}
              </a>
            )}
            {current.downloadUrl && onDownload && (
              <button
                type="button"
                title="Download"
                onClick={() => onDownload(current)}
                className="h-9 w-9 flex items-center justify-center rounded-sm border border-white/30 bg-cosmos-black/60 text-clear-white text-sm font-bold hover:bg-white/15 transition-colors"
              >
                ↓
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
