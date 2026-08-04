/* Client logo: preview + upload field.
 *
 * The size cap and accept list are enforced here AND server-side; this copy exists to fail fast
 * with a useful message rather than after an upload.
 */

import { useState, useRef, useEffect } from 'react'
import {} from '@sotto/asset-library'

const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml,image/gif'
const LOGO_MAX_BYTES = 2 * 1024 * 1024

export function LogoPreview({ src, initials, accent, size = 64 }: {
  src?: string | null
  initials: string
  accent: string
  size?: number
}) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        className="rounded-[28%_38%] object-cover border border-border shrink-0"
        style={{ width: size, height: size }}
        onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
      />
    )
  }
  return (
    <div
      className="rounded-[28%_38%] flex items-center justify-center text-sm font-bold font-sans text-clear-white shrink-0 border border-border"
      style={{ width: size, height: size, backgroundColor: accent || '#161616' }}
    >
      {initials || '?'}
    </div>
  )
}

/** Logo picker — preview + Change opens drag/drop modal. Uploads to CDN on save (no URL paste). */
export function LogoField({
  currentUrl,
  pendingFile,
  onPick,
  onClearPending,
  initials,
  accent,
}: {
  currentUrl: string
  pendingFile: File | null
  onPick: (file: File) => void
  onClearPending: () => void
  initials: string
  accent: string
}) {
  const [open, setOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [localError, setLocalError] = useState('')
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!pendingFile) {
      setObjectUrl(null)
      return
    }
    const url = URL.createObjectURL(pendingFile)
    setObjectUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [pendingFile])

  const previewUrl = objectUrl ?? (currentUrl || null)

  function acceptFile(file: File | undefined | null) {
    setLocalError('')
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setLocalError('Choose an image file (PNG, JPG, WebP, SVG).')
      return
    }
    if (file.size > LOGO_MAX_BYTES) {
      setLocalError('Logo must be under 2 MB.')
      return
    }
    onPick(file)
    setOpen(false)
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    acceptFile(e.dataTransfer.files?.[0])
  }

  return (
    <div>
      <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">Logo</label>
      <div className="flex items-center gap-4 p-3 bg-surface-sunken rounded-sm border border-border">
        <LogoPreview
          src={previewUrl}
          initials={initials}
          accent={accent}
          size={64}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-sans text-cosmos-black">
            {pendingFile ? pendingFile.name : currentUrl ? 'On CDN' : 'No logo yet'}
          </p>
          <p className="text-[11px] font-sans text-text-muted mt-0.5">
            {pendingFile
              ? 'Will upload to CDN when you save.'
              : 'Displayed on the portal welcome and admin cards.'}
          </p>
          <div className="flex flex-wrap gap-2 mt-2">
            <button
              type="button"
              onClick={() => { setLocalError(''); setOpen(true) }}
              className="px-3 py-1.5 text-[11px] font-sans font-semibold border border-cosmos-black rounded-sm hover:bg-cosmos-black hover:text-clear-white transition-colors"
            >
              {currentUrl || pendingFile ? 'Change logo' : 'Add logo'}
            </button>
            {pendingFile && (
              <button
                type="button"
                onClick={onClearPending}
                className="px-3 py-1.5 text-[11px] font-sans text-text-muted hover:text-cosmos-black transition-colors"
              >
                Undo selection
              </button>
            )}
          </div>
        </div>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center px-4"
          style={{ backdropFilter: 'blur(4px)', backgroundColor: 'rgba(22,22,22,0.45)' }}
          onClick={e => { if (e.target === e.currentTarget) setOpen(false) }}
        >
          <div
            className="w-full max-w-md bg-bg border border-cosmos-black rounded-sm overflow-hidden"
            style={{ boxShadow: '6px 6px 0 #161616' }}
          >
            <div className="px-5 pt-5 pb-3 border-b border-border flex items-center justify-between">
              <h3 className="font-serif text-lg font-medium text-cosmos-black">Upload logo</h3>
              <button type="button" onClick={() => setOpen(false)} className="text-text-muted hover:text-cosmos-black text-xl leading-none">×</button>
            </div>
            <div className="p-5 space-y-4">
              <div
                onDragEnter={e => { e.preventDefault(); setDragging(true) }}
                onDragOver={e => { e.preventDefault(); setDragging(true) }}
                onDragLeave={e => { e.preventDefault(); setDragging(false) }}
                onDrop={onDrop}
                className={`flex flex-col items-center justify-center gap-3 px-4 py-10 border-2 border-dashed rounded-sm transition-colors ${
                  dragging ? 'border-cosmos-black bg-surface-sunken' : 'border-border bg-bg'
                }`}
              >
                <LogoPreview src={null} initials={initials || 'LG'} accent={accent} size={48} />
                <p className="text-sm font-sans text-cosmos-black text-center">
                  Drag & drop an image here
                </p>
                <p className="text-[11px] font-sans text-text-muted">PNG, JPG, WebP, or SVG · max 2 MB</p>
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="mt-1 px-4 py-2 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm hover:bg-ink-800 transition-colors"
                  style={{ boxShadow: '4px 4px 0 #161616' }}
                >
                  Browse files
                </button>
                <input
                  ref={inputRef}
                  type="file"
                  accept={LOGO_ACCEPT}
                  className="hidden"
                  onChange={e => acceptFile(e.target.files?.[0])}
                />
              </div>
              {localError && <p className="text-[11px] font-sans text-signal-error">{localError}</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Client drawer ─────────────────────────────────────────────

