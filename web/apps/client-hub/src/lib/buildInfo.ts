/* Which build is this, and which backend is it talking to?
 *
 * Derived from the Supabase URL rather than a dedicated VITE_APP_ENV, deliberately. An env-name
 * variable is a second thing to set per deployment, and the failure mode is silent and backwards:
 * forget it on Vercel and production renders as "unknown" — or worse, a staging deploy inherits a
 * stale "production" and reassures you about the exact thing you were checking. The Supabase URL is
 * already set correctly per environment, because nothing works at all if it is wrong. Reading the
 * label off the URL means the badge cannot disagree with the backend it is describing.
 *
 * A project ref we do not recognise degrades to showing the ref itself — still unambiguous, and
 * still enough to tell two deployments apart.
 */

export type EnvTone = 'production' | 'staging' | 'local'

export interface BuildInfo {
  version: string
  label: string
  tone: EnvTone
  backend: string
}

/** Supabase project refs, which identify the backend far more reliably than any label we could set. */
const KNOWN_REFS: Record<string, { label: string; tone: EnvTone }> = {
  knbxyaplaoenrxrpgwcg: { label: 'Production', tone: 'production' },
  tvrxnwbhzborkkkdeyuk: { label: 'Staging', tone: 'staging' },
}

export function projectRef(supabaseUrl: string): string {
  const host = supabaseUrl.trim().replace(/^https?:\/\//i, '').split(/[:/]/)[0] ?? ''
  const [ref] = host.split('.')
  return ref ?? ''
}

export function describeBackend(supabaseUrl: string): { label: string; tone: EnvTone } {
  const url = supabaseUrl.trim()
  if (!url) return { label: 'Not configured', tone: 'staging' }
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url)) {
    return { label: 'Local', tone: 'local' }
  }
  const ref = projectRef(url)
  // Unknown ref: name it rather than guess, and keep the loud tone — never quietly claim production.
  return KNOWN_REFS[ref] ?? { label: ref || 'Unknown', tone: 'staging' }
}

export function buildInfo(supabaseUrl: string): BuildInfo {
  const { label, tone } = describeBackend(supabaseUrl)
  return { version: __APP_VERSION__, label, tone, backend: supabaseUrl }
}
