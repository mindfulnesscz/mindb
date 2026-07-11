import { useState } from 'react'
import { getConfig, testConnection, reloadWithNewConfig, clearConfig, isConfigured } from '../../lib/supabase'

const NOTIF_PREFS = [
  { key: 'digest',    label: 'Weekly activity digest',   description: 'A weekly summary of activity on assets relevant to you.' },
  { key: 'comments',  label: 'Comment notifications',    description: 'Get notified when someone comments on an asset.' },
  { key: 'approvals', label: 'Approval requests',        description: 'Get notified when an asset is awaiting your decision.' },
]

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`w-9 h-5 rounded-pill relative shrink-0 transition-colors duration-base ${
        checked ? 'bg-cosmos-black' : 'bg-gray-300'
      }`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 bg-clear-white rounded-pill transition-transform duration-base ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-4">
      {children}
    </p>
  )
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`border border-border rounded-sm overflow-hidden ${className}`}>
      {children}
    </div>
  )
}

// ── Supabase connection section ────────────────────────────────

function ConnectionSection() {
  const cfg = getConfig()
  const configured = isConfigured()

  const [url, setUrl]       = useState(cfg.fromEnv ? '' : cfg.url)
  const [key, setKey]       = useState('')
  const [keyVisible, setKeyVisible] = useState(false)
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [errMsg, setErrMsg] = useState('')

  async function handleTest() {
    setStatus('testing')
    setErrMsg('')
    const result = await testConnection()
    setStatus(result.ok ? 'ok' : 'error')
    if (!result.ok) setErrMsg(result.error ?? 'Connection failed.')
  }

  function handleSave() {
    if (!url.trim() || !key.trim()) return
    reloadWithNewConfig(url.trim(), key.trim())
  }

  function handleDisconnect() {
    clearConfig()
    window.location.reload()
  }

  return (
    <section className="mb-10">
      <SectionLabel>Workspace connection</SectionLabel>

      {/* Status banner */}
      <div className={`flex items-center gap-2 px-4 py-3 mb-4 rounded-sm border text-sm font-sans ${
        configured
          ? 'bg-surface border-border text-cosmos-black'
          : 'bg-surface-sunken border-border text-text-muted'
      }`}>
        <span className={`w-2 h-2 rounded-full shrink-0 ${configured ? 'bg-signal-success' : 'bg-gray-300'}`} />
        {configured
          ? (<span><strong>Connected</strong> — {cfg.fromEnv ? 'credentials loaded from environment variables' : cfg.url}</span>)
          : <span>Not connected — enter your Supabase project URL and anon key below.</span>
        }
        {configured && !cfg.fromEnv && (
          <button
            onClick={handleDisconnect}
            className="ml-auto text-[11px] font-sans text-text-muted hover:text-cosmos-black underline transition-colors"
          >
            Disconnect
          </button>
        )}
      </div>

      {/* Config form — shown only when credentials are NOT coming from env */}
      {!cfg.fromEnv && (
        <Card>
          <div className="p-5 space-y-4">
            {/* URL */}
            <div>
              <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
                Project URL
              </label>
              <input
                type="url"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://xxxxxxxxxxxxxxxxxxxx.supabase.co"
                className="w-full text-sm font-sans border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors font-mono"
              />
            </div>

            {/* Public API key */}
            <div>
              <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
                Public API key
              </label>
              <div className="relative">
                <input
                  type={keyVisible ? 'text' : 'password'}
                  value={key}
                  onChange={e => setKey(e.target.value)}
                  placeholder="eyJhbGci…"
                  className="w-full text-sm font-sans border border-border rounded-sm px-3 py-2 pr-10 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors font-mono"
                />
                <button
                  type="button"
                  onClick={() => setKeyVisible(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-sans text-text-muted hover:text-cosmos-black transition-colors"
                >
                  {keyVisible ? 'hide' : 'show'}
                </button>
              </div>
              <p className="text-[11px] font-sans text-text-subtle mt-1">
                Use the <strong>anon / public</strong> key — not the secret service_role key.
                Find it in Project → Settings → API → "anon public".
              </p>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={handleSave}
                disabled={!url.trim() || !key.trim()}
                className="px-4 py-2 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-40 hover:bg-ink-800 transition-colors"
                style={url.trim() && key.trim() ? { boxShadow: '4px 4px 0 #161616' } : undefined}
              >
                Save &amp; reload
              </button>
              <button
                onClick={handleTest}
                disabled={status === 'testing' || !configured}
                className="px-4 py-2 text-sm font-sans border border-border rounded-sm text-cosmos-black hover:border-cosmos-black disabled:opacity-40 transition-colors"
              >
                {status === 'testing' ? 'Testing…' : 'Test connection'}
              </button>

              {status === 'ok' && (
                <span className="text-[11px] font-sans text-signal-success font-medium">✓ Connected</span>
              )}
              {status === 'error' && (
                <span className="text-[11px] font-sans text-signal-error">{errMsg}</span>
              )}
            </div>
          </div>

          {/* Env var hint */}
          <div className="border-t border-border px-5 py-3 bg-surface-sunken">
            <p className="text-[11px] font-sans text-text-muted">
              For production, set <code className="font-mono bg-gray-150 px-1 rounded-chip">VITE_SUPABASE_URL</code> and{' '}
              <code className="font-mono bg-gray-150 px-1 rounded-chip">VITE_SUPABASE_ANON_KEY</code> as environment
              variables — they take precedence over the form above.
            </p>
          </div>
        </Card>
      )}
    </section>
  )
}

// ── Notifications section ──────────────────────────────────────

function NotificationsSection() {
  const [prefs, setPrefs] = useState<Record<string, boolean>>({
    digest: true, comments: true, approvals: false,
  })

  return (
    <section className="mb-10">
      <SectionLabel>Notifications</SectionLabel>
      <Card>
        {NOTIF_PREFS.map((pref, i) => (
          <label
            key={pref.key}
            className={`flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-surface-sunken transition-colors ${
              i < NOTIF_PREFS.length - 1 ? 'border-b border-border' : ''
            }`}
          >
            <div className="pr-8">
              <p className="text-sm font-sans font-medium text-cosmos-black">{pref.label}</p>
              <p className="text-[11px] font-sans text-text-muted mt-0.5">{pref.description}</p>
            </div>
            <Toggle
              checked={prefs[pref.key]}
              onChange={() => setPrefs(p => ({ ...p, [pref.key]: !p[pref.key] }))}
            />
          </label>
        ))}
      </Card>
    </section>
  )
}

// ── Main view ─────────────────────────────────────────────────

export default function SettingsView() {
  return (
    <div className="max-w-[600px] mx-auto px-5 py-8">
      <h1 className="font-serif text-2xl font-medium text-cosmos-black tracking-tight mb-8">
        Settings
      </h1>
      <ConnectionSection />
      <NotificationsSection />
    </div>
  )
}
