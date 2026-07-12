import { useState, useEffect, useRef } from 'react'
import type { Client } from '@dc-hub/asset-library'
import { useClients } from '../../hooks/useClients'
import { useRole } from '../../context/RoleContext'
import { createClient, updateClient } from '../../services/clientService'

// ── Helpers ───────────────────────────────────────────────────

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('')
}

// ── Domain whitelist tag input ─────────────────────────────────

function DomainInput({
  value,
  onChange,
}: {
  value: string[]
  onChange: (v: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  function add(raw: string) {
    const domain = raw.trim().toLowerCase().replace(/^@/, '')
    if (!domain || value.includes(domain)) { setDraft(''); return }
    onChange([...value, domain])
    setDraft('')
  }

  function remove(domain: string) {
    onChange(value.filter(d => d !== domain))
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      e.preventDefault()
      add(draft)
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div
      className="min-h-[38px] flex flex-wrap gap-1.5 items-center border border-border rounded-sm px-2 py-1.5 bg-bg focus-within:border-cosmos-black transition-colors cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {value.map(d => (
        <span
          key={d}
          className="flex items-center gap-1 text-[11px] font-mono bg-gray-100 border border-border rounded-chip px-2 py-0.5"
        >
          {d}
          <button
            type="button"
            onClick={e => { e.stopPropagation(); remove(d) }}
            className="text-text-muted hover:text-cosmos-black leading-none"
          >
            ×
          </button>
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

// ── Client form ────────────────────────────────────────────────

function toSlug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

interface ClientFormState {
  name: string
  slug: string
  initials: string
  accent: string
  logoUrl: string
  website: string
  portalBg: string
  domainWhitelist: string[]
}

function emptyForm(): ClientFormState {
  return { name: '', slug: '', initials: '', accent: '#161616', logoUrl: '', website: '', portalBg: '', domainWhitelist: [] }
}

function clientToForm(c: Client): ClientFormState {
  return {
    name:            c.name,
    slug:            c.slug ?? '',
    initials:        c.initials,
    accent:          c.accent,
    logoUrl:         c.logoUrl ?? '',
    website:         c.website ?? '',
    portalBg:        c.portalBg ?? '',
    domainWhitelist: c.domainWhitelist ?? [],
  }
}

// ── Drawer ─────────────────────────────────────────────────────

function ClientDrawer({
  editing,
  onClose,
  onSaved,
}: {
  editing: Client | null
  onClose: () => void
  onSaved: (client: Client) => void
}) {
  const [form, setForm] = useState<ClientFormState>(editing ? clientToForm(editing) : emptyForm())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setForm(editing ? clientToForm(editing) : emptyForm())
    setError('')
  }, [editing])

  function set<K extends keyof ClientFormState>(key: K, val: ClientFormState[K]) {
    setForm(f => ({ ...f, [key]: val }))
    if (key === 'name' && !editing) {
      setForm(f => ({ ...f, name: val as string, initials: initials(val as string), slug: toSlug(val as string) }))
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true)
    setError('')
    try {
      const payload = {
        name:            form.name.trim(),
        slug:            form.slug.trim() || undefined,
        initials:        form.initials.trim() || initials(form.name),
        accent:          form.accent,
        logoUrl:         form.logoUrl.trim() || undefined,
        website:         form.website.trim() || undefined,
        portalBg:        form.portalBg.trim() || undefined,
        domainWhitelist: form.domainWhitelist,
      }
      const saved = editing
        ? await updateClient(editing.id, payload)
        : await createClient(payload)
      onSaved(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const isNew = !editing

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-cosmos-black/20 z-40"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-full max-w-[420px] bg-bg border-l border-border z-50 flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="font-serif text-lg font-medium text-cosmos-black">
            {isNew ? 'New client' : `Edit — ${editing!.name}`}
          </h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-cosmos-black transition-colors text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
          {/* Name */}
          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
              Name <span className="text-signal-error">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder="Acme Corp"
              required
              className="w-full text-sm font-sans border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors"
            />
          </div>

          {/* Initials + Accent row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
                Initials
              </label>
              <input
                type="text"
                value={form.initials}
                onChange={e => set('initials', e.target.value.toUpperCase().slice(0, 3))}
                placeholder="AC"
                maxLength={3}
                className="w-full text-sm font-sans font-mono border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors uppercase"
              />
            </div>
            <div>
              <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
                Brand colour
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={form.accent}
                  onChange={e => set('accent', e.target.value)}
                  className="w-10 h-[38px] rounded-sm border border-border cursor-pointer p-0.5 bg-bg"
                />
                <input
                  type="text"
                  value={form.accent}
                  onChange={e => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && set('accent', e.target.value)}
                  className="w-24 text-sm font-mono border border-border rounded-sm px-3 py-2 bg-bg focus:outline-none focus:border-cosmos-black transition-colors"
                />
              </div>
            </div>
          </div>

          {/* Preview */}
          <div className="flex items-center gap-3 p-3 bg-surface-sunken rounded-sm border border-border">
            {form.logoUrl ? (
              <img
                src={form.logoUrl}
                alt=""
                className="w-10 h-10 rounded-[28%_38%] object-cover"
                onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            ) : (
              <div
                className="w-10 h-10 rounded-[28%_38%] flex items-center justify-center text-sm font-bold font-sans text-clear-white shrink-0"
                style={{ backgroundColor: form.accent }}
              >
                {form.initials || initials(form.name) || '?'}
              </div>
            )}
            <div>
              <p className="text-sm font-sans font-semibold text-cosmos-black">{form.name || 'Client name'}</p>
              {form.website && (
                <p className="text-[11px] font-sans text-text-muted">{form.website}</p>
              )}
            </div>
          </div>

          {/* Logo URL */}
          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
              Logo URL
            </label>
            <input
              type="url"
              value={form.logoUrl}
              onChange={e => set('logoUrl', e.target.value)}
              placeholder="https://acme.com/logo.png"
              className="w-full text-sm font-sans font-mono border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors"
            />
            <p className="text-[11px] font-sans text-text-subtle mt-1">
              Replaces the initials badge when set.
            </p>
          </div>

          {/* Website */}
          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
              Website
            </label>
            <input
              type="url"
              value={form.website}
              onChange={e => set('website', e.target.value)}
              placeholder="https://acme.com"
              className="w-full text-sm font-sans font-mono border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors"
            />
          </div>

          {/* Portal slug */}
          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
              Portal URL slug
            </label>
            <div className="flex items-center border border-border rounded-sm overflow-hidden focus-within:border-cosmos-black transition-colors">
              <span className="px-3 py-2 text-sm font-sans text-text-muted bg-surface-sunken border-r border-border whitespace-nowrap">
                /
              </span>
              <input
                type="text"
                value={form.slug}
                onChange={e => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                placeholder="acme-corp"
                className="flex-1 px-3 py-2 text-sm font-mono bg-bg placeholder:text-text-subtle focus:outline-none"
              />
            </div>
            <p className="text-[11px] font-sans text-text-subtle mt-1">
              Share this URL with clients to give them a branded sign-in page.
            </p>
          </div>

          {/* Portal background */}
          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
              Portal background
            </label>
            <input
              type="text"
              value={form.portalBg}
              onChange={e => set('portalBg', e.target.value)}
              placeholder="#f5f0eb  or  https://…/hero.jpg"
              className="w-full text-sm font-sans font-mono border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors"
            />
            <p className="text-[11px] font-sans text-text-subtle mt-1">
              CSS colour or image URL shown on the portal welcome screen.
            </p>
          </div>

          {/* Domain whitelist */}
          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
              Domain whitelist
            </label>
            <DomainInput
              value={form.domainWhitelist}
              onChange={v => set('domainWhitelist', v)}
            />
            <p className="text-[11px] font-sans text-text-subtle mt-1">
              Users with a matching email domain are auto-assigned to this client. Press Enter or comma to add.
            </p>
          </div>

          {error && (
            <p className="text-[11px] font-sans text-signal-error">{error}</p>
          )}
        </form>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="text-sm font-sans text-text-muted hover:text-cosmos-black transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            form=""
            onClick={handleSubmit as unknown as React.MouseEventHandler}
            disabled={saving || !form.name.trim()}
            className="px-4 py-2 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-40 hover:bg-ink-800 transition-colors"
            style={form.name.trim() ? { boxShadow: '4px 4px 0 #161616' } : undefined}
          >
            {saving ? 'Saving…' : isNew ? 'Create client' : 'Save changes'}
          </button>
        </div>
      </div>
    </>
  )
}

// ── Client card ─────────────────────────────────────────────────

function ClientCard({
  client,
  active,
  onSelect,
  onEdit,
}: {
  client: Client
  active: boolean
  onSelect: () => void
  onEdit: () => void
}) {
  return (
    <div
      className={`relative group p-5 bg-surface border rounded-sm transition-colors cursor-pointer ${
        active ? 'border-cosmos-black' : 'border-border hover:border-cosmos-black'
      }`}
      style={active ? { boxShadow: '4px 4px 0 #161616' } : undefined}
      onClick={onSelect}
    >
      {/* Edit button */}
      <button
        onClick={e => { e.stopPropagation(); onEdit() }}
        className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 text-[11px] font-sans text-text-muted hover:text-cosmos-black transition-all px-2 py-1 rounded-chip border border-transparent hover:border-border"
      >
        Edit
      </button>

      {/* Badge or logo */}
      {client.logoUrl ? (
        <img
          src={client.logoUrl}
          alt={client.name}
          className="w-10 h-10 rounded-[28%_38%] object-cover mb-3"
        />
      ) : (
        <div
          className="w-10 h-10 rounded-[28%_38%] flex items-center justify-center mb-3 text-sm font-bold font-sans text-clear-white"
          style={{ backgroundColor: client.accent }}
        >
          {client.initials}
        </div>
      )}

      <h3 className="font-sans text-base font-semibold text-cosmos-black mb-0.5">{client.name}</h3>

      {client.website ? (
        <p className="text-[11px] font-sans text-text-muted truncate">{client.website.replace(/^https?:\/\//, '')}</p>
      ) : (
        <p className="text-[11px] font-sans text-text-subtle uppercase tracking-label truncate">{client.id.slice(0, 8)}…</p>
      )}

      {client.domainWhitelist && client.domainWhitelist.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {client.domainWhitelist.slice(0, 3).map(d => (
            <span key={d} className="text-[10px] font-mono bg-gray-100 border border-border rounded-chip px-1.5 py-0.5">
              @{d}
            </span>
          ))}
          {client.domainWhitelist.length > 3 && (
            <span className="text-[10px] font-sans text-text-muted px-1 py-0.5">+{client.domainWhitelist.length - 3}</span>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main view ──────────────────────────────────────────────────

export default function ClientsView() {
  const { activeClient, setActiveClient } = useRole()
  const { clients, loading, error, usingMock, reload } = useClients()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingClient, setEditingClient] = useState<Client | null>(null)

  function openCreate() {
    setEditingClient(null)
    setDrawerOpen(true)
  }

  function openEdit(client: Client) {
    setEditingClient(client)
    setDrawerOpen(true)
  }

  function closeDrawer() {
    setDrawerOpen(false)
    setEditingClient(null)
  }

  function handleSaved(saved: Client) {
    reload()
    closeDrawer()
    if (!editingClient) setActiveClient(saved)
  }

  return (
    <div className="px-5 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-serif text-2xl font-medium text-cosmos-black">Clients</h1>
        {!usingMock && (
          <button
            onClick={openCreate}
            className="text-sm font-sans font-semibold border-2 border-cosmos-black px-4 py-2 rounded-sm bg-bg text-cosmos-black hover:bg-cosmos-black hover:text-clear-white transition-colors"
            style={{ boxShadow: '4px 4px 0 #161616' }}
          >
            + New client
          </button>
        )}
      </div>

      <p className="font-sans text-sm text-text-muted mb-8">
        Each client is a separate workspace. Selecting one sets the accent colour and filters the gallery to their assets.
        {usingMock && <span className="ml-2 opacity-60">(demo — connect Supabase to manage real clients)</span>}
      </p>

      {error && (
        <p className="text-sm font-sans text-signal-error mb-6">{error}</p>
      )}

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-32 bg-surface-sunken border border-border rounded-sm animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {clients.map(client => (
            <ClientCard
              key={client.id}
              client={client}
              active={activeClient?.id === client.id}
              onSelect={() => setActiveClient(client)}
              onEdit={() => openEdit(client)}
            />
          ))}
        </div>
      )}

      {drawerOpen && (
        <ClientDrawer
          editing={editingClient}
          onClose={closeDrawer}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}
