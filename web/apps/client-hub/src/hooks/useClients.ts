import { useState, useEffect } from 'react'
import type { Client } from '@dc-hub/asset-library'
import { MOCK_CLIENTS } from '@dc-hub/asset-library'
import { fetchClients } from '../services/clientService'
import { isConfigured } from '../lib/supabase'

interface UseClientsResult {
  clients: Client[]
  loading: boolean
  error: string | null
  usingMock: boolean
  reload: () => void
}

export function useClients(): UseClientsResult {
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rev, setRev] = useState(0)
  const usingMock = !isConfigured()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    if (usingMock) {
      setClients(MOCK_CLIENTS)
      setLoading(false)
      return
    }

    fetchClients()
      .then(data => {
        if (!cancelled) { setClients(data); setLoading(false) }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [usingMock, rev])

  return { clients, loading, error, usingMock, reload: () => setRev(r => r + 1) }
}
