/* Staff sign-in for the admin area. */

import { useState, useRef, useEffect } from 'react'
import { useAuth, type OAuthProvider } from '../../context/AuthContext'
import { OAUTH_PROVIDERS } from '../auth/SignInModal'
import { DCMark } from './DCMark'
import { getConfig } from '../../lib/supabase'

type SignInStep = 'email' | 'checking' | 'error' | 'sending' | 'sent'

export function AdminSignIn() {
  const { checkEmail, sendMagicLink, signInWithProvider, authError, clearAuthError } = useAuth()
  const [step, setStep] = useState<SignInStep>('email')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [oauthBusy, setOauthBusy] = useState<OAuthProvider | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const localDevelopment = /localhost|127\.0\.0\.1/i.test(getConfig().url)

  async function handleOAuth(provider: OAuthProvider) {
    setError(''); clearAuthError(); setOauthBusy(provider)
    const err = await signInWithProvider(provider, window.location.origin)
    if (err) { setError(err); setOauthBusy(null) }  // success redirects away
  }

  useEffect(() => { inputRef.current?.focus() }, [])

  /* No URL parsing here. A failed auth return is resolved at app level (`lib/authReturn.ts`) before
     any session is trusted, and arrives as `authError` — which is what makes it visible at all: this
     component does not render when a session was restored, so the hash it used to read was dropped
     on the floor in exactly the case that mattered. */
  const returnError = authError ? `${authError} — please try again.` : ''

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = email.trim().toLowerCase()
    if (!trimmed) return
    setError(''); clearAuthError(); setStep('checking')

    const type = await checkEmail(trimmed)
    if (type !== 'staff') {
      setError('This area is restricted to Sotto administrators.')
      setStep('error')
      return
    }

    setStep('sending')
    const err = await sendMagicLink(trimmed, undefined, window.location.origin)
    if (err) { setError(err); setStep('email') }
    else setStep('sent')
  }

  const busy = step === 'checking' || step === 'sending'

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-bg px-4">
      <div className="mb-10 text-center">
        <div className="flex justify-center mb-4">
          <DCMark size="lg" />
        </div>
        <h1 className="font-serif text-3xl font-medium text-cosmos-black mb-1">Sotto</h1>
        <p className="font-sans text-sm text-text-muted">Admin access only</p>
      </div>

      <div className="w-full max-w-sm">
        {step === 'sent' ? (
          <div className="border border-cosmos-black rounded-sm p-6" style={{ boxShadow: '4px 4px 0 #161616' }}>
            <p className="font-serif text-lg font-medium text-cosmos-black mb-2">Check your email</p>
            <p className="font-sans text-sm text-text-muted mb-1">
              We sent a magic link to <span className="font-mono text-cosmos-black">{email}</span>
            </p>
            <p className="text-[11px] font-sans text-text-subtle mb-4">
              Open the link, then select Continue to sign in. It expires in 1 hour.
            </p>
            <button
              onClick={() => { setStep('email'); setEmail(''); setError('') }}
              className="text-[11px] font-sans text-text-muted hover:text-cosmos-black underline transition-colors"
            >
              Use a different email
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              {OAUTH_PROVIDERS.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleOAuth(p.id)}
                  disabled={oauthBusy !== null || busy}
                  className="w-full flex items-center justify-center gap-2.5 py-3 text-sm font-sans font-semibold border border-cosmos-black rounded-sm bg-bg text-cosmos-black hover:bg-surface-sunken transition-colors disabled:opacity-50"
                >
                  {p.icon}
                  {oauthBusy === p.id ? 'Redirecting…' : `Continue with ${p.label}`}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[10px] font-sans uppercase tracking-label text-text-muted">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <form onSubmit={handleSubmit} className="space-y-3">
              <input
                ref={inputRef}
                type="email"
                value={email}
                onChange={e => { setEmail(e.target.value); if (step === 'error') { setStep('email'); setError('') } }}
                placeholder="admin@disruptcollective.com"
                required
                disabled={busy}
                className="w-full text-sm font-sans border border-cosmos-black rounded-sm px-4 py-3 bg-bg placeholder:text-text-subtle focus:outline-none transition-colors"
              />
              {(error || returnError) && (
                <p className="text-[11px] font-sans text-signal-error">{error || returnError}</p>
              )}
              <button
                type="submit"
                disabled={busy || !email.trim()}
                className="w-full py-3 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-50 hover:bg-ink-800 transition-colors"
                style={{ boxShadow: '4px 4px 0 #161616' }}
              >
                {busy ? 'Checking…' : 'Continue with email'}
              </button>
              {localDevelopment && (
                <p className="text-[11px] font-sans text-text-muted leading-relaxed">
                  Local development: use <span className="font-mono text-cosmos-black">admin@acme.test</span>,
                  then open <a className="underline" href="http://localhost:54324" target="_blank" rel="noreferrer">Mailpit</a> for the sign-in link.
                </p>
              )}
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
