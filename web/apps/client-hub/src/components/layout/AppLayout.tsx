import { NavLink, Outlet } from 'react-router-dom'
import { useRole } from '../../context/RoleContext'
import { useAuth } from '../../context/AuthContext'
import { useClients } from '../../hooks/useClients'
import { canSwitchClient } from '@dc-hub/asset-library'
import { isConfigured } from '../../lib/supabase'

export default function AppLayout() {
  const { role, setRole, activeClient, setActiveClient, user } = useRole()
  const { signOut } = useAuth()
  const { clients } = useClients()
  const configured = isConfigured()

  if (role === 'public') {
    return (
      <div className="min-h-full bg-bg">
        <Outlet />
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-full bg-bg">
      <header className="flex items-center h-11 px-5 border-b border-border bg-surface shrink-0">
        {/* Logo */}
        <div className="flex items-center gap-2 mr-6">
          <div className="w-6 h-6 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center">
            <span className="text-clear-white text-[10px] font-bold font-sans leading-none">C</span>
          </div>
          <span className="font-sans text-xs font-bold tracking-[0.14em] uppercase text-cosmos-black">
            DC HUB
          </span>
        </div>

        {/* Nav */}
        <nav className="flex items-center gap-1 flex-1">
          {(['gallery', 'activity'] as const).map(path => (
            <NavLink
              key={path}
              to={path === 'gallery' ? '/' : `/${path}`}
              end={path === 'gallery'}
              className={({ isActive }) =>
                `px-3 py-1 text-sm font-sans rounded-sm transition-colors duration-fast ${
                  isActive ? 'text-cosmos-black font-medium' : 'text-text-muted hover:text-cosmos-black'
                }`
              }
            >
              {path.charAt(0).toUpperCase() + path.slice(1)}
            </NavLink>
          ))}
          {canSwitchClient(role) && (
            <NavLink
              to="/clients"
              className={({ isActive }) =>
                `px-3 py-1 text-sm font-sans rounded-sm transition-colors duration-fast ${
                  isActive ? 'text-cosmos-black font-medium' : 'text-text-muted hover:text-cosmos-black'
                }`
              }
            >
              Clients
            </NavLink>
          )}
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `px-3 py-1 text-sm font-sans rounded-sm transition-colors duration-fast ${
                isActive ? 'text-cosmos-black font-medium' : 'text-text-muted hover:text-cosmos-black'
              }`
            }
          >
            Settings
          </NavLink>
        </nav>

        {/* Right cluster */}
        <div className="flex items-center gap-3">
          {/* Client switcher — editors/admins */}
          {canSwitchClient(role) && activeClient && (
            <div className="relative flex items-center gap-2 border border-border rounded-sm px-2 py-1">
              <span className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
                Client
              </span>
              <span className="text-sm font-sans text-cosmos-black">{activeClient.name}</span>
              <div
                className="w-6 h-6 rounded-[28%_38%] flex items-center justify-center text-[9px] font-bold font-sans text-clear-white"
                style={{ backgroundColor: activeClient.accent }}
              >
                {activeClient.initials}
              </div>
              <select
                className="absolute inset-0 opacity-0 cursor-pointer w-full"
                value={activeClient.id}
                onChange={e => {
                  const c = clients.find(c => c.id === e.target.value)
                  if (c) setActiveClient(c)
                }}
                aria-label="Switch client"
              >
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Notifications */}
          <button className="w-7 h-7 flex items-center justify-center text-text-muted hover:text-cosmos-black transition-colors">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 2a4 4 0 0 1 4 4v2.5l1 1.5H3l1-1.5V6a4 4 0 0 1 4-4Z" />
              <path d="M6.5 13a1.5 1.5 0 0 0 3 0" />
            </svg>
          </button>

          {/* User chip */}
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center">
              <span className="text-clear-white text-[10px] font-bold font-sans">{user.initials}</span>
            </div>
            <div className="hidden sm:flex flex-col items-end leading-none">
              <span className="text-sm font-sans font-medium text-cosmos-black">{user.name}</span>
              <span className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">{role}</span>
            </div>
          </div>

          {/* Sign out (auth mode) or dev role switcher (demo mode) */}
          {configured ? (
            <button
              onClick={signOut}
              className="text-[11px] font-sans text-text-muted hover:text-cosmos-black transition-colors border border-border rounded-sm px-2 py-1"
            >
              Sign out
            </button>
          ) : (
            <select
              value={role}
              onChange={e => setRole(e.target.value as typeof role)}
              className="ml-2 text-[10px] font-sans border border-border rounded-sm px-1 py-0.5 text-text-muted bg-surface"
              title="Dev: switch role"
            >
              <option value="public">Public</option>
              <option value="client">Client</option>
              <option value="editor">Editor</option>
              <option value="admin">Admin</option>
            </select>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  )
}
