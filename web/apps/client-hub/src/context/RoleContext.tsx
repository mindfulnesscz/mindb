import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import type { Role, Client } from '@dc-hub/asset-library'
import { MOCK_CLIENTS } from '@dc-hub/asset-library'
import { supabase, isConfigured } from '../lib/supabase'
import { toClient } from '../services/clientService'
import type { ClientRow } from '../lib/database.types'
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
  public:  { name: 'Guest',       initials: 'G'  },
  member:  { name: 'Jana K.',     initials: 'JK' },
  editor:  { name: 'Petr Mucha',  initials: 'PM' },
  admin:   { name: 'Petr Mucha',  initials: 'PM' },
}

export function RoleProvider({ children }: { children: ReactNode }) {
  const configured = isConfigured()
  const { profile } = useAuth()

  const [demoRole,     setDemoRole]     = useState<Role>('editor')
  const [activeClient, setActiveClient] = useState<Client | null>(
    configured ? null : MOCK_CLIENTS[0],
  )

  const role: Role = configured ? ((profile?.role as Role) ?? 'public') : demoRole
  const user = configured && profile
    ? { name: profile.name, initials: profile.initials }
    : DEMO_USERS[demoRole]

  // Auto-set activeClient from profile when a client user logs in
  useEffect(() => {
    if (!configured || !profile?.client_id || !supabase) return
    supabase
      .from('clients')
      .select('*')
      .eq('id', profile.client_id)
      .single()
      .then(({ data }) => {
        if (data) setActiveClient(toClient(data as ClientRow))
      })
  }, [profile?.client_id])

  return (
    <RoleContext.Provider value={{
      role,
      setRole:       configured ? () => {} : setDemoRole,
      activeClient,
      setActiveClient,
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
