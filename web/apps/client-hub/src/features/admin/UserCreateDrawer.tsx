/* Invite or create a user, and set their role.
 *
 * The role list is narrowed by `assignableRoles` — an ordinary admin cannot grant admin or
 * super-admin. RLS enforces the same boundary server-side.
 */

import { useState } from 'react'
import { Client } from '@sotto/asset-library'
import {} from '@sotto/asset-library'
import { createUser } from '../../services/userService'
import { assignableRoles, ROLE_LABELS } from './roles'
import { inputCls } from './styles'

export function UserCreateDrawer({ clients, onClose, onCreated, canManageAdmins: viewerCanManageAdmins }: {
  clients: Client[]
  onClose: () => void
  onCreated: () => void
  canManageAdmins: boolean
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<string>('member')
  const [clientId, setClientId] = useState('')
  const [memberClientIds, setMemberClientIds] = useState<string[]>([])
  const [sendInvitation, setSendInvitation] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmedEmail = email.trim().toLowerCase()
    if (!trimmedEmail) return
    if (role === 'member' && !clientId) {
      setError('Select a client for members.')
      return
    }
    if (role === 'editor' && memberClientIds.length === 0) {
      setError('Select at least one client for editors.')
      return
    }
    setSaving(true); setError('')
    try {
      await createUser({
        email: trimmedEmail,
        name: name.trim() || undefined,
        role,
        clientId: role === 'member' ? clientId : null,
        memberClientIds: role === 'editor' ? memberClientIds : undefined,
        sendInvitation,
      })
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  function toggleEditorClient(id: string) {
    setMemberClientIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id],
    )
  }

  return (
    <>
      <div className="fixed inset-0 bg-cosmos-black/20 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-full max-w-[420px] bg-bg border-l border-border z-50 flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="font-serif text-lg font-medium text-cosmos-black">New user</h2>
          <button onClick={onClose} className="text-text-muted hover:text-cosmos-black transition-colors text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} id="user-create-form" className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
              Email <span className="text-signal-error">*</span>
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="colleague@company.com"
              required
              autoFocus
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Jana Kovářová"
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">Role</label>
            <select
              value={role}
              onChange={e => setRole(e.target.value)}
              className={`${inputCls} cursor-pointer`}
            >
              {assignableRoles(viewerCanManageAdmins).map(r => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
          </div>

          {role === 'member' && (
            <div>
              <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
                Client <span className="text-signal-error">*</span>
              </label>
              <select
                value={clientId}
                onChange={e => setClientId(e.target.value)}
                required
                className={`${inputCls} cursor-pointer`}
              >
                <option value="">Select client…</option>
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}

          {role === 'editor' && (
            <div>
              <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
                Clients <span className="text-signal-error">*</span>
              </label>
              <div className="flex flex-wrap gap-2 p-3 border border-border rounded-sm bg-surface-sunken">
                {clients.map(c => (
                  <label key={c.id} className="flex items-center gap-1.5 text-sm font-sans cursor-pointer">
                    <input
                      type="checkbox"
                      checked={memberClientIds.includes(c.id)}
                      onChange={() => toggleEditorClient(c.id)}
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          <label className="flex items-start gap-3 cursor-pointer group p-3 border border-border rounded-sm bg-surface-sunken">
            <input
              type="checkbox"
              checked={sendInvitation}
              onChange={e => setSendInvitation(e.target.checked)}
              className="mt-0.5 shrink-0 accent-cosmos-black"
            />
            <span className="text-sm font-sans text-cosmos-black group-hover:text-cosmos-black">
              Send invitation email
              <span className="block text-[11px] text-text-muted mt-1 font-normal">
                {sendInvitation
                  ? 'Supabase sends a sign-in link to this address.'
                  : 'Creates the account silently — they can sign in later via magic link.'}
              </span>
            </span>
          </label>

          {error && (
            <div className="p-3 border border-signal-error/40 bg-signal-error/5 rounded-sm">
              <p className="text-[11px] font-sans text-signal-error">{error}</p>
            </div>
          )}
        </form>

        <div className="flex items-center justify-between px-6 py-4 border-t border-border shrink-0">
          <button type="button" onClick={onClose} className="text-sm font-sans text-text-muted hover:text-cosmos-black transition-colors">
            Cancel
          </button>
          <button
            form="user-create-form"
            type="submit"
            disabled={saving || !email.trim()}
            className="px-4 py-2 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-40 hover:bg-ink-800 transition-colors"
            style={email.trim() ? { boxShadow: '4px 4px 0 #161616' } : undefined}
          >
            {saving ? 'Creating…' : sendInvitation ? 'Create & invite' : 'Create user'}
          </button>
        </div>
      </div>
    </>
  )
}

// ── Users view ────────────────────────────────────────────────

