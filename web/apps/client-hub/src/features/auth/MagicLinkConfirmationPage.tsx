import { useState } from 'react'
import { getConfig } from '../../lib/supabase'
import {
  buildMagicLinkVerificationUrl,
  parseMagicLinkConfirmationFragment,
} from './magicLinkConfirmation'

interface MagicLinkConfirmationPageProps {
  /** Test seams; the route uses the current browser values. */
  fragment?: string
  supabaseUrl?: string
  navigate?: (url: string) => void
}

export default function MagicLinkConfirmationPage({
  fragment = window.location.hash,
  supabaseUrl = getConfig().url,
  navigate = url => window.location.replace(url),
}: MagicLinkConfirmationPageProps = {}) {
  const confirmation = parseMagicLinkConfirmationFragment(fragment)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function handleContinue() {
    if (!confirmation || !supabaseUrl) return
    setBusy(true)
    setError('')
    try {
      navigate(buildMagicLinkVerificationUrl(supabaseUrl, confirmation))
    } catch {
      setBusy(false)
      setError('Sotto could not continue this sign-in. Please request a new email.')
    }
  }

  const invalid = !confirmation
  const unconfigured = !supabaseUrl

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg px-4">
      <div
        className="w-full max-w-md border border-cosmos-black rounded-sm bg-bg p-6"
        style={{ boxShadow: '6px 6px 0 #161616' }}
      >
        <div className="flex items-center gap-2 mb-6">
          <div className="w-6 h-6 rounded-[28%_38%] bg-cosmos-black flex items-center justify-center">
            <span className="text-clear-white text-[10px] font-bold font-sans leading-none">S</span>
          </div>
          <span className="font-sans text-xs font-bold tracking-[0.14em] uppercase text-cosmos-black">
            Sotto
          </span>
        </div>

        <h1 className="font-serif text-2xl font-medium text-cosmos-black mb-2">
          {invalid ? 'This sign-in link is incomplete' : 'Continue signing in'}
        </h1>

        {invalid ? (
          <p className="font-sans text-sm text-text-muted">
            Request a new sign-in email from Sotto and open the link in that message.
          </p>
        ) : unconfigured ? (
          <p className="font-sans text-sm text-text-muted">
            Sotto is not configured for sign-in on this domain. Contact your administrator.
          </p>
        ) : (
          <>
            <p className="font-sans text-sm text-text-muted mb-5">
              Select the button below to finish signing in. If your email provider opened this
              page automatically, your sign-in link has not been used.
            </p>
            {error && <p className="text-[11px] font-sans text-signal-error mb-3">{error}</p>}
            <button
              type="button"
              onClick={handleContinue}
              disabled={busy}
              className="w-full py-2.5 text-sm font-sans font-semibold bg-cosmos-black text-clear-white rounded-sm disabled:opacity-50 hover:bg-ink-800 transition-colors"
              style={{ boxShadow: '4px 4px 0 #161616' }}
            >
              {busy ? 'Continuing…' : 'Continue signing in'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
