import { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

export interface LightboxItem {
  src: string
  alt?: string
  title?: string
}

/** Full-viewport lightbox for gallery images (lightGallery-style). */
export function ImageLightbox({
  items,
  index,
  onClose,
  onIndexChange,
}: {
  items: LightboxItem[]
  index: number
  onClose: () => void
  onIndexChange: (i: number) => void
}) {
  const safeIndex = ((index % items.length) + items.length) % items.length
  const current = items[safeIndex]

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
      <div className="flex items-center justify-between px-4 py-3 shrink-0">
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

      <div
        className="flex-1 relative flex items-center justify-center min-h-0 px-12 pb-6"
        onClick={e => e.stopPropagation()}
      >
        {items.length > 1 && (
          <button
            type="button"
            onClick={() => go(-1)}
            className="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-sm border border-white/25 text-clear-white text-xl hover:bg-white/10"
            aria-label="Previous"
          >
            ←
          </button>
        )}
        <img
          referrerPolicy="no-referrer"
          src={current.src}
          alt={current.alt ?? ''}
          className="max-w-full max-h-full object-contain select-none"
          draggable={false}
        />
        {items.length > 1 && (
          <button
            type="button"
            onClick={() => go(1)}
            className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-sm border border-white/25 text-clear-white text-xl hover:bg-white/10"
            aria-label="Next"
          >
            →
          </button>
        )}
      </div>
    </div>,
    document.body,
  )
}
