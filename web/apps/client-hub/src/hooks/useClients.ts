import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Client } from '@sotto/asset-library'
import { MOCK_CLIENTS } from '@sotto/asset-library'
import { fetchClients } from '../services/clientService'
import { isConfigured } from '../lib/supabase'

interface UseClientsResult {
  clients: Client[]
  loading: boolean
  error: string | null
  usingMock: boolean
  reload: () => void
}

/* The client list is small, changes rarely, and is read by four separate views — the admin landing,
   the users tab, and the staff client switcher in two different headers. Under the per-component
   effect this replaces, each of those was its own request; they share one now. */
const CLIENTS_STALE_MS = 5 * 60_000

const EMPTY: Client[] = []

export function useClients(): UseClientsResult {
  const usingMock = !isConfigured()
  const client = useQueryClient()

  const query = useQuery({
    queryKey: ['clients'],
    staleTime: CLIENTS_STALE_MS,
    queryFn: async () => (usingMock ? MOCK_CLIENTS : await fetchClients()),
  })

  return {
    clients: query.data ?? EMPTY,
    loading: query.isPending,
    error: query.error ? (query.error as Error).message : null,
    usingMock,
    /** After a client is created or edited — `AdminLandingPage.handleSaved`. */
    reload: () => { void client.invalidateQueries({ queryKey: ['clients'] }) },
  }
}
