import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Client } from '@dc-hub/asset-library'
import { canManageClients } from '@dc-hub/asset-library'
import { useAuth } from '../../context/AuthContext'
import { useClients } from '../../hooks/useClients'
import { createClient, updateClient } from '../../services/clientService'
import { uploadClientLogo } from '../../services/brandingService'
import { TagsAdmin } from './TagsAdmin'
import { fetchAllUsers, updateUserAccess, normalizeRole, type UserProfile } from '../../services/userService'
import { isConfigured } from '../../lib/supabase'

// ── DC logo mark ──────────────────────────────────────────────

function DCMark({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const dim = size === 'lg' ? 'w-16 h-16' : 'w-7 h-7'
  const text = size === 'lg' ? 'text-2xl' : 'text-xs'
  return (
    <div className={`${dim} rounded-[28%_38%] bg-cosmos-black flex items-center justify-center shrink-0`}
      style={size === 'lg' ? { boxShadow: '6px 6px 0 #161616' } : undefined}>
      <span className={`text-clear-white ${text} font-bold font-sans leading-none`}>C</span>
    </div>
  )
}

// ── Domain whitelist tag input ────────────────────────────────

function DomainInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  function add(raw: string) {
    const domain = raw.trim().toLowerCase().replace(/^@/, '')
    if (!domain || value.includes(domain)) { setDraft(''); return }
    onChange([...value, domain])
    setDraft('')
  }

  function remove(domain: string) { onChange(value.filter(d => d !== domain)) }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); add(draft) }
    else if (e.key === 'Backspace' && draft === '' && value.length > 0) onChange(value.slice(0, -1))
  }

  return (
    <div
      className="min-h-[38px] flex flex-wrap gap-1.5 items-center border border-border rounded-sm px-2 py-1.5 bg-bg focus-within:border-cosmos-black transition-colors cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {value.map(d => (
        <span key={d} className="flex items-center gap-1 text-[11px] font-mono bg-gray-100 border border-border rounded-chip px-2 py-0.5">
          {d}
          <button type="button" onClick={e => { e.stopPropagation(); remove(d) }} className="text-text-muted hover:text-cosmos-black leading-none">×</button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => draft.trim() && add(draft)}
        placeholder={value.length === 0 ? 'acme.com, client.io…' : ''}
        className="flex-1 min-w-[120px] text-sm font-mono bg-transparent outline-none placeholder:text-text-subtle"
      />
    </div>
  )
}

// ── Client form helpers ───────────────────────────────────────

function getInitials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('')
}

function toSlug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

interface ClientFormState {
  name: string; slug: string; initials: string; accent: string
  logoUrl: string; website: string; portalBg: string; domainWhitelist: string[]
  dimEntity: string; dimAngle: string; dimFormat: string
}

function emptyForm(): ClientFormState {
  return {
    name: '', slug: '', initials: '', accent: '#161616', logoUrl: '', website: '', portalBg: '',
    domainWhitelist: [], dimEntity: 'Entity', dimAngle: 'Angle', dimFormat: 'Format',
  }
}

function clientToForm(c: Client): ClientFormState {
  return {
    name: c.name, slug: c.slug ?? '', initials: c.initials, accent: c.accent,
    logoUrl: c.logoUrl ?? '', website: c.website ?? '', portalBg: c.portalBg ?? '',
    domainWhitelist: c.domainWhitelist ?? [],
    dimEntity: c.dimensionLabels?.entity ?? 'Entity',
    dimAngle:  c.dimensionLabels?.angle  ?? 'Angle',
    dimFormat: c.dimensionLabels?.format ?? 'Format',
  }
}

const inputCls = 'w-full text-sm font-sans border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors'

const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml,image/gif'
const LOGO_MAX_BYTES = 2 * 1024 * 1024

