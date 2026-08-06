import { createAuthClient, type SottoClient } from '@sotto/auth'

const LS_URL = 'sotto_supabase_url'
const LS_KEY = 'sotto_supabase_anon_key'
/* Read-only fallbacks from before the rename. This path is only used when VITE_SUPABASE_URL/KEY are
   absent — a manually configured browser — and a rename alone would present as "not configured" with
   no hint that the values are still there. Read the old keys, write only the new ones, so the entry
   migrates the first time anything saves. */
const LEGACY_LS_URL = 'dc_hub_supabase_url'
const LEGACY_LS_KEY = 'dc_hub_supabase_anon_key'

export interface SupabaseConfig {
  url: string
  anonKey: string
  fromEnv: boolean
}

export function getConfig(): SupabaseConfig {
  const envUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const envKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

  if (envUrl && envKey) {
    return { url: envUrl, anonKey: envKey, fromEnv: true }
  }

  return {
    url: localStorage.getItem(LS_URL) ?? localStorage.getItem(LEGACY_LS_URL) ?? '',
    anonKey: localStorage.getItem(LS_KEY) ?? localStorage.getItem(LEGACY_LS_KEY) ?? '',
    fromEnv: false,
  }
}

export function saveConfig(url: string, anonKey: string): void {
  localStorage.setItem(LS_URL, url.trim())
  localStorage.setItem(LS_KEY, anonKey.trim())
}

export function clearConfig(): void {
  localStorage.removeItem(LS_URL)
  localStorage.removeItem(LS_KEY)
  localStorage.removeItem(LEGACY_LS_URL)
  localStorage.removeItem(LEGACY_LS_KEY)
}

function makeClient(): SottoClient | null {
  const { url, anonKey } = getConfig()
  if (!url || !anonKey) return null
  /* detectSessionInUrl is OFF deliberately — do not turn it back on. It exchanges the post-redirect
     `?code=` before any of our code runs and reports a *failed* exchange only as the resolved value
     of an internal promise, while keeping the previous session in storage. That is how a failed
     sign-in became "you are looking at the last user's account".
     `lib/authReturn.ts` owns the return instead, and the two must stay in step: with both enabled,
     whichever runs first spends the code and the other fails on an empty verifier. Shared PKCE
     defaults (and the code-verifier same-browser caveat) live in createAuthClient. */
  return createAuthClient({ url, anonKey }, { detectSessionInUrl: false })
}

// Singleton — never reassigned; a config save reloads the page, which rebuilds it.
export const supabase = makeClient()

export function isConfigured(): boolean {
  const { url, anonKey } = getConfig()
  return Boolean(url && anonKey)
}

export async function testConnection(): Promise<{ ok: boolean; error?: string }> {
  const client = makeClient()
  if (!client) return { ok: false, error: 'No credentials configured.' }
  try {
    const { error } = await client.from('clients').select('id').limit(1)
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export function reloadWithNewConfig(url: string, anonKey: string): void {
  saveConfig(url, anonKey)
  window.location.reload()
}
