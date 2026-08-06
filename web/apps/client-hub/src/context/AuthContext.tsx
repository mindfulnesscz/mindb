import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  checkEmailAuth,
  sendMagicLink as sendMagicLinkCore,
  signInWithProvider as signInWithProviderCore,
  signOut as signOutCore,
  type EmailAuthType,
  type OAuthProvider,
} from '@sotto/auth'
import { supabase, isConfigured, getConfig } from '../lib/supabase'
import { resolveAuthReturn } from '../lib/authReturn'
import { configureErrorSink } from '../lib/reportError'
import { configureSessionEndedHandler } from '../lib/edgeFunction'
import { useCdnCookie } from '../hooks/useCdnCookie'
import type { ProfileRow } from '@sotto/database'

// Auth logic + types now live in the shared @sotto/auth package. Re-export the
// types so existing importers (e.g. SignInModal) keep resolving them from here.
export type { EmailAuthType, OAuthProvider }

interface AuthContextValue {
  session: Session | null
  profile: ProfileRow | null
  loading: boolean
  /** Why the last auth return failed, for whichever sign-in surface is on screen. One source: the
   *  sign-in components read it, they do not parse the URL themselves. */
  authError: string | null
  clearAuthError: () => void
  checkEmail: (email: string) => Promise<EmailAuthType>
  sendMagicLink: (email: string, userData?: Record<string, string>, redirectTo?: string) => Promise<string | null>
  signInWithProvider: (provider: OAuthProvider, redirectTo?: string) => Promise<string | null>
  completeProfile: (fields: { name: string; company: string; country: string; industry: string }) => Promise<string | null>
  signOut: () => Promise<void>
}

