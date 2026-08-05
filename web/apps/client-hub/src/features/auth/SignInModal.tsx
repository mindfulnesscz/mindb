import { useState, useRef, useEffect } from 'react'
import { useAuth, type EmailAuthType, type OAuthProvider } from '../../context/AuthContext'

type Step = 'email' | 'checking' | 'extra' | 'sending' | 'sent'

export const OAUTH_PROVIDERS: { id: OAuthProvider; label: string; icon: React.ReactNode }[] = [
  {
    id: 'azure',
    label: 'Microsoft',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <rect x="1" y="1" width="6.5" height="6.5" fill="#F25022" />
        <rect x="8.5" y="1" width="6.5" height="6.5" fill="#7FBA00" />
        <rect x="1" y="8.5" width="6.5" height="6.5" fill="#00A4EF" />
        <rect x="8.5" y="8.5" width="6.5" height="6.5" fill="#FFB900" />
      </svg>
    ),
  },
  {
    id: 'google',
    label: 'Google',
    icon: (
      <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
        <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.4 5.4 2.5 13.3l7.8 6c1.9-5.6 7.1-9.8 13.7-9.8z" />
        <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.5 3-2.2 5.5-4.7 7.2l7.3 5.7c4.3-4 6.7-9.8 6.7-17.4z" />
        <path fill="#FBBC05" d="M10.3 28.3c-.5-1.4-.8-3-.8-4.3s.3-2.9.8-4.3l-7.8-6C.9 16.9 0 20.3 0 24s.9 7.1 2.5 10.3l7.8-6z" />
        <path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7.3-5.7c-2 1.4-4.7 2.3-7.9 2.3-6.6 0-11.8-4.2-13.7-9.8l-7.8 6C6.4 42.6 14.6 48 24 48z" />
      </svg>
    ),
  },
  {
    id: 'github',
    label: 'GitHub',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
      </svg>
    ),
  },
]

