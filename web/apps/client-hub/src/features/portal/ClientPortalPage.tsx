import { useState, useEffect } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useRole } from '../../context/RoleContext'
import { useClients } from '../../hooks/useClients'
import { canSwitchClient } from '@dc-hub/asset-library'
import type { Client } from '@dc-hub/asset-library'
import SignInModal from '../auth/SignInModal'
import GalleryView from '../gallery/GalleryView'

interface PortalClient {
  id: string
  name: string
  accent: string
  initials: string
  logo_url: string | null
  portal_bg: string | null
}

// ── DC-branded 404 ────────────────────────────────────────────

function NotFoundPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-bg px-4 text-center">
      <div
        className="w-14 h-14 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center mb-6"
        style={{ boxShadow: '4px 4px 0 #161616' }}
      >
        <span className="text-clear-white text-lg font-bold font-sans leading-none">C</span>
      </div>
      <p className="font-sans text-[10px] font-bold tracking-[0.14em] uppercase text-text-muted mb-6">DC HUB</p>
      <h1 className="font-serif text-4xl font-medium text-cosmos-black mb-3">404</h1>
      <p className="font-sans text-sm text-text-muted mb-1">This portal doesn't exist.</p>
      <p className="text-[11px] font-sans text-text-subtle">Check the URL or contact DC Hub for your access link.</p>
    </div>
  )
}

// ── Client badge (pre-login welcome screen) ───────────────────

function Badge({ client }: { client: PortalClient }) {
  if (client.logo_url) {
    return (
      <img
        src={client.logo_url}
        alt={client.name}
        className="w-20 h-20 rounded-[28%_38%] object-cover"
      />
    )
  }
  return (
    <div
      className="w-20 h-20 rounded-[28%_38%] flex items-center justify-center text-2xl font-bold font-sans text-clear-white"
      style={{ backgroundColor: client.accent }}
    >
      {client.initials}
    </div>
  )
}

// ── Admin / editor full app header ────────────────────────────

