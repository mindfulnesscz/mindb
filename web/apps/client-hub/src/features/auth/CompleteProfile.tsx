import { useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { INDUSTRY_OPTIONS } from './SignInModal'

const inputCls =
  'w-full text-sm font-sans border border-border rounded-sm px-3 py-2 bg-bg placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors'

/**
 * Shown to an authenticated guest (role `public`) who signed in via OAuth
 * without the magic-link profile form. Collects the same details, then lets
 * them proceed as a guest. Whitelisted / role-holding users never see this.
 */
export default function CompleteProfile({ clientName }: { clientName?: string }) {
  const { completeProfile, signOut } = useAuth()
  const [name, setName]         = useState('')
  const [country, setCountry]   = useState('')
  const [company, setCompany]   = useState('')
  const [industry, setIndustry] = useState('')
  const [consent, setConsent]   = useState(false)
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState('')

  const canSubmit = name.trim() && country.trim() && company.trim() && industry && consent

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSaving(true); setError('')
    const err = await completeProfile({
      name: name.trim(), country: country.trim(), company: company.trim(), industry,
    })
    if (err) { setError(err); setSaving(false) }
    // On success the profile refreshes and the portal renders the gallery.
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg px-4">
      <div
        className="w-full max-w-md bg-bg border border-cosmos-black rounded-sm overflow-hidden"
        style={{ boxShadow: '6px 6px 0 #161616' }}
      >
        <div className="px-6 pt-6 pb-5 border-b border-border">
          <h1 className="font-serif text-xl font-medium text-cosmos-black">Tell us about you</h1>
          <p className="font-sans text-sm text-text-muted mt-1">
            A few details to browse {clientName ? `${clientName}'s` : 'this'} public assets.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-6 space-y-4">
          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">Full name<span className="text-signal-error ml-0.5">*</span></label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Jana Kovářová" required autoFocus className={inputCls} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">Country<span className="text-signal-error ml-0.5">*</span></label>
              <input type="text" value={country} onChange={e => setCountry(e.target.value)} placeholder="Czech Republic" required className={inputCls} />
            </div>
            <div>
              <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">Company<span className="text-signal-error ml-0.5">*</span></label>
              <input type="text" value={company} onChange={e => setCompany(e.target.value)} placeholder="Acme s.r.o." required className={inputCls} />
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-sans font-bold uppercase tracking-label text-text-muted mb-1.5">Industry<span className="text-signal-error ml-0.5">*</span></label>
            <select value={industry} onChange={e => setIndustry(e.target.value)} required className={`${inputCls} cursor-pointer`}>
              <option value="">Select your industry…</option>
              {INDUSTRY_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>

          <label className="flex items-start gap-3 cursor-pointer group">
            <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} required className="mt-0.5 shrink-0 accent-cosmos-black" />
            <span className="text-[11px] font-sans text-text-muted group-hover:text-cosmos-black transition-colors leading-relaxed">
              I agree that my name, company, country, and industry will be stored to provide access to this portal. You can request deletion at any time.
            </span>
          </label>

          {error && <p className="text-[11px] font-sans text-signal-error">{error}</p>}

          <button
            type="submit"
            disabled={saving || !canSubmit}
            className="w-full py-2.5 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-50 hover:bg-ink-800 transition-colors"
            style={canSubmit ? { boxShadow: '4px 4px 0 #161616' } : undefined}
          >
            {saving ? 'Saving…' : 'Continue'}
          </button>

          <button type="button" onClick={signOut} className="w-full text-[11px] font-sans text-text-muted hover:text-cosmos-black underline transition-colors">
            Sign out
          </button>
        </form>
      </div>
    </div>
  )
}
