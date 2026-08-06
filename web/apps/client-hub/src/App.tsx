import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import { useRole } from './context/RoleContext'
import { isConfigured } from './lib/supabase'
import AssetDetailPage from './features/gallery/AssetDetailPage'
import AdminLandingPage from './features/admin/AdminLandingPage'
import ClientPortalPage from './features/portal/ClientPortalPage'
import SettingsView from './features/settings/SettingsView'
import { RouteErrorBoundary } from './components/RouteErrorBoundary'
import { BuildBadge } from './components/BuildBadge'
import MagicLinkConfirmationPage from './features/auth/MagicLinkConfirmationPage'

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
            SOTTO
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
    <>
    {/* Outside the boundary on purpose: when a route has crashed, the build you are looking at is
        the first thing a bug report needs. */}
    <BuildBadge />
    {/* One boundary around the route tree, keyed on the path: a page that throws no longer blanks the
        app, and navigating away recovers without a reload. */}
    <RouteErrorBoundary>
      <Routes>
      {/* DC admin portal */}
      <Route index element={<AdminLandingPage />} />

      {/* Settings — accessible to any logged-in user */}
      <Route path="settings" element={<SettingsPage />} />

      {/* Email scanners may load the URL in the message. This route is deliberately inert until
          the person selects Continue; only then is the one-time Supabase URL constructed. */}
      <Route path="auth/confirm" element={<MagicLinkConfirmationPage />} />

      {/* Public asset share links */}
      <Route path="share/:id" element={<AssetDetailPage />} />

      {/* Client portals — branded page, DC 404, or gallery after login.
          `:slug` IS A ROOT CATCH-ALL. Declare any new single-segment top-level route ABOVE it.
          React Router v6 ranks static above dynamic so it would probably work anyway; declare it
          first regardless, because the next person will not check.

          Two sibling routes to one element, deliberately — not a nested route with an <Outlet/>.
          ClientPortalPage owns the client fetch, the sign-in gate and the CompleteProfile gate, and
          all three must run identically on both paths. Nesting would either duplicate those gates or
          force GalleryView to render an Outlet, which puts the drawer outside the component that
          owns the grid it overlays. Rendering the same component type at the same depth reconciles
          rather than remounts, so the client is NOT refetched when the drawer opens. */}
      <Route path=":slug" element={<ClientPortalPage />} />
      <Route path=":slug/a/:assetId" element={<ClientPortalPage />} />
      </Routes>
    </RouteErrorBoundary>
    </>
  )
}
