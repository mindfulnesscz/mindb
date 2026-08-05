import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import type { Role, Client } from '@sotto/asset-library'
import { MOCK_CLIENTS } from '@sotto/asset-library'
import { supabase, isConfigured } from '../lib/supabase'
import { toClient } from '../services/clientService'
import type { ClientRow } from '@sotto/database'
import { asRole } from '../services/userService'
import { useAuth } from './AuthContext'

interface RoleContextValue {
  role: Role
  setRole: (role: Role) => void   // no-op in auth mode
  activeClient: Client | null
  setActiveClient: (client: Client | null) => void
  user: { name: string; initials: string }
}

const RoleContext = createContext<RoleContextValue | null>(null)

const DEMO_USERS: Record<Role, { name: string; initials: string }> = {
  public:      { name: 'Guest',       initials: 'G'  },
  member:      { name: 'Jana K.',     initials: 'JK' },
  editor:      { name: 'Petr Mucha',  initials: 'PM' },
  admin:       { name: 'Petr Mucha',  initials: 'PM' },
  super_admin: { name: 'Petr Mucha',  initials: 'PM' },
}

export function RoleProvider({ children }: { children: ReactNode }) {
  const configured = isConfigured()
  const { profile } = useAuth()

  const [demoRole,     setDemoRole]     = useState<Role>('editor')
  const [activeClient, setActiveClient] = useState<Client | null>(
    configured ? null : MOCK_CLIENTS[0],
  )

  const role: Role = configured
    ? asRole(profile?.role ?? 'public')
    : demoRole
  const user = configured && profile
    ? { name: profile.name, initials: profile.initials }
    : DEMO_USERS[demoRole]

  /* `activeClient` decides which client's assets the gallery lists, and it had TWO writers racing
     to set it: this effect, from the signed-in user's own profile, and ClientPortalPage, from the
     slug in the URL. Whichever network round-trip finished last won.

     The visible result was a portal showing one client's branding over another client's content —
     open /dc as a member of another tenant and you might get their assets under the DC header. Not
     a data leak (RLS still returns only what the viewer may see, and the pgTAP suite pins that),
     but it reads exactly like one, and for staff — who legitimately see every client — it is worse
     than cosmetic: you could set visibility on the wrong client's assets believing you were
     somewhere else.

     It stayed hidden while every asset was `perm: 'public'`, because then both portals listed the
     same everything and no scoping error could show. Tightening the levels is what surfaced it.

     The URL wins. An explicit choice — a portal route, or a staff client switch — is authoritative,
     and this profile default only fills in when nothing has chosen yet. The ref is re-checked
     INSIDE the callback as well as before the request: the whole failure was a late response
     landing on top of a decision made while it was in flight. */
  const clientChosen = useRef(false)

  const chooseClient = useCallback((client: Client | null) => {
    clientChosen.current = true
    setActiveClient(client)
  }, [])

  useEffect(() => {
    if (!configured || !profile?.client_id || !supabase) return
    if (clientChosen.current) return
    supabase
      .from('clients')
      .select('*')
      .eq('id', profile.client_id)
      .maybeSingle()
      .then(({ data }) => {
        if (data && !clientChosen.current) setActiveClient(toClient(data as ClientRow))
      })
  }, [profile?.client_id])

  return (
    <RoleContext.Provider value={{
      role,
      setRole:       configured ? () => {} : setDemoRole,
      activeClient,
      // Every caller goes through chooseClient, so any deliberate selection — the portal route,
      // the staff client switcher — marks itself authoritative and the profile default stands down.
      setActiveClient: chooseClient,
      user,
    }}>
      {children}
    </RoleContext.Provider>
  )
}

export function useRole() {
  const ctx = useContext(RoleContext)
  if (!ctx) throw new Error('useRole must be used inside RoleProvider')
  return ctx
}