function AdminAppHeader({ slug }: { slug: string }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { signOut } = useAuth()
  const { role, user, activeClient, setActiveClient } = useRole()
  const { clients } = useClients()

  const navItems = [
    { label: 'Gallery',  path: `/${slug}` },
    { label: 'Clients',  path: '/' },
    { label: 'Settings', path: '/settings' },
  ]

  function isActive(path: string) {
    if (path === `/${slug}`) return location.pathname === `/${slug}`
    return location.pathname === path
  }

  return (
    <header className="flex items-center h-11 px-5 border-b border-border bg-surface shrink-0">
      {/* DC Hub logo — click goes to admin home */}
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

      {/* Nav */}
      <nav className="flex items-center gap-1 flex-1">
        {navItems.map(item => (
          <button
            key={item.path}
            onClick={() => navigate(item.path)}
            className={`px-3 py-1 text-sm font-sans rounded-sm transition-colors duration-fast ${
              isActive(item.path)
                ? 'text-cosmos-black font-medium'
                : 'text-text-muted hover:text-cosmos-black'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {/* Client switcher */}
      {canSwitchClient(role) && activeClient && (
        <div className="relative flex items-center gap-2 border border-border rounded-sm px-2 py-1 mr-3">
          <span className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
            Client
          </span>
          <span className="text-sm font-sans text-cosmos-black">{activeClient.name}</span>
          <div
            className="w-5 h-5 rounded-[28%_38%] flex items-center justify-center text-[8px] font-bold font-sans text-clear-white"
            style={{ backgroundColor: activeClient.accent }}
          >
            {activeClient.initials}
          </div>
          <select
            className="absolute inset-0 opacity-0 cursor-pointer w-full"
            value={activeClient.id}
            onChange={e => {
              const c = clients.find(c => c.id === e.target.value)
              if (c) {
                setActiveClient(c)
                if (c.slug) navigate(`/${c.slug}`)
              }
            }}
            aria-label="Switch client"
          >
            {clients.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* User chip */}
      <div className="flex items-center gap-2 mr-3">
        <div className="w-7 h-7 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center">
          <span className="text-clear-white text-[10px] font-bold font-sans">{user.initials}</span>
        </div>
        <div className="hidden sm:flex flex-col items-end leading-none">
          <span className="text-sm font-sans font-medium text-cosmos-black">{user.name}</span>
          <span className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">{role}</span>
        </div>
      </div>

      {/* Sign out */}
      <button
        onClick={signOut}
        className="text-[11px] font-sans text-text-muted hover:text-cosmos-black transition-colors border border-border rounded-sm px-2 py-1"
      >
        Sign out
      </button>
    </header>
  )
}

// ── Simple portal header (client / public users) ──────────────

function PortalHeader({ client }: { client: PortalClient }) {
  const { profile, signOut } = useAuth()

  return (
    <header className="flex items-center gap-3 px-5 py-3 border-b border-border bg-surface shrink-0">
      <div className="flex items-center gap-2">
        {client.logo_url ? (
          <img src={client.logo_url} alt={client.name} className="w-7 h-7 rounded-[28%_38%] object-cover" />
        ) : (
          <div
            className="w-7 h-7 rounded-[28%_38%] flex items-center justify-center text-[10px] font-bold font-sans text-clear-white"
            style={{ backgroundColor: client.accent }}
          >
            {client.initials}
          </div>
        )}
        <span className="font-sans text-sm font-semibold text-cosmos-black">{client.name}</span>
      </div>

      <div className="flex-1" />

      {profile && (
        <span className="text-sm font-sans text-text-muted hidden sm:block">{profile.name}</span>
      )}
      <button
        onClick={signOut}
        className="text-sm font-sans text-text-muted hover:text-cosmos-black transition-colors"
      >
        Sign out
      </button>
    </header>
  )
}

// ── Main page ─────────────────────────────────────────────────

export default function ClientPortalPage() {
  const { slug } = useParams<{ slug: string }>()
  const { session } = useAuth()
  const { role, setActiveClient } = useRole()

  const [client,    setClient]   = useState<PortalClient | null>(null)
  const [missing,   setMissing]  = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)

  // Detect auth errors Supabase puts in the URL hash (e.g. expired link)
  useEffect(() => {
    const hash = window.location.hash
    if (!hash.includes('error=')) return
    const params = new URLSearchParams(hash.slice(1))
    const desc = params.get('error_description')
    if (desc) setLinkError(desc.replace(/\+/g, ' '))
    window.history.replaceState(null, '', window.location.pathname)
  }, [])

  // Fetch client by slug — works unauthenticated via security definer RPC
  useEffect(() => {
    if (!slug || !supabase) { setMissing(true); return }
    (supabase as any)
      .rpc('get_client_portal', { p_slug: slug })
      .then(({ data, error }: { data: unknown; error: unknown }) => {
        if (error || !data || (data as PortalClient[]).length === 0) {
          setMissing(true)
        } else {
          setClient((data as PortalClient[])[0])
        }
      })
  }, [slug])

  // Sync activeClient in RoleContext so GalleryView filters to this client
  useEffect(() => {
    if (!client) return
    const roleClient: Client = {
      id:       client.id,
      name:     client.name,
      accent:   client.accent,
      initials: client.initials,
      logoUrl:  client.logo_url  ?? undefined,
      portalBg: client.portal_bg ?? undefined,
    }
    setActiveClient(roleClient)
  }, [client?.id])

  if (missing)  return <NotFoundPage />
  if (!client)  return <div className="min-h-screen bg-bg" />

  // ── Not logged in: branded welcome ────────────────────────
  if (!session) {
    const isBgImage = client.portal_bg?.startsWith('http') || client.portal_bg?.startsWith('/')
    const bgStyle = isBgImage
      ? { backgroundImage: `url(${client.portal_bg})`, backgroundSize: 'cover', backgroundPosition: 'center' }
      : { backgroundColor: client.portal_bg || client.accent + '18' }

    return (
      <div className="min-h-screen flex flex-col" style={bgStyle}>
        <div className="flex items-center gap-2 px-6 py-4">
          <div className="w-5 h-5 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center">
            <span className="text-clear-white text-[9px] font-bold font-sans leading-none">C</span>
          </div>
          <span className="font-sans text-[10px] font-bold tracking-[0.14em] uppercase text-cosmos-black opacity-60">
            DC HUB
          </span>
        </div>

        <div className="flex-1 flex items-center justify-center px-6">
          <div className="text-center">
            <div className="flex justify-center mb-6">
              <Badge client={client} />
            </div>
            <h1 className="font-serif text-3xl font-medium text-cosmos-black mb-2">{client.name}</h1>
            <p className="font-sans text-sm text-text-muted mb-10">
              Asset portal — request access or sign in below.
            </p>
            <button
              onClick={() => { setShowModal(true); setLinkError(null) }}
              className="px-8 py-3 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm hover:bg-ink-800 transition-colors"
              style={{ boxShadow: '4px 4px 0 #161616' }}
            >
              Sign in / Request access
            </button>

            {linkError && (
              <p className="mt-6 text-sm font-sans text-signal-error">
                {linkError} — please request a new link.
              </p>
            )}
          </div>
        </div>

        {showModal && (
          <SignInModal
            redirectTo={window.location.href}
            clientId={client.id}
            onClose={() => setShowModal(false)}
          />
        )}
      </div>
    )
  }

  // ── Logged in: full admin nav for staff, simple header for clients ──
  const isStaff = role === 'admin' || role === 'editor'

  return (
    <div className="flex flex-col h-screen">
      {isStaff
        ? <AdminAppHeader slug={slug!} />
        : <PortalHeader client={client} />
      }
      <div className="flex-1 overflow-hidden">
        <GalleryView />
      </div>
    </div>
  )
}
