/* Admin landing — routes staff to the dashboard, the users table, or a client's portal.
 *
 * Owns routing and top-level data only; every panel and drawer is its own module in this folder.
 */

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Client } from '@dc-hub/asset-library'
import { canManageClients, canCreateClients } from '@dc-hub/asset-library'
import { useAuth } from '../../context/AuthContext'
import { useClients } from '../../hooks/useClients'
import { asRole } from '../../services/userService'
import { isConfigured } from '../../lib/supabase'
import { AdminSignIn } from './AdminSignIn'
import { AdminClientCard } from './AdminClientCard'
import { ClientDrawer } from './ClientDrawer'
import { UsersView } from './UsersView'
import { DCMark } from './DCMark'
import { ErrorsView } from './errors/ErrorsView'

function AdminDashboard({ isAdmin }: { isAdmin: boolean }) {
  const { profile, signOut } = useAuth()
  const navigate = useNavigate()
  const { clients, loading, error, usingMock, reload } = useClients()
  const [tab, setTab] = useState<'clients' | 'users' | 'errors'>('clients')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingClient, setEditingClient] = useState<Client | null>(null)
  const role = asRole(profile?.role ?? 'public')
  const manageClients = canManageClients(role)   // edit existing clients (admin+)
  const createClients = canCreateClients(role, profile?.can_create_clients ?? false) // super_admin, or granted admin

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
          {/* Maintainer surface: errors quote client asset names and paths, so it is super-admin only
              here AND in RLS. The tab is hidden rather than disabled — an admin has no use for it. */}
          {role === 'super_admin' && (
            <button className={tabCls('errors')} onClick={() => setTab('errors')}>Errors</button>
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
              {!usingMock && createClients && (
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
                {!usingMock && createClients && (
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

        {tab === 'errors' && (
          <div className="p-6">
            <ErrorsView isSuperAdmin={role === 'super_admin'} />
          </div>
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

  if (profile && (asRole(profile.role) === 'admin' || asRole(profile.role) === 'super_admin')) return <AdminDashboard isAdmin />
  if (profile && asRole(profile.role) === 'editor') return <EditorRouter />

  if (profile) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-bg px-4 text-center">
        <DCMark size="lg" />
        <h1 className="font-serif text-2xl font-medium text-cosmos-black mt-6 mb-2">Staff access only</h1>
        <p className="font-sans text-sm text-text-muted mb-1 max-w-sm">
          You're signed in{session?.user?.email ? <> as <span className="font-mono text-cosmos-black">{session.user.email}</span></> : ''}, but this account doesn't have staff access to the DC Hub admin area.
        </p>
        <p className="font-sans text-sm text-text-muted mb-6 max-w-sm">
          If you're a client, open your portal link (<span className="font-mono">hub.disruptcollective.com/your-brand</span>) to reach your workspace. Otherwise ask an admin to grant you access.
        </p>
        <button
          onClick={signOut}
          className="px-6 py-2.5 text-sm font-sans font-semibold border-2 border-cosmos-black rounded-sm hover:bg-cosmos-black hover:text-clear-white transition-colors"
          style={{ boxShadow: '4px 4px 0 #161616' }}
        >
          Sign out & use a different account
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

