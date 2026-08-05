/* Create / edit a client. Owns the form state and the save call. */

import { useState, useEffect } from 'react'
import { Client } from '@dc-hub/asset-library'
import { createClient, updateClient } from '../../services/clientService'
import { uploadClientLogo } from '../../services/brandingService'
import { importTaxonomyJsonFile, parseAndValidateTaxonomyJson } from '../../services/taxonomyImport'
import { TagsAdmin } from './TagsAdmin'
import { DestinationsAdmin } from './DestinationsAdmin'
import {
  getInitials, toSlug, emptyForm, clientToForm, parsePreviewPageLimit,
  MAX_PREVIEW_PAGE_LIMIT, type ClientFormState,
} from './clientForm'
import { LogoField } from './LogoField'
import { DomainInput } from './DomainInput'
import { inputCls } from './styles'

export function ClientDrawer({ editing, onClose, onSaved }: {
  editing: Client | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<ClientFormState>(editing ? clientToForm(editing) : emptyForm())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoUploadError, setLogoUploadError] = useState('')
  const [taxonomyFile, setTaxonomyFile] = useState<File | null>(null)
  const [taxonomyHint, setTaxonomyHint] = useState('')

  useEffect(() => {
    setForm(editing ? clientToForm(editing) : emptyForm())
    setError('')
    setLogoFile(null)
    setLogoUploadError('')
    setTaxonomyFile(null)
    setTaxonomyHint('')
  }, [editing])

  function set<K extends keyof ClientFormState>(key: K, val: ClientFormState[K]) {
    if (key === 'name' && !editing) {
      setForm(f => ({ ...f, name: val as string, initials: getInitials(val as string), slug: toSlug(val as string) }))
    } else {
      setForm(f => ({ ...f, [key]: val }))
    }
  }

  async function onTaxonomyFileChosen(file: File | null) {
    setTaxonomyFile(file)
    setTaxonomyHint('')
    if (!file) return
    const text = await file.text()
    const result = parseAndValidateTaxonomyJson(text)
    if (!result.ok || !result.document) {
      setTaxonomyFile(null)
      setError(result.errors.join('; ') || 'Invalid taxonomy JSON')
      return
    }
    setError('')
    setForm(f => ({
      ...f,
      dimEntity: result.document!.dimension_labels.entity,
      dimAngle: result.document!.dimension_labels.angle,
      dimFormat: result.document!.dimension_labels.format,
    }))
    setTaxonomyHint(
      `Valid — ${result.document.nodes.length} node(s)` +
        (result.document.name ? ` · ${result.document.name}` : ''),
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    if (!form.slug.trim()) {
      setError('Portal URL slug is required so the client can be opened.')
      return
    }
    if (parsePreviewPageLimit(form.previewPageLimit) === null) {
      setError(`Page-preview limit must be a whole number between 0 and ${MAX_PREVIEW_PAGE_LIMIT}.`)
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
        /* Omitted when unparseable so the stored value is left alone rather than reset — the same
           no-opinion rule the pipeline applies to URLs it has no value for. `validate` rejects a
           bad entry before we get here, so this is the belt to that braces. */
        ...(parsePreviewPageLimit(form.previewPageLimit) !== null
          ? { previewPageLimit: parsePreviewPageLimit(form.previewPageLimit)! }
          : {}),
      }
      const saved = editing
        ? await updateClient(editing.id, payload)
        : await createClient(payload)
      if (!editing && taxonomyFile && saved.id) {
        await importTaxonomyJsonFile(saved.id, taxonomyFile, { replaceExisting: false })
      }
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

          {!editing && (
            <div>
              <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
                Taxonomy JSON (optional)
              </label>
              <input
                type="file"
                accept="application/json,.json"
                onChange={e => void onTaxonomyFileChosen(e.target.files?.[0] ?? null)}
                className="text-sm font-sans w-full"
              />
              <p className="text-[11px] font-sans text-text-subtle mt-1">
                Import labels + tag tree on create.{' '}
                <a href="/taxonomy.sample.json" download className="underline hover:text-cosmos-black">
                  Download sample
                </a>
              </p>
              {taxonomyHint && (
                <p className="text-[11px] font-sans text-cosmos-black mt-1">{taxonomyHint}</p>
              )}
              {taxonomyFile && (
                <button
                  type="button"
                  onClick={() => { setTaxonomyFile(null); setTaxonomyHint('') }}
                  className="text-[11px] font-sans text-text-muted hover:text-cosmos-black mt-1"
                >
                  Clear file
                </button>
              )}
            </div>
          )}

          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">Website</label>
            <input type="url" value={form.website} onChange={e => set('website', e.target.value)} placeholder="https://acme.com" className={`${inputCls} font-mono`} />
          </div>

          <div>
            <label
              htmlFor="preview-page-limit"
              className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5"
            >
              Document page previews
            </label>
            <input
              id="preview-page-limit"
              type="number" min={0} max={MAX_PREVIEW_PAGE_LIMIT} inputMode="numeric"
              value={form.previewPageLimit}
              onChange={e => set('previewPageLimit', e.target.value)}
              className={`${inputCls} font-mono`}
            />
            <p className="mt-1.5 text-[10px] font-sans text-text-muted">
              Pages rendered per PDF, PowerPoint or Word document, so viewers can page through it in
              the portal. Longer documents show this many and then prompt a download. 0 turns page
              previews off. Spreadsheets always show one page.
            </p>
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
            <div className="pt-4 border-t border-border space-y-8">
              <div>
                <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-3">Tags (source of truth)</p>
                <TagsAdmin client={editing} onClientUpdated={onSaved} />
              </div>
              <div>
                <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-3">Export destinations</p>
                <DestinationsAdmin client={editing} />
              </div>
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

