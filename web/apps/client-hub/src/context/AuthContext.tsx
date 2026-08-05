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
import { configureErrorSink } from '../lib/reportError'
import { useCdnCookie } from '../hooks/useCdnCookie'
import type { ProfileRow } from '@sotto/database'

// Auth logic + types now live in the shared @sotto/auth package. Re-export the
// types so existing importers (e.g. SignInModal) keep resolving them from here.
export type { EmailAuthType, OAuthProvider }

interface AuthContextValue {
  session: Session | null
  profile: ProfileRow | null
  loading: boolean
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

  /* Gated thumbnails and downloads are served by the cdn-gate Worker, which authorizes from a
     cookie rather than from this session. Minting it here, off the access token, means it is in
     place before the gallery's first <img> fires and is re-minted on every token refresh. A no-op
     when VITE_CDN_GATE_URL is unset — see cdnGate.ts on why that is a supported state. */
  useCdnCookie(session?.access_token)

  useEffect(() => {
    if (!supabase || !configured) { setLoading(false); return }

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) fetchProfile(session.user.id)
      else setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) fetchProfile(session.user.id)
      else { setProfile(null); setLoading(false) }
    })

    return () => subscription.unsubscribe()
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
   */
  async function signInWithProvider(
    provider: OAuthProvider,
    redirectTo?: string,
  ): Promise<string | null> {
    if (!supabase) return 'Supabase not configured'
    try {
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

  return (
    <AuthContext.Provider value={{ session, profile, loading, checkEmail, sendMagicLink, signInWithProvider, completeProfile, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
