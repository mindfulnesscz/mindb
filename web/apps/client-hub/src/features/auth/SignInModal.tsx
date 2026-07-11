import { useState, useRef, useEffect } from 'react'
import { useAuth, type EmailAuthType } from '../../context/AuthContext'

type Step = 'email' | 'checking' | 'extra' | 'sending' | 'sent'

const INDUSTRY_OPTIONS = [
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
  clientId?: string     // portal's client id — stored on the new user's profile
  onClose?: () => void
}

export default function SignInModal({ redirectTo, clientId, onClose }: SignInModalProps = {}) {
  const { checkEmail, sendMagicLink } = useAuth()

  const [step,     setStep]     = useState<Step>('email')
  const [email,    setEmail]    = useState('')
  const [authType, setAuthType] = useState<EmailAuthType | null>(null)
  const [error,    setError]    = useState('')

  // Extra fields for unknown users
  const [name,     setName]     = useState('')
  const [country,  setCountry]  = useState('')
  const [company,  setCompany]  = useState('')
  const [industry, setIndustry] = useState('')
  const [consent,  setConsent]  = useState(false)

  const emailRef = useRef<HTMLInputElement>(null)

  useEffect(() => { emailRef.current?.focus() }, [])

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
    const err = await sendMagicLink(email, userData, redirectTo, clientId)
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
              DC HUB
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
              : 'Enter your email to receive a magic link.'}
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
                  Click the link in your email to sign in. It expires in 1 hour.
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
