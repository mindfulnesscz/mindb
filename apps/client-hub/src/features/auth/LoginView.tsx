import { useState } from 'react'
import { useAuth } from '../../context/AuthContext'

export default function LoginView() {
  const { signIn } = useAuth()
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const err = await signIn(email, password)
    if (err) { setError(err); setLoading(false) }
    // on success AuthContext updates session → App re-renders to main app
  }

  return (
    <div className="min-h-full flex items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">

        <div className="flex items-center gap-2 mb-10 justify-center">
          <div className="w-8 h-8 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center">
            <span className="text-clear-white text-[11px] font-bold font-sans leading-none">C</span>
          </div>
          <span className="font-sans text-sm font-bold tracking-[0.14em] uppercase text-cosmos-black">
            DC HUB
          </span>
        </div>

        <div className="border border-cosmos-black rounded-sm" style={{ boxShadow: '4px 4px 0 #161616' }}>
          <div className="px-6 pt-6 pb-5 border-b border-border">
            <h1 className="font-serif text-xl font-medium text-cosmos-black">Sign in</h1>
            <p className="font-sans text-sm text-text-muted mt-1">Client asset portal</p>
          </div>

          <form onSubmit={handleSubmit} className="px-6 py-6 space-y-4">
            <div>
              <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoFocus
                placeholder="you@example.com"
                className="w-full text-sm font-sans border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors"
              />
            </div>

            <div>
              <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                className="w-full text-sm font-sans border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors"
              />
            </div>

            {error && (
              <p className="text-[11px] font-sans text-signal-error">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-50 hover:bg-ink-800 transition-colors"
              style={{ boxShadow: '4px 4px 0 #161616' }}
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

      </div>
    </div>
  )
}
