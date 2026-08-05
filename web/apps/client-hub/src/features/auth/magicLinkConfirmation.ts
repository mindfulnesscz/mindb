export interface MagicLinkConfirmation {
  tokenHash: string
  redirectTo: string
}

const TOKEN_PREFIX = 'token_hash='
const REDIRECT_MARKER = '&redirect_to='

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Read the inert values carried by the custom magic-link email.
 *
 * The redirect is deliberately parsed as "everything after the marker" rather
 * than with URLSearchParams: an unescaped RedirectTo can itself contain query
 * parameters, and those must survive all the way back to the portal. The values
 * live in the fragment so they are not sent to the confirmation-page server.
 */
export function parseMagicLinkConfirmationFragment(
  fragment: string,
): MagicLinkConfirmation | null {
  const value = fragment.startsWith('#') ? fragment.slice(1) : fragment
  if (!value.startsWith(TOKEN_PREFIX)) return null

  const markerIndex = value.indexOf(REDIRECT_MARKER)
  if (markerIndex === -1) return null

  const tokenHash = decode(value.slice(TOKEN_PREFIX.length, markerIndex))
  const redirectTo = decode(value.slice(markerIndex + REDIRECT_MARKER.length))
  if (!tokenHash || !redirectTo || !isHttpUrl(redirectTo)) return null

  return { tokenHash, redirectTo }
}

/** Construct the one-time Supabase URL only in response to the user's click. */
export function buildMagicLinkVerificationUrl(
  supabaseUrl: string,
  confirmation: MagicLinkConfirmation,
): string {
  if (!isHttpUrl(supabaseUrl)) throw new Error('Invalid Supabase URL')

  const verifyUrl = new URL('/auth/v1/verify', supabaseUrl)
  verifyUrl.searchParams.set('token', confirmation.tokenHash)
  verifyUrl.searchParams.set('type', 'email')
  verifyUrl.searchParams.set('redirect_to', confirmation.redirectTo)
  return verifyUrl.toString()
}
