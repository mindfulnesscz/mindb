import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

const LS_URL = 'dc_hub_supabase_url'
const LS_KEY = 'dc_hub_supabase_anon_key'

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
    url: localStorage.getItem(LS_URL) ?? '',
    anonKey: localStorage.getItem(LS_KEY) ?? '',
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
}

function makeClient(): SupabaseClient<Database> | null {
  const { url, anonKey } = getConfig()
  if (!url || !anonKey) return null
  return createClient<Database>(url, anonKey)
}

// Singleton — recreated on page reload after config save
export let supabase = makeClient()

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