export const INDUSTRY_OPTIONS = [
  'Advertising & Marketing',
  'Architecture & Design',
  'Consumer Goods',
  'E-commerce & Retail',
  'Entertainment & Media',
  'Fashion & Apparel',
  'Finance & Insurance',
  'Food & Beverage',
  'Healthcare & Pharma',
  'Hospitality & Travel',
  'Manufacturing',
  'Non-profit',
  'Real Estate',
  'Sports & Fitness',
  'Technology & Software',
  'Other',
]

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">
        {label}{required && <span className="text-signal-error ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}

const inputCls =
  'w-full text-sm font-sans border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors'

interface SignInModalProps {
  redirectTo?: string
  onClose?: () => void
}

export default function SignInModal({ redirectTo, onClose }: SignInModalProps = {}) {
  const { checkEmail, sendMagicLink, signInWithProvider } = useAuth()

  const [step,     setStep]     = useState<Step>('email')
  const [email,    setEmail]    = useState('')
  const [, setAuthType] = useState<EmailAuthType | null>(null)
  const [error,    setError]    = useState('')
  const [oauthBusy, setOauthBusy] = useState<OAuthProvider | null>(null)

  // Extra fields for unknown users
  const [name,     setName]     = useState('')
  const [country,  setCountry]  = useState('')
  const [company,  setCompany]  = useState('')
  const [industry, setIndustry] = useState('')
  const [consent,  setConsent]  = useState(false)

  const emailRef = useRef<HTMLInputElement>(null)

  useEffect(() => { emailRef.current?.focus() }, [])

  async function handleOAuth(provider: OAuthProvider) {
    setError('')
    setOauthBusy(provider)
    const err = await signInWithProvider(provider, redirectTo)
    // On success the browser redirects to the provider; only errors return here.
    if (err) {
      setError(err)
      setOauthBusy(null)
    }
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = email.trim().toLowerCase()
    if (!trimmed) return
    setError('')
    setStep('checking')

    const type = await checkEmail(trimmed)
    setAuthType(type)

    if (type === 'unknown') {
      setStep('extra')
      return
    }

    // Known user — send link immediately
    await doSend(trimmed, type)
  }

  async function handleExtraSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !country.trim() || !company.trim() || !industry || !consent) return
    setStep('sending')
    await doSend(email.trim().toLowerCase(), 'unknown', {
      name:     name.trim(),
      country:  country.trim(),
      company:  company.trim(),
      industry,
    })
  }

  async function doSend(
    email: string,
    type: EmailAuthType,
    userData?: Record<string, string>,
  ) {
    const err = await sendMagicLink(email, userData, redirectTo)
    if (err) {
      setError(err)
      setStep(type === 'unknown' ? 'extra' : 'email')
    } else {
      setStep('sent')
    }
  }

  const canSubmitExtra =
    name.trim() && country.trim() && company.trim() && industry && consent

  return (
    // Overlay
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ backdropFilter: 'blur(4px)', backgroundColor: 'rgba(22,22,22,0.45)' }}
      onClick={e => { if (e.target === e.currentTarget && onClose) onClose() }}
    >

      {/* Card */}
      <div
        className="w-full max-w-md bg-bg border border-cosmos-black rounded-sm overflow-hidden"
        style={{ boxShadow: '6px 6px 0 #161616' }}
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-5 border-b border-border">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-6 h-6 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center shrink-0">
              <span className="text-clear-white text-[10px] font-bold font-sans leading-none">C</span>
            </div>
            <span className="font-sans text-xs font-bold tracking-[0.14em] uppercase text-cosmos-black">
              SOTTO
            </span>
          </div>
          <h1 className="font-serif text-xl font-medium text-cosmos-black">
            {step === 'sent' ? 'Check your email' : 'Sign in'}
          </h1>
          <p className="font-sans text-sm text-text-muted mt-1">
            {step === 'sent'
              ? `We sent a magic link to ${email}`
              : step === 'extra'
              ? 'Tell us a bit about yourself to get access.'
              : 'Continue with a provider, or use your email.'}
          </p>
        </div>

        {/* Body */}
        <div className="px-6 py-6">

          {/* ── Sent confirmation ── */}
          {step === 'sent' && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 bg-surface-sunken border border-border rounded-sm">
                <svg className="shrink-0 mt-0.5" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M2 4l6 5 6-5M2 4h12v9H2V4Z" />
                </svg>
                <p className="text-sm font-sans text-cosmos-black">
                  Open the link in your email, then select Continue to sign in. It expires in 1 hour.
                  <br />
                  <span className="text-text-muted text-[11px]">If you don't see it, check your spam folder.</span>
                </p>
              </div>
              <button
                onClick={() => { setStep('email'); setEmail(''); setError('') }}
                className="text-[11px] font-sans text-text-muted hover:text-cosmos-black underline transition-colors"
              >
                Use a different email
              </button>
            </div>
          )}

          {/* ── OAuth providers ── */}
          {(step === 'email' || step === 'checking') && (
            <div className="space-y-2 mb-5">
              {OAUTH_PROVIDERS.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleOAuth(p.id)}
                  disabled={oauthBusy !== null || step === 'checking'}
                  className="w-full flex items-center justify-center gap-2.5 py-2.5 text-sm font-sans font-semibold border border-cosmos-black rounded-sm bg-bg text-cosmos-black hover:bg-surface-sunken transition-colors disabled:opacity-50"
                >
                  {p.icon}
                  {oauthBusy === p.id ? 'Redirecting…' : `Continue with ${p.label}`}
                </button>
              ))}
              <div className="flex items-center gap-3 pt-2">
                <span className="h-px flex-1 bg-border" />
                <span className="text-[10px] font-sans uppercase tracking-label text-text-muted">or</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            </div>
          )}

          {/* ── Email step ── */}
          {(step === 'email' || step === 'checking') && (
            <form onSubmit={handleEmailSubmit} className="space-y-4">
              <Field label="Email" required>
                <input
                  ref={emailRef}
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  required
                  disabled={step === 'checking'}
                  className={inputCls}
                />
              </Field>
              {error && <p className="text-[11px] font-sans text-signal-error">{error}</p>}
              <button
                type="submit"
                disabled={step === 'checking' || !email.trim()}
                className="w-full py-2.5 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-50 hover:bg-ink-800 transition-colors"
                style={{ boxShadow: '4px 4px 0 #161616' }}
              >
                {step === 'checking' ? 'Checking…' : 'Continue'}
              </button>
            </form>
          )}

          {/* ── Extra fields (unknown user) ── */}
          {(step === 'extra' || step === 'sending') && (
            <form onSubmit={handleExtraSubmit} className="space-y-4">
              {/* Email (read-only recap) */}
              <div className="flex items-center gap-2 py-2 text-sm font-sans text-text-muted">
                <span className="font-mono">{email}</span>
                <button
                  type="button"
                  onClick={() => { setStep('email'); setError('') }}
                  className="text-[11px] underline hover:text-cosmos-black transition-colors"
                >
                  change
                </button>
              </div>

              <Field label="Full name" required>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Jana Kovářová"
                  required
                  autoFocus
                  className={inputCls}
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Country" required>
                  <input
                    type="text"
                    value={country}
                    onChange={e => setCountry(e.target.value)}
                    placeholder="Czech Republic"
                    required
                    className={inputCls}
                  />
                </Field>
                <Field label="Company" required>
                  <input
                    type="text"
                    value={company}
                    onChange={e => setCompany(e.target.value)}
                    placeholder="Acme s.r.o."
                    required
                    className={inputCls}
                  />
                </Field>
              </div>

              <Field label="Industry" required>
                <select
                  value={industry}
                  onChange={e => setIndustry(e.target.value)}
                  required
                  className={`${inputCls} cursor-pointer`}
                >
                  <option value="">Select your industry…</option>
                  {INDUSTRY_OPTIONS.map(o => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </Field>

              {/* GDPR consent */}
              <label className="flex items-start gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={e => setConsent(e.target.checked)}
                  required
                  className="mt-0.5 shrink-0 accent-cosmos-black"
                />
                <span className="text-[11px] font-sans text-text-muted group-hover:text-cosmos-black transition-colors leading-relaxed">
                  I agree that my name, company, country, and industry will be stored
                  to provide access to this portal. You can request deletion at any time.
                </span>
              </label>

              {error && <p className="text-[11px] font-sans text-signal-error">{error}</p>}

              <button
                type="submit"
                disabled={step === 'sending' || !canSubmitExtra}
                className="w-full py-2.5 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-50 hover:bg-ink-800 transition-colors"
                style={canSubmitExtra ? { boxShadow: '4px 4px 0 #161616' } : undefined}
              >
                {step === 'sending' ? 'Sending…' : 'Send magic link'}
              </button>
            </form>
          )}

        </div>
      </div>
    </div>
  )
}
