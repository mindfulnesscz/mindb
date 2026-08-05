/* The users table — role changes and client assignment. */

import { useState, useEffect, useCallback } from 'react'
import {  canManageAdmins } from '@sotto/asset-library'
import { useAuth } from '../../context/AuthContext'
import { useClients } from '../../hooks/useClients'
import { fetchAllUsers, updateUserAccess, asRole, type UserProfile } from '../../services/userService'
import { assignableRoles, ROLE_LABELS } from './roles'
import { UserCreateDrawer } from './UserCreateDrawer'

export function UsersView({ isAdmin }: { isAdmin: boolean }) {
  const { profile: self } = useAuth()
  const viewerCanManageAdmins = canManageAdmins(asRole(self?.role ?? 'public'))
  const { clients } = useClients()
  const [users, setUsers] = useState<UserProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [draftClient, setDraftClient] = useState<Record<string, string>>({})
  const [draftMembers, setDraftMembers] = useState<Record<string, string[]>>({})
  const [createOpen, setCreateOpen] = useState(false)

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
        // Trust the values on the passed user object — the callers set them.
        // Re-reading draft state here races the setState in the same tick.
        clientId: role === 'member' ? (user.clientId ?? null) : null,
        memberClientIds: role === 'editor' ? (user.memberClientIds ?? []) : undefined,
        canCreateClients: role === 'admin' ? user.canCreateClients : undefined,
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
    // member/editor can't be saved until a client is assigned — switching the
    // role just reveals the client picker in the Access column; the save fires
    // when a client is chosen there. Avoids the "requires client" DB error.
    if (role === 'member' && !(draftClient[userId] ?? user.clientId)) { setError(''); return }
    if (role === 'editor' && (draftMembers[userId] ?? user.memberClientIds ?? []).length === 0) { setError(''); return }
    await saveAccess({ ...user, role })
  }

  if (loading) return (
    <div className="space-y-2">
      {[1,2,3].map(i => <div key={i} className="h-14 bg-surface-sunken border border-border rounded-sm animate-pulse" />)}
    </div>
  )

  if (error) return <p className="text-sm font-sans text-signal-error">{error}</p>

  return (
    <>
      {isAdmin && (
        <div className="flex justify-end mb-4">
          <button
            onClick={() => setCreateOpen(true)}
            className="text-sm font-sans font-semibold border-2 border-cosmos-black px-4 py-2 rounded-sm hover:bg-cosmos-black hover:text-clear-white transition-colors"
            style={{ boxShadow: '4px 4px 0 #161616' }}
          >
            + New user
          </button>
        </div>
      )}

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
                ) : viewerCanManageAdmins && u.id !== self?.id && u.role === 'admin' ? (
                  <label className="flex items-center gap-1.5 text-[11px] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={u.canCreateClients}
                      disabled={saving === u.id}
                      onChange={() => {
                        const next = !u.canCreateClients
                        setUsers(list => list.map(p => p.id === u.id ? { ...p, canCreateClients: next } : p))
                        void saveAccess({ ...u, canCreateClients: next })
                      }}
                    />
                    Can create clients
                  </label>
                ) : (
                  <span>{u.clientName ?? (u.memberClientIds?.length ? `${u.memberClientIds.length} client(s)` : '—')}</span>
                )}
              </td>
              <td className="px-4 py-3">
                {isAdmin && u.id !== self?.id
                  && (viewerCanManageAdmins || (u.role !== 'admin' && u.role !== 'super_admin')) ? (
                  <select
                    value={u.role}
                    disabled={saving === u.id}
                    onChange={e => handleRoleChange(u.id, e.target.value)}
                    className="text-sm font-sans border border-border rounded-sm px-2 py-1 bg-bg focus:outline-none focus:border-cosmos-black transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    {assignableRoles(viewerCanManageAdmins).map(r => (
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

      {createOpen && (
        <UserCreateDrawer
          clients={clients}
          canManageAdmins={viewerCanManageAdmins}
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); void load() }}
        />
      )}
    </>
  )
}

// ── Admin dashboard ───────────────────────────────────────────

