import { useCallback, useEffect, useState } from 'react'
import type { Client, Role } from '@dc-hub/asset-library'
import {
  fetchDestinations,
  saveDestinations,
  makePortalDestination,
  type PortalDestination,
  type DestType,
  type DestPipelineRole,
} from '../../services/destinationService'

const ROLE_OPTIONS: Role[] = ['public', 'member', 'editor', 'admin']
const TYPE_OPTIONS: DestType[] = ['gdrive', 'dropbox', 'onedrive', 'local']

function typeLabel(t: DestType): string {
  if (t === 'gdrive') return 'Google Drive'
  if (t === 'onedrive') return 'OneDrive'
  if (t === 'dropbox') return 'Dropbox'
  return 'Local path'
}

function emptyConfig(type: DestType): PortalDestination['config'] {
  if (type === 'local') return { type: 'local', path: '' }
  if (type === 'dropbox') return { type: 'dropbox', clientId: '', remotePath: '', token: null }
  if (type === 'onedrive') return { type: 'onedrive', clientId: '', tenantId: 'common', remotePath: '', token: null }
  return { type: 'gdrive', clientId: '', clientSecret: '', sharedDriveId: '', remotePath: '', token: null }
}

export function DestinationsAdmin({ client }: { client: Client }) {
  const [dests, setDests] = useState<PortalDestination[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [editing, setEditing] = useState<PortalDestination | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      setDests(await fetchDestinations(client.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [client.id])

  useEffect(() => { void load() }, [load])

  async function persist(next: PortalDestination[]) {
    setSaving(true); setError(''); setMsg('')
    try {
      await saveDestinations(client.id, next)
      setDests(next)
      setMsg('Destinations saved. Desktop will pick them up on Sync / next launch.')
      setEditing(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  function handleSaveForm(d: PortalDestination) {
    const isNew = !dests.some(x => x.id === d.id)
    void persist(isNew ? [...dests, d] : dests.map(x => x.id === d.id ? d : x))
  }

  function handleDelete(id: string) {
    if (!window.confirm('Remove this destination from the portal? Desktop OAuth keys for it stay local until cleaned up.')) return
    void persist(dests.filter(d => d.id !== id))
  }

  if (loading) return <p className="text-sm text-text-muted">Loading destinations…</p>

  if (editing) {
    return (
      <DestForm
        dest={editing}
        saving={saving}
        onSave={handleSaveForm}
        onCancel={() => setEditing(null)}
      />
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] font-sans text-text-subtle">
        Structure is managed here (including package-folder export). Desktop stores OAuth keys/tokens and local machine paths.
      </p>
      {error && <p className="text-[11px] font-sans text-signal-error">{error}</p>}
      {msg && <p className="text-[11px] font-sans text-cosmos-black">{msg}</p>}

      <div className="border border-border rounded-sm overflow-hidden">
        {dests.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-text-subtle">No destinations yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {dests.map(d => (
              <li key={d.id} className="flex items-center gap-2 px-3 py-2.5 text-sm font-sans">
                <span className="text-[10px] font-bold uppercase tracking-label text-text-muted w-20 shrink-0">
                  {typeLabel(d.config.type)}
                </span>
                <span className="flex-1 min-w-0 truncate font-semibold">{d.name || 'Unnamed'}</span>
                {d.exportPackages && (
                  <span className="text-[10px] text-text-muted shrink-0">packages</span>
                )}
                <span className="text-[10px] text-text-muted shrink-0">≥ {d.minRole}</span>
                {!d.enabled && <span className="text-[10px] text-signal-error">off</span>}
                <button type="button" onClick={() => setEditing(d)} className="text-[11px] hover:underline shrink-0">Edit</button>
                <button type="button" onClick={() => handleDelete(d.id)} className="text-[11px] text-signal-error hover:underline shrink-0">Del</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        type="button"
        onClick={() => setEditing(makePortalDestination())}
        className="text-[11px] font-sans font-semibold text-cosmos-black hover:underline"
      >
        + Add destination
      </button>
    </div>
  )
}

function DestForm({
  dest,
  saving,
  onSave,
  onCancel,
}: {
  dest: PortalDestination
  saving: boolean
  onSave: (d: PortalDestination) => void
  onCancel: () => void
}) {
  const [form, setForm] = useState<PortalDestination>(dest)
  const set = <K extends keyof PortalDestination>(k: K, v: PortalDestination[K]) =>
    setForm(f => ({ ...f, [k]: v }))

  function setType(type: DestType) {
    setForm(f => ({ ...f, config: emptyConfig(type) }))
  }

  function setRemotePath(path: string) {
    setForm(f => {
      if (f.config.type === 'local') return f
      return { ...f, config: { ...f.config, remotePath: path } }
    })
  }

  function setClientId(clientId: string) {
    setForm(f => {
      if (f.config.type === 'local') return f
      return { ...f, config: { ...f.config, clientId } }
    })
  }

  function setExportPackages(checked: boolean) {
    setForm(f => ({
      ...f,
      exportPackages: checked,
      flatExport: checked ? false : f.flatExport,
    }))
  }

  const oauthClientId =
    form.config.type === 'local' ? '' : form.config.clientId

  return (
    <div className="space-y-3 border border-border rounded-sm p-3 bg-surface-sunken">
      <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
        {dest.name ? `Edit — ${dest.name}` : 'New destination'}
      </p>

      <label className="block">
        <span className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">Name</span>
        <input
          className="mt-1 w-full border border-border rounded-sm px-2 py-1.5 text-sm bg-bg"
          value={form.name}
          onChange={e => set('name', e.target.value)}
          placeholder="Client SharePoint"
        />
      </label>

      <label className="block">
        <span className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">Type</span>
        <select
          className="mt-1 w-full border border-border rounded-sm px-2 py-1.5 text-sm bg-bg"
          value={form.config.type}
          onChange={e => setType(e.target.value as DestType)}
        >
          {TYPE_OPTIONS.map(t => (
            <option key={t} value={t}>{typeLabel(t)}</option>
          ))}
        </select>
      </label>

      {form.config.type !== 'local' && (
        <label className="block">
          <span className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
            OAuth app client id (public)
          </span>
          <input
            className="mt-1 w-full border border-border rounded-sm px-2 py-1.5 text-sm font-mono bg-bg"
            value={oauthClientId}
            onChange={e => setClientId(e.target.value)}
            placeholder="Desktop will use this id when connecting"
          />
        </label>
      )}

      {form.config.type === 'onedrive' && (
        <label className="block">
          <span className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">Tenant id</span>
          <input
            className="mt-1 w-full border border-border rounded-sm px-2 py-1.5 text-sm font-mono bg-bg"
            value={form.config.tenantId}
            onChange={e => setForm(f => f.config.type === 'onedrive'
              ? { ...f, config: { ...f.config, tenantId: e.target.value } }
              : f)}
          />
        </label>
      )}

      {form.config.type === 'gdrive' && (
        <label className="block">
          <span className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">Shared drive id (optional)</span>
          <input
            className="mt-1 w-full border border-border rounded-sm px-2 py-1.5 text-sm font-mono bg-bg"
            value={form.config.sharedDriveId}
            onChange={e => setForm(f => f.config.type === 'gdrive'
              ? { ...f, config: { ...f.config, sharedDriveId: e.target.value } }
              : f)}
          />
        </label>
      )}

      {form.config.type === 'local' ? (
        <p className="text-[11px] font-sans text-text-subtle">
          Machine path is set in the desktop app (Cloud destinations → Browse). Not stored in the portal.
        </p>
      ) : (
        <label className="block">
          <span className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
            Remote path
          </span>
          <input
            className="mt-1 w-full border border-border rounded-sm px-2 py-1.5 text-sm font-mono bg-bg"
            value={form.config.remotePath}
            onChange={e => setRemotePath(e.target.value)}
            placeholder="/Clients/Acme/Assets"
          />
        </label>
      )}

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">Pipeline role</span>
          <select
            className="mt-1 w-full border border-border rounded-sm px-2 py-1.5 text-sm bg-bg"
            value={form.role}
            onChange={e => set('role', e.target.value as DestPipelineRole)}
          >
            <option value="client">Client share</option>
            <option value="internal">Internal only</option>
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">Visible to</span>
          <select
            className="mt-1 w-full border border-border rounded-sm px-2 py-1.5 text-sm bg-bg"
            value={form.minRole}
            onChange={e => set('minRole', e.target.value as Role)}
          >
            {ROLE_OPTIONS.map(r => (
              <option key={r} value={r}>{r}+ </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-4 text-[11px] font-sans">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} />
          Enabled
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={form.generateLink} onChange={e => set('generateLink', e.target.checked)} />
          Generate share link
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={form.showInPortal} onChange={e => set('showInPortal', e.target.checked)} />
          Show links in portal
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={form.exportPackages}
            onChange={e => setExportPackages(e.target.checked)}
          />
          Export package folders
        </label>
        <label className={`flex items-center gap-1.5 ${form.exportPackages ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
          <input
            type="checkbox"
            checked={form.flatExport}
            disabled={form.exportPackages}
            onChange={e => set('flatExport', e.target.checked)}
          />
          Flatten into one folder
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={form.allowRevealLocal} onChange={e => set('allowRevealLocal', e.target.checked)} />
          Allow Reveal in Finder
        </label>
      </div>
      <p className="text-[10px] font-sans text-text-subtle">
        Package folders: desktop copies source packages (after Distribute) instead of the OUT tree.
        Flat export is ignored when packages are on. Reveal needs the desktop app on this machine.
      </p>

      <div className="flex justify-end gap-3 pt-1">
        <button type="button" onClick={onCancel} className="text-[11px] text-text-muted hover:text-cosmos-black">Cancel</button>
        <button
          type="button"
          disabled={saving || !form.name.trim()}
          onClick={() => onSave(form)}
          className="px-3 py-1.5 text-[11px] font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save destination'}
        </button>
      </div>
    </div>
  )
}
