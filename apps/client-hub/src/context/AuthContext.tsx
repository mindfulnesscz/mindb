import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, isConfigured } from '../lib/supabase'
import type { ProfileRow } from '../lib/database.types'

export type EmailAuthType = 'staff' | 'whitelisted' | 'returning' | 'unknown'

interface AuthContextValue {
  session: Session | null
  profile: ProfileRow | null
  loading: boolean
  checkEmail: (email: string) => Promise<EmailAuthType>
  sendMagicLink: (email: string, userData?: Record<string, string>, redirectTo?: string, clientId?: string) => Promise<string | null>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const configured = isConfigured()
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<ProfileRow | null>(null)
  const [loading, setLoading] = useState(configured)

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
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).single()
    setProfile(data as ProfileRow | null)
    setLoading(false)
  }

  async function checkEmail(email: string): Promise<EmailAuthType> {
    if (!supabase) return 'unknown'
    const { data, error } = await supabase.rpc('check_email_auth', { p_email: email })
    if (error) return 'unknown'
    return (data as EmailAuthType) ?? 'unknown'
  }

  async function sendMagicLink(
    email: string,
    userData?: Record<string, string>,
    redirectTo?: string,
    clientId?: string,
  ): Promise<string | null> {
    if (!supabase) return 'Supabase not configured'
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectTo ?? window.location.origin,
        data: { ...userData, ...(clientId ? { client_id: clientId } : {}) },
      },
    })
    return error?.message ?? null
  }

  async function signOut() {
    await supabase?.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ session, profile, loading, checkEmail, sendMagicLink, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