function LogoPreview({ src, initials, accent, size = 64 }: {
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
function LogoField({
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

function ClientDrawer({ editing, onClose, onSaved }: {
  editing: Client | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<ClientFormState>(editing ? clientToForm(editing) : emptyForm())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoUploadError, setLogoUploadError] = useState('')

  useEffect(() => {
    setForm(editing ? clientToForm(editing) : emptyForm())
    setError('')
    setLogoFile(null)
    setLogoUploadError('')
  }, [editing])

  function set<K extends keyof ClientFormState>(key: K, val: ClientFormState[K]) {
    if (key === 'name' && !editing) {
      setForm(f => ({ ...f, name: val as string, initials: getInitials(val as string), slug: toSlug(val as string) }))
    } else {
      setForm(f => ({ ...f, [key]: val }))
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    if (!form.slug.trim()) {
      setError('Portal URL slug is required so the client can be opened.')
      return
    }
    setSaving(true); setError(''); setLogoUploadError('')
    try {
      const payload = {
        name: form.name.trim(), slug: form.slug.trim(),
        initials: form.initials.trim() || getInitials(form.name), accent: form.accent,
        website: form.website.trim() || undefined,
        portalBg: form.portalBg.trim() || undefined, domainWhitelist: form.domainWhitelist,
        dimensionLabels: { entity: form.dimEntity.trim(), angle: form.dimAngle.trim(), format: form.dimFormat.trim() },
      }
      const saved = editing
        ? await updateClient(editing.id, payload)
        : await createClient(payload)
      if (logoFile && saved.id) {
        try {
          const url = await uploadClientLogo(saved.id, logoFile)
          await updateClient(saved.id, { logoUrl: url })
          setForm(f => ({ ...f, logoUrl: url }))
          setLogoFile(null)
        } catch (logoErr) {
          setLogoUploadError(logoErr instanceof Error ? logoErr.message : String(logoErr))
          setSaving(false)
          return
        }
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-cosmos-black/20 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-full max-w-[420px] bg-bg border-l border-border z-50 flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="font-serif text-lg font-medium text-cosmos-black">
            {editing ? `Edit — ${editing.name}` : 'New client'}
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-cosmos-black transition-colors text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} id="client-form" className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
              Name <span className="text-signal-error">*</span>
            </label>
            <input type="text" value={form.name} onChange={e => set('name', e.target.value)} placeholder="Acme Corp" required className={inputCls} />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">Initials</label>
              <input type="text" value={form.initials} onChange={e => set('initials', e.target.value.toUpperCase().slice(0, 3))} placeholder="AC" maxLength={3} className={`${inputCls} font-mono uppercase`} />
            </div>
            <div>
              <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">Brand colour</label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.accent} onChange={e => set('accent', e.target.value)} className="w-10 h-[38px] rounded-sm border border-border cursor-pointer p-0.5 bg-bg" />
                <input type="text" value={form.accent} onChange={e => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && set('accent', e.target.value)} className="w-24 text-sm font-mono border border-border rounded-sm px-3 py-2 bg-bg focus:outline-none focus:border-cosmos-black transition-colors" />
              </div>
            </div>
          </div>

          <LogoField
            currentUrl={form.logoUrl}
            pendingFile={logoFile}
            onPick={file => { setLogoFile(file); setLogoUploadError('') }}
            onClearPending={() => setLogoFile(null)}
            initials={form.initials || getInitials(form.name)}
            accent={form.accent}
          />
          {logoUploadError && (
            <div className="p-3 border border-signal-error/40 bg-signal-error/5 rounded-sm">
              <p className="text-[11px] font-sans font-semibold text-signal-error mb-1">Logo upload failed</p>
              <p className="text-[11px] font-sans text-signal-error">{logoUploadError}</p>
              <p className="text-[11px] font-sans text-text-muted mt-2">
                Client details were saved. Fix storage secrets on staging, then Change logo and save again.
              </p>
            </div>
          )}

          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">Taxonomy labels (display only)</label>
            <div className="grid grid-cols-3 gap-2">
              <input type="text" value={form.dimEntity} onChange={e => set('dimEntity', e.target.value)} placeholder="Entity" className={inputCls} />
              <input type="text" value={form.dimAngle} onChange={e => set('dimAngle', e.target.value)} placeholder="Angle" className={inputCls} />
              <input type="text" value={form.dimFormat} onChange={e => set('dimFormat', e.target.value)} placeholder="Format" className={inputCls} />
            </div>
            <p className="text-[11px] font-sans text-text-subtle mt-1">Internal keys stay entity/angle/format — these are per-client display names (e.g. WHY / HOW / WHAT).</p>
          </div>

          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">Website</label>
            <input type="url" value={form.website} onChange={e => set('website', e.target.value)} placeholder="https://acme.com" className={`${inputCls} font-mono`} />
          </div>

          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
              Portal URL slug <span className="text-signal-error">*</span>
            </label>
            <div className="flex items-center border border-border rounded-sm overflow-hidden focus-within:border-cosmos-black transition-colors">
              <span className="px-3 py-2 text-sm font-sans text-text-muted bg-surface-sunken border-r border-border whitespace-nowrap">/</span>
              <input type="text" value={form.slug} onChange={e => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="acme-corp" required className="flex-1 px-3 py-2 text-sm font-mono bg-bg placeholder:text-text-subtle focus:outline-none" />
            </div>
            <p className="text-[11px] font-sans text-text-subtle mt-1">Required — share this URL with clients for their branded sign-in page.</p>
          </div>

          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">Portal background</label>
            <input type="text" value={form.portalBg} onChange={e => set('portalBg', e.target.value)} placeholder="#f5f0eb  or  https://…/hero.jpg" className={`${inputCls} font-mono`} />
            <p className="text-[11px] font-sans text-text-subtle mt-1">CSS colour or image URL on the portal welcome screen.</p>
          </div>

          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">Domain whitelist</label>
            <DomainInput value={form.domainWhitelist} onChange={v => set('domainWhitelist', v)} />
            <p className="text-[11px] font-sans text-text-subtle mt-1">Users with matching email domains are auto-assigned to this client. Press Enter or comma to add.</p>
          </div>

          {editing && (
            <div className="pt-4 border-t border-border">
              <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-3">Tags (source of truth)</p>
              <TagsAdmin client={editing} />
            </div>
          )}

          {error && <p className="text-[11px] font-sans text-signal-error">{error}</p>}
        </form>

        <div className="flex items-center justify-between px-6 py-4 border-t border-border shrink-0">
          <button type="button" onClick={onClose} className="text-sm font-sans text-text-muted hover:text-cosmos-black transition-colors">Cancel</button>
          <button
            form="client-form"
            type="submit"
            disabled={saving || !form.name.trim()}
            className="px-4 py-2 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-40 hover:bg-ink-800 transition-colors"
            style={form.name.trim() ? { boxShadow: '4px 4px 0 #161616' } : undefined}
          >
            {saving ? (logoFile ? 'Uploading logo…' : 'Saving…') : editing ? 'Save changes' : 'Create client'}
          </button>
        </div>
      </div>
    </>
  )
}

// ── Admin client card ─────────────────────────────────────────

function AdminClientCard({ client, onNavigate, onEdit, canEdit }: {
  client: Client
  onNavigate: () => void
  onEdit: () => void
  canEdit: boolean
}) {
  return (
    <div
      className="relative group p-5 bg-surface border border-border hover:border-cosmos-black rounded-sm transition-colors cursor-pointer"
      onClick={onNavigate}
    >
      {canEdit && (
      <button
        onClick={e => { e.stopPropagation(); onEdit() }}
        className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 text-[11px] font-sans text-text-muted hover:text-cosmos-black transition-all px-2 py-1 rounded-chip border border-transparent hover:border-border"
      >
        Edit
      </button>
      )}

      {client.logoUrl ? (
        <img src={client.logoUrl} alt={client.name} className="w-10 h-10 rounded-[28%_38%] object-cover mb-3" />
      ) : (
        <div className="w-10 h-10 rounded-[28%_38%] flex items-center justify-center mb-3 text-sm font-bold font-sans text-clear-white" style={{ backgroundColor: client.accent }}>
          {client.initials}
        </div>
      )}

      <h3 className="font-sans text-base font-semibold text-cosmos-black mb-0.5">{client.name}</h3>

      {client.slug && (
        <p className="text-[11px] font-mono text-text-muted mb-0.5">/{client.slug}</p>
      )}
      {client.website && (
        <p className="text-[11px] font-sans text-text-subtle truncate">{client.website.replace(/^https?:\/\//, '')}</p>
      )}
      {client.domainWhitelist && client.domainWhitelist.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {client.domainWhitelist.slice(0, 3).map(d => (
            <span key={d} className="text-[10px] font-mono bg-gray-100 border border-border rounded-chip px-1.5 py-0.5">@{d}</span>
          ))}
          {client.domainWhitelist.length > 3 && (
            <span className="text-[10px] font-sans text-text-muted px-1 py-0.5">+{client.domainWhitelist.length - 3}</span>
          )}
        </div>
      )}

      <div className="mt-4 flex items-center gap-1 text-[11px] font-sans text-text-muted group-hover:text-cosmos-black transition-colors">
        <span>Open portal</span>
        <span>→</span>
      </div>
    </div>
  )
}

// ── Admin sign-in (full page, DC branded) ────────────────────

type SignInStep = 'email' | 'checking' | 'error' | 'sending' | 'sent'

function AdminSignIn() {
  const { checkEmail, sendMagicLink } = useAuth()
  const [step, setStep] = useState<SignInStep>('email')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  // Detect auth errors Supabase puts in the URL hash (e.g. expired link)
  useEffect(() => {
    const hash = window.location.hash
    if (!hash.includes('error=')) return
    const params = new URLSearchParams(hash.slice(1))
    const desc = params.get('error_description')
    if (desc) setError(desc.replace(/\+/g, ' ') + ' — please try again.')
    window.history.replaceState(null, '', window.location.pathname)
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = email.trim().toLowerCase()
    if (!trimmed) return
    setError(''); setStep('checking')

    const type = await checkEmail(trimmed)
    if (type !== 'staff') {
      setError('This area is restricted to DC Hub administrators.')
      setStep('error')
      return
    }

    setStep('sending')
    const err = await sendMagicLink(trimmed, undefined, window.location.origin)
    if (err) { setError(err); setStep('email') }
    else setStep('sent')
  }

  const busy = step === 'checking' || step === 'sending'

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-bg px-4">
      <div className="mb-10 text-center">
        <div className="flex justify-center mb-4">
          <DCMark size="lg" />
        </div>
        <h1 className="font-serif text-3xl font-medium text-cosmos-black mb-1">DC Hub</h1>
        <p className="font-sans text-sm text-text-muted">Admin access only</p>
      </div>

      <div className="w-full max-w-sm">
        {step === 'sent' ? (
          <div className="border border-cosmos-black rounded-sm p-6" style={{ boxShadow: '4px 4px 0 #161616' }}>
            <p className="font-serif text-lg font-medium text-cosmos-black mb-2">Check your email</p>
            <p className="font-sans text-sm text-text-muted mb-1">
              We sent a magic link to <span className="font-mono text-cosmos-black">{email}</span>
            </p>
            <p className="text-[11px] font-sans text-text-subtle mb-4">Click the link to sign in. It expires in 1 hour.</p>
            <button
              onClick={() => { setStep('email'); setEmail(''); setError('') }}
              className="text-[11px] font-sans text-text-muted hover:text-cosmos-black underline transition-colors"
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              ref={inputRef}
              type="email"
              value={email}
              onChange={e => { setEmail(e.target.value); if (step === 'error') { setStep('email'); setError('') } }}
              placeholder="admin@disruptcollective.com"
              required
              disabled={busy}
              className="w-full text-sm font-sans border border-cosmos-black rounded-sm px-4 py-3 bg-bg placeholder:text-text-subtle focus:outline-none transition-colors"
            />
            {error && <p className="text-[11px] font-sans text-signal-error">{error}</p>}
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="w-full py-3 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-50 hover:bg-ink-800 transition-colors"
              style={{ boxShadow: '4px 4px 0 #161616' }}
            >
              {busy ? 'Checking…' : 'Continue'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

// ── Users view ────────────────────────────────────────────────

const ROLE_OPTIONS = ['public', 'member', 'editor', 'admin'] as const
const ROLE_LABELS: Record<string, string> = {
  public: 'Public', member: 'Member', editor: 'Editor', admin: 'Admin',
}

function UsersView({ isAdmin }: { isAdmin: boolean }) {
  const { profile: self } = useAuth()
  const { clients } = useClients()
  const [users, setUsers] = useState<UserProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [draftClient, setDraftClient] = useState<Record<string, string>>({})
  const [draftMembers, setDraftMembers] = useState<Record<string, string[]>>({})

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const list = await fetchAllUsers()
      setUsers(list)
      const clientDraft: Record<string, string> = {}
      const memberDraft: Record<string, string[]> = {}
      for (const u of list) {
        if (u.clientId) clientDraft[u.id] = u.clientId
        if (u.memberClientIds?.length) memberDraft[u.id] = u.memberClientIds
      }
      setDraftClient(clientDraft)
      setDraftMembers(memberDraft)
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function saveAccess(user: UserProfile) {
    const role = user.role
    setSaving(user.id)
    try {
      await updateUserAccess({
        userId: user.id,
        role,
        clientId: role === 'member' ? (draftClient[user.id] ?? null) : null,
        memberClientIds: role === 'editor' ? (draftMembers[user.id] ?? []) : undefined,
      })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(null)
    }
  }

  async function handleRoleChange(userId: string, role: string) {
    setUsers(u => u.map(p => p.id === userId ? { ...p, role } : p))
    const user = users.find(u => u.id === userId)
    if (!user) return
    await saveAccess({ ...user, role })
  }

  if (loading) return (
    <div className="space-y-2">
      {[1,2,3].map(i => <div key={i} className="h-14 bg-surface-sunken border border-border rounded-sm animate-pulse" />)}
    </div>
  )

  if (error) return <p className="text-sm font-sans text-signal-error">{error}</p>

  return (
    <div className="rounded-sm border border-border overflow-hidden">
      <table className="w-full text-sm font-sans">
        <thead>
          <tr className="border-b border-border bg-surface-sunken">
            <th className="text-left text-[10px] font-bold uppercase tracking-label text-text-muted px-4 py-3">User</th>
            <th className="text-left text-[10px] font-bold uppercase tracking-label text-text-muted px-4 py-3">Email</th>
            <th className="text-left text-[10px] font-bold uppercase tracking-label text-text-muted px-4 py-3">Access</th>
            <th className="text-left text-[10px] font-bold uppercase tracking-label text-text-muted px-4 py-3">Role</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u, i) => (
            <tr key={u.id} className={`border-b border-border last:border-0 ${i % 2 === 0 ? 'bg-bg' : 'bg-surface-sunken/30'}`}>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center shrink-0">
                    <span className="text-clear-white text-[10px] font-bold font-sans leading-none">{u.initials}</span>
                  </div>
                  <span className="text-cosmos-black font-medium">{u.name}</span>
                </div>
              </td>
              <td className="px-4 py-3 font-mono text-text-muted text-[11px]">{u.email}</td>
              <td className="px-4 py-3 text-text-muted min-w-[180px]">
                {isAdmin && u.id !== self?.id && u.role === 'member' ? (
                  <select
                    value={draftClient[u.id] ?? u.clientId ?? ''}
                    disabled={saving === u.id}
                    onChange={e => {
                      const clientId = e.target.value
                      setDraftClient(prev => ({ ...prev, [u.id]: clientId }))
                      void saveAccess({ ...u, role: 'member', clientId: clientId || null })
                    }}
                    className="text-sm font-sans border border-border rounded-sm px-2 py-1 bg-bg w-full"
                  >
                    <option value="">Select client…</option>
                    {clients.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                ) : isAdmin && u.id !== self?.id && u.role === 'editor' ? (
                  <div className="flex flex-wrap gap-1">
                    {clients.map(c => {
                      const checked = (draftMembers[u.id] ?? u.memberClientIds ?? []).includes(c.id)
                      return (
                        <label key={c.id} className="flex items-center gap-1 text-[11px] cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={saving === u.id}
                            onChange={() => {
                              const cur = draftMembers[u.id] ?? u.memberClientIds ?? []
                              const ids = cur.includes(c.id) ? cur.filter(id => id !== c.id) : [...cur, c.id]
                              setDraftMembers(prev => ({ ...prev, [u.id]: ids }))
                              void saveAccess({ ...u, role: 'editor', memberClientIds: ids })
                            }}
                          />
                          {c.name}
                        </label>
                      )
                    })}
                  </div>
                ) : (
                  <span>{u.clientName ?? (u.memberClientIds?.length ? `${u.memberClientIds.length} client(s)` : '—')}</span>
                )}
              </td>
              <td className="px-4 py-3">
                {isAdmin && u.id !== self?.id ? (
                  <select
                    value={u.role}
                    disabled={saving === u.id}
                    onChange={e => handleRoleChange(u.id, e.target.value)}
                    className="text-sm font-sans border border-border rounded-sm px-2 py-1 bg-bg focus:outline-none focus:border-cosmos-black transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    {ROLE_OPTIONS.map(r => (
                      <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                    ))}
                  </select>
                ) : (
                  <span className="text-[11px] font-mono px-2 py-1 bg-surface-sunken border border-border rounded-chip">
                    {ROLE_LABELS[u.role] ?? u.role}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Admin dashboard ───────────────────────────────────────────

function AdminDashboard({ isAdmin }: { isAdmin: boolean }) {
  const { profile, signOut } = useAuth()
  const navigate = useNavigate()
  const { clients, loading, error, usingMock, reload } = useClients()
  const [tab, setTab] = useState<'clients' | 'users'>('clients')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingClient, setEditingClient] = useState<Client | null>(null)
  const role = normalizeRole(profile?.role ?? 'public')
  const manageClients = canManageClients(role)

  function openCreate() { setEditingClient(null); setDrawerOpen(true) }
  function openEdit(client: Client) { setEditingClient(client); setDrawerOpen(true) }
  function closeDrawer() { setDrawerOpen(false); setEditingClient(null) }
  function handleSaved() { reload(); closeDrawer() }

  const tabCls = (t: typeof tab) =>
    `px-4 py-2 text-sm font-sans font-medium transition-colors border-b-2 ${
      tab === t
        ? 'border-cosmos-black text-cosmos-black'
        : 'border-transparent text-text-muted hover:text-cosmos-black'
    }`

  return (
    <div className="min-h-screen flex flex-col bg-bg">
      <header className="flex items-center gap-4 px-6 py-4 border-b border-border bg-surface shrink-0">
        <div className="flex items-center gap-2">
          <DCMark />
          <span className="font-sans text-sm font-bold tracking-[0.14em] uppercase text-cosmos-black">DC HUB</span>
        </div>
        <div className="flex gap-1 ml-4">
          <button className={tabCls('clients')} onClick={() => setTab('clients')}>Clients</button>
          {isAdmin && (
            <button className={tabCls('users')} onClick={() => setTab('users')}>Users</button>
          )}
        </div>
        <div className="flex-1" />
        {profile && (
          <span className="text-sm font-sans text-text-muted">{profile.name}</span>
        )}
        <button onClick={signOut} className="text-sm font-sans text-text-muted hover:text-cosmos-black transition-colors">
          Sign out
        </button>
      </header>

      <main className="flex-1 px-6 py-8 max-w-5xl w-full mx-auto">

        {tab === 'clients' && (
          <>
            <div className="flex items-center justify-between mb-8">
              <h1 className="font-serif text-2xl font-medium text-cosmos-black">Clients</h1>
              {!usingMock && manageClients && (
                <button
                  onClick={openCreate}
                  className="text-sm font-sans font-semibold border-2 border-cosmos-black px-4 py-2 rounded-sm bg-bg text-cosmos-black hover:bg-cosmos-black hover:text-clear-white transition-colors"
                  style={{ boxShadow: '4px 4px 0 #161616' }}
                >
                  + New client
                </button>
              )}
            </div>

            {error && <p className="text-sm font-sans text-signal-error mb-6">{error}</p>}

            {loading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {[1, 2, 3].map(i => (
                  <div key={i} className="h-44 bg-surface-sunken border border-border rounded-sm animate-pulse" />
                ))}
              </div>
            ) : clients.length === 0 ? (
              <div className="py-20 text-center">
                <p className="font-serif text-lg font-medium text-cosmos-black mb-2">No clients yet</p>
                <p className="font-sans text-sm text-text-muted mb-6">Create your first client to get started.</p>
                {!usingMock && manageClients && (
                  <button onClick={openCreate} className="text-sm font-sans font-semibold border-2 border-cosmos-black px-6 py-2.5 rounded-sm hover:bg-cosmos-black hover:text-clear-white transition-colors">
                    + New client
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {clients.map(client => (
                  <AdminClientCard
                    key={client.id}
                    client={client}
                    canEdit={manageClients}
                    onNavigate={() => {
                      if (client.slug) {
                        navigate(`/${client.slug}`)
                        return
                      }
                      // No portal slug → open edit so admins can set one (click used to no-op).
                      if (manageClients) openEdit(client)
                    }}
                    onEdit={() => openEdit(client)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'users' && isAdmin && (
          <>
            <div className="flex items-center justify-between mb-8">
              <h1 className="font-serif text-2xl font-medium text-cosmos-black">Users</h1>
            </div>
            <UsersView isAdmin={isAdmin} />
          </>
        )}
      </main>

      {drawerOpen && (
        <ClientDrawer editing={editingClient} onClose={closeDrawer} onSaved={handleSaved} />
      )}
    </div>
  )
}

// ── Editor router — redirect to sole client if only one exists ─

function EditorRouter() {
  const navigate = useNavigate()
  const { clients, loading } = useClients()

  useEffect(() => {
    if (loading) return
    if (clients.length === 1 && clients[0].slug) {
      navigate(`/${clients[0].slug}`, { replace: true })
    }
  }, [clients, loading])

  // Still loading, or about to redirect — show blank while transitioning
  if (loading || clients.length === 1) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <span className="text-sm font-sans text-text-muted">Loading…</span>
      </div>
    )
  }

  return <AdminDashboard isAdmin={false} />
}

// ── Main page ─────────────────────────────────────────────────

export default function AdminLandingPage() {
  const configured = isConfigured()
  const { session, profile, loading, signOut } = useAuth()

  if (!configured) return <AdminDashboard isAdmin />

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <span className="text-sm font-sans text-text-muted">Loading…</span>
      </div>
    )
  }

  if (!session) return <AdminSignIn />

  if (profile && normalizeRole(profile.role) === 'admin') return <AdminDashboard isAdmin />
  if (profile && normalizeRole(profile.role) === 'editor') return <EditorRouter />

  if (profile) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-bg px-4 text-center">
        <DCMark size="lg" />
        <h1 className="font-serif text-2xl font-medium text-cosmos-black mt-6 mb-2">Staff access only</h1>
        <p className="font-sans text-sm text-text-muted mb-6 max-w-xs">
          Your account doesn't have staff privileges. Use your client portal link to access your workspace.
        </p>
        <button
          onClick={signOut}
          className="px-6 py-2.5 text-sm font-sans font-semibold border-2 border-cosmos-black rounded-sm hover:bg-cosmos-black hover:text-clear-white transition-colors"
        >
          Sign out
        </button>
      </div>
    )
  }

  // session exists but profile still resolving
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <span className="text-sm font-sans text-text-muted">Loading…</span>
    </div>
  )
}
