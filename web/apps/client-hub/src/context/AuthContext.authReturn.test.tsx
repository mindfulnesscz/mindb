// @vitest-environment jsdom

/* A failed auth return must never resolve backwards to the previous user.
 *
 * Both cases below were GREEN-as-in-broken before `lib/authReturn.ts`: supabase-js keeps an existing
 * session when a URL login fails, the two components that parsed `error=` out of the hash do not
 * render when a session was restored, and a `?code=` whose exchange fails was reported nowhere the
 * app could see. The visible result was the admin tree, signed in as whoever last used the browser.
 *
 * The assertions are deliberately about what a person would SEE: the sign-in surface, the provider's
 * message, and the absence of the previous user's email.
 */

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const STALE_EMAIL = 'previous@other-tenant.test'

const h = vi.hoisted(() => {
  const state = {
    session: null as unknown,
    profile: null as unknown,
    exchangeError: null as string | null,
  }
  type Handler = (event: string, session: unknown) => void
  const handlers: Handler[] = []

  const client = {
    auth: {
      getSession: async () => ({ data: { session: state.session } }),
      signOut: async () => {
        state.session = null
        for (const fn of handlers) fn('SIGNED_OUT', null)
        return { error: null }
      },
      exchangeCodeForSession: async () =>
        state.exchangeError
          ? { data: { session: null, user: null }, error: { message: state.exchangeError } }
          : { data: { session: state.session, user: null }, error: null },
      onAuthStateChange: (cb: Handler) => {
        handlers.push(cb)
        return { data: { subscription: { unsubscribe: () => { handlers.length = 0 } } } }
      },
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.profile }) }) }),
    }),
  }

  return { state, client, handlers }
})

vi.mock('../lib/supabase', () => ({
  supabase: h.client,
  isConfigured: () => true,
  getConfig: () => ({ url: 'https://tvrxnwbhzborkkkdeyuk.supabase.co', anonKey: 'anon', fromEnv: true }),
}))

const { AuthProvider } = await import('./AuthContext')
const { default: AdminLandingPage } = await import('../features/admin/AdminLandingPage')

/** A valid, previously stored session — a real one, not an expired token. */
function stashStaleSession() {
  h.state.session = { access_token: 'stale-token', user: { id: 'stale-user', email: STALE_EMAIL } }
  /* `member`, so the signed-in tree is the dependency-free "Staff access only" panel — which prints
     the email, making the wrong-user state directly assertable. */
  h.state.profile = { id: 'stale-user', name: 'Previous User', role: 'member', client_id: 'client-a' }
}

function visit(url: string) {
  window.history.replaceState(null, '', url)
}

beforeEach(() => {
  vi.stubGlobal('__APP_VERSION__', '3.2.2-test')
  h.state.session = null
  h.state.profile = null
  h.state.exchangeError = null
  h.handlers.length = 0
  visit('/')
})

describe('a failed auth return over a stale session', () => {
  it('renders the sign-in surface with the provider error, not the previous user', async () => {
    stashStaleSession()
    visit('/#error=access_denied&error_description=The+user+has+denied+access')

    render(<AuthProvider><AdminLandingPage /></AuthProvider>)

    expect(await screen.findByText('Admin access only')).toBeInTheDocument()
    expect(screen.getByText(/The user has denied access/)).toBeInTheDocument()
    expect(screen.queryByText(new RegExp(STALE_EMAIL))).not.toBeInTheDocument()
    expect(screen.queryByText('Staff access only')).not.toBeInTheDocument()
    expect(window.location.hash).toBe('')
  })

  it('renders the sign-in surface when a `?code=` exchange is refused', async () => {
    stashStaleSession()
    h.state.exchangeError = 'invalid request: both auth code and code verifier should be non-empty'
    visit('/?code=abc123')

    render(<AuthProvider><AdminLandingPage /></AuthProvider>)

    expect(await screen.findByText('Admin access only')).toBeInTheDocument()
    expect(screen.getByText(/code verifier/)).toBeInTheDocument()
    expect(screen.queryByText(new RegExp(STALE_EMAIL))).not.toBeInTheDocument()
    expect(window.location.search).toBe('')
  })

  /* The control. A fix that simply stopped trusting storage would pass both cases above and break
     every ordinary page load, so the restored-session path is asserted in the same file. */
  it('still restores a session on an ordinary load', async () => {
    stashStaleSession()
    visit('/')

    render(<AuthProvider><AdminLandingPage /></AuthProvider>)

    expect(await screen.findByText('Staff access only')).toBeInTheDocument()
    expect(screen.getByText(STALE_EMAIL)).toBeInTheDocument()
  })
})
