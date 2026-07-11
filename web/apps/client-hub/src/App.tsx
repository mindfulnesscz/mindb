import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import { useRole } from './context/RoleContext'
import { isConfigured } from './lib/supabase'
import AssetDetailPage from './features/gallery/AssetDetailPage'
import AdminLandingPage from './features/admin/AdminLandingPage'
import ClientPortalPage from './features/portal/ClientPortalPage'
import SettingsView from './features/settings/SettingsView'

// ── Standalone settings page ──────────────────────────────────

function SettingsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { signOut } = useAuth()
  const { user, role } = useRole()

  // Figure out where "back" goes: the referring client portal or admin home
  const backPath = (location.state as { from?: string } | null)?.from ?? '/'

  return (
    <div className="flex flex-col min-h-screen bg-bg">
      <header className="flex items-center h-11 px-5 border-b border-border bg-surface shrink-0">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 mr-6 hover:opacity-70 transition-opacity"
        >
          <div className="w-6 h-6 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center">
            <span className="text-clear-white text-[10px] font-bold font-sans leading-none">C</span>
          </div>
          <span className="font-sans text-xs font-bold tracking-[0.14em] uppercase text-cosmos-black">
            DC HUB
          </span>
        </button>

        <nav className="flex items-center gap-1 flex-1">
          <button
            onClick={() => navigate(backPath)}
            className="px-3 py-1 text-sm font-sans text-text-muted hover:text-cosmos-black rounded-sm transition-colors"
          >
            ← Back
          </button>
          <span className="px-3 py-1 text-sm font-sans font-medium text-cosmos-black">
            Settings
          </span>
        </nav>

        <div className="flex items-center gap-2 mr-3">
          <div className="w-7 h-7 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center">
            <span className="text-clear-white text-[10px] font-bold font-sans">{user.initials}</span>
          </div>
          <div className="hidden sm:flex flex-col items-end leading-none">
            <span className="text-sm font-sans font-medium text-cosmos-black">{user.name}</span>
            <span className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">{role}</span>
          </div>
        </div>

        <button
          onClick={signOut}
          className="text-[11px] font-sans text-text-muted hover:text-cosmos-black transition-colors border border-border rounded-sm px-2 py-1"
        >
          Sign out
        </button>
      </header>

      <main className="flex-1 overflow-y-auto">
        <SettingsView />
      </main>
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────

export default function App() {
  const { loading } = useAuth()
  const configured = isConfigured()

  if (configured && loading) {
    return (
      <div className="flex items-center justify-center min-h-full bg-bg">
        <span className="text-sm font-sans text-text-muted">Loading…</span>
      </div>
    )
  }

  return (
    <Routes>
      {/* DC admin portal */}
      <Route index element={<AdminLandingPage />} />

      {/* Settings — accessible to any logged-in user */}
      <Route path="settings" element={<SettingsPage />} />

      {/* Public asset share links */}
      <Route path="share/:id" element={<AssetDetailPage />} />

      {/* Client portals — branded page, DC 404, or gallery after login */}
      <Route path=":slug" element={<ClientPortalPage />} />
    </Routes>
  )
}