export interface ProfileFields { name: string; company: string; country: string; industry: string }

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const configured = isConfigured()
  const [session, setSession] = useState<Session | null>(null)

  /* The sink follows the configured backend, so a staging failure lands in staging. Set before the
     session resolves, because a failed sign-in is exactly the error worth capturing. */
  useEffect(() => {
    const { url, anonKey } = getConfig()
    configureErrorSink(url && anonKey
      ? {
          url, anonKey,
          environment: import.meta.env.MODE,
          appVersion: __APP_VERSION__,
          userId: session?.user.id ?? null,
        }
      : null)
  }, [session?.user.id])
  const [profile, setProfile] = useState<ProfileRow | null>(null)
  const [loading, setLoading] = useState(configured)
  const [authError, setAuthError] = useState<string | null>(null)

  /* Gated thumbnails and downloads are served by the cdn-gate Worker, which authorizes from a
     cookie rather than from this session. Minting it here, off the access token, means it is in
     place before the gallery's first <img> fires and is re-minted on every token refresh. A no-op
     when VITE_CDN_GATE_URL is unset — see cdnGate.ts on why that is a supported state. */
  useCdnCookie(session?.access_token)

  /* Resolve the auth return BEFORE the persisted session is trusted, then subscribe.
   *
   * The order is the fix. `getSession()` cannot tell "restored a valid old session" from "just
   * failed to establish a new one", and `onAuthStateChange` replays the current session to every new
   * subscriber as INITIAL_SESSION — so touching either first would render the app around the
   * previous user while the failed return is still unexamined. `resolveAuthReturn` has already
   * dropped that token by the time we get here. */
  useEffect(() => {
    const client = supabase
    if (!client || !configured) { setLoading(false); return }

    let cancelled = false
    let unsubscribe = () => {}

    void (async () => {
      const outcome = await resolveAuthReturn(client, window.location.href)
      if (cancelled) return

      if (outcome.url !== window.location.href) {
        window.history.replaceState(null, '', outcome.url)
      }
      if (outcome.error) setAuthError(outcome.error)

      const { data: { session } } = await client.auth.getSession()
      if (cancelled) return
      setSession(session)
      if (session) fetchProfile(session.user.id)
      else setLoading(false)

      const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
        setSession(session)
        if (session) fetchProfile(session.user.id)
        else { setProfile(null); setLoading(false) }
      })
      unsubscribe = () => subscription.unsubscribe()
    })()

    return () => { cancelled = true; unsubscribe() }
  }, [])

  /* A revoked session is invisible from here: the access token still passes signature checks, so
     reads keep working and nothing in this provider ever learns the session row is gone. The edge
     functions do learn it, and say so — this is what turns that answer into a sign-out instead of a
     portal that shows a signed-in header above "your session is no longer valid".

     Local scope on purpose: the server-side session no longer exists, so a global sign-out is a
     POST with a dead token that fails and leaves the stale token sitting in storage. */
  useEffect(() => {
    const client = supabase
    if (!client) return
    configureSessionEndedHandler(() => { void client.auth.signOut({ scope: 'local' }) })
    return () => configureSessionEndedHandler(null)
  }, [])

  async function fetchProfile(userId: string) {
    if (!supabase) return
    // maybeSingle: no profile row is a normal state (stale session, invite not completed).
    // .single() answers that with an opaque 406 instead of null.
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
    setProfile(data as ProfileRow | null)
    setLoading(false)
  }

  async function checkEmail(email: string): Promise<EmailAuthType> {
    if (!supabase) return 'unknown'
    // Soft-fail to 'unknown' — the modal just falls back to the profile form.
    try {
      return await checkEmailAuth(supabase, email)
    } catch {
      return 'unknown'
    }
  }

  async function sendMagicLink(
    email: string,
    userData?: Record<string, string>,
    redirectTo?: string,
  ): Promise<string | null> {
    if (!supabase) return 'Supabase not configured'
    try {
      await sendMagicLinkCore(supabase, email, {
        emailRedirectTo: redirectTo ?? window.location.origin,
        // Profile fields are descriptive only. Tenant access comes from the server-controlled
        // domain allow-list or a later admin assignment, never caller-supplied signup metadata.
        data: userData,
      })
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  /**
   * OAuth sign-in — no email, so corporate link-scanners (Microsoft Safe Links)
   * can't break it. The provider returns the user's verified email, so the
   * existing domain-whitelist auto-join in handle_new_user maps them to a
   * client. (OAuth can't carry a client_id into user metadata; a first-time
   * user on a non-whitelisted domain gets role 'public' and is assigned by an
   * admin — same as an unknown magic-link user.)
   *
   * Drops any existing token from this browser first (local scope — the point is
   * this browser, not the session's validity elsewhere). A deliberate re-auth
   * must never be able to resolve backwards to the previous user if the return
   * fails; `authReturn` covers the same ground on the way back, and this closes
   * the window in between.
   */
  async function signInWithProvider(
    provider: OAuthProvider,
    redirectTo?: string,
  ): Promise<string | null> {
    if (!supabase) return 'Supabase not configured'
    try {
      await supabase.auth.signOut({ scope: 'local' })
      await signInWithProviderCore(supabase, provider, redirectTo ?? window.location.href)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  /**
   * Fill in an authenticated guest's profile (name/company/country/industry).
   * Used by the portal to collect details from OAuth users who signed in without
   * the magic-link profile form. Keeps their role as-is (guest stays `public`);
   * an admin promotes them if they need client access.
   */
  async function completeProfile(fields: ProfileFields): Promise<string | null> {
    if (!supabase || !session) return 'Not signed in'
    const { error } = await supabase
      .from('profiles')
      .update({
        name:     fields.name,
        company:  fields.company,
        country:  fields.country,
        industry: fields.industry,
        initials: fields.name.replace(/[^A-Za-z ]/g, '').trim().slice(0, 2).toUpperCase(),
      })
      .eq('id', session.user.id)
    if (error) return error.message
    await fetchProfile(session.user.id)
    return null
  }

  async function signOut() {
    if (supabase) await signOutCore(supabase)
  }

  function clearAuthError() { setAuthError(null) }

  return (
    <AuthContext.Provider value={{ session, profile, loading, authError, clearAuthError, checkEmail, sendMagicLink, signInWithProvider, completeProfile, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
