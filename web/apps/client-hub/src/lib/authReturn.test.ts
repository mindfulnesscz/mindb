import { describe, expect, it, vi } from 'vitest'
import { cleanAuthUrl, parseAuthReturn, resolveAuthReturn } from './authReturn'
import type { SottoClient } from '@sotto/auth'

const ORIGIN = 'https://hub.disruptcollective.com'

describe('parseAuthReturn', () => {
  it('reads a provider denial out of the hash', () => {
    expect(parseAuthReturn(
      `${ORIGIN}/acme#error=access_denied&error_code=403&error_description=The+user+has+denied+access`,
    )).toEqual({ kind: 'error', message: 'The user has denied access' })
  })

  it('reads an error out of the query too — GoTrue uses both', () => {
    expect(parseAuthReturn(
      `${ORIGIN}/acme?error=server_error&error_description=Unable+to+exchange+external+code`,
    )).toEqual({ kind: 'error', message: 'Unable to exchange external code' })
  })

  it('falls back to the machine-readable fields when there is no description', () => {
    expect(parseAuthReturn(`${ORIGIN}/#error_code=otp_expired`))
      .toEqual({ kind: 'error', message: 'otp_expired' })
    expect(parseAuthReturn(`${ORIGIN}/#error=access_denied`))
      .toEqual({ kind: 'error', message: 'access_denied' })
  })

  it('reports the PKCE code', () => {
    expect(parseAuthReturn(`${ORIGIN}/acme?code=abc123&entity=Sofa`))
      .toEqual({ kind: 'code', code: 'abc123' })
  })

  /* A URL carrying both is a failed return that happens to still have a code in it. Exchanging it
     would either fail anyway or, worse, succeed and mask the error. */
  it('prefers the error when a URL carries both', () => {
    expect(parseAuthReturn(`${ORIGIN}/acme?code=abc123&error=server_error`))
      .toEqual({ kind: 'error', message: 'server_error' })
  })

  it('says nothing for an ordinary page load', () => {
    expect(parseAuthReturn(`${ORIGIN}/acme?entity=Sofa&type=product#gallery`))
      .toEqual({ kind: 'none' })
    expect(parseAuthReturn('not-a-url')).toEqual({ kind: 'none' })
  })
})

describe('cleanAuthUrl', () => {
  it('keeps the filters and drops the auth params', () => {
    expect(cleanAuthUrl(`${ORIGIN}/acme?code=abc123&entity=Sofa&type=product`))
      .toBe(`${ORIGIN}/acme?entity=Sofa&type=product`)
  })

  /* `type` is FILTER_PARAMS.entityTypes, not GoTrue's redirect `type`. Stripping it would wipe half
     the view an expired magic link was meant to return the recipient to. */
  it('leaves `type` alone — it is a gallery filter, not an auth param', () => {
    expect(cleanAuthUrl(`${ORIGIN}/acme?type=product&error=server_error`))
      .toBe(`${ORIGIN}/acme?type=product`)
  })

  it('strips an auth hash', () => {
    expect(cleanAuthUrl(`${ORIGIN}/acme?entity=Sofa#error=access_denied&error_description=nope`))
      .toBe(`${ORIGIN}/acme?entity=Sofa`)
  })

  it('leaves a hash that is not ours', () => {
    expect(cleanAuthUrl(`${ORIGIN}/acme?code=abc123#gallery`))
      .toBe(`${ORIGIN}/acme#gallery`)
  })
})

// ── resolveAuthReturn ─────────────────────────────────────────

function stubClient(exchange: () => Promise<{ error: { message: string } | null }>) {
  const signOut = vi.fn(async () => ({ error: null }))
  const exchangeCodeForSession = vi.fn(exchange)
  return {
    client: { auth: { signOut, exchangeCodeForSession } } as unknown as SottoClient,
    signOut,
    exchangeCodeForSession,
  }
}

describe('resolveAuthReturn', () => {
  it('does nothing at all on an ordinary load', async () => {
    const { client, signOut, exchangeCodeForSession } = stubClient(async () => ({ error: null }))
    const href = `${ORIGIN}/acme?entity=Sofa`

    expect(await resolveAuthReturn(client, href)).toEqual({ error: null, url: href })
    expect(signOut).not.toHaveBeenCalled()
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
  })

  /* The heart of the bug: the stale token has to go, or the caller restores it and renders the app
     around whoever last used this browser. */
  it('drops the local session when the return carries an error', async () => {
    const { client, signOut } = stubClient(async () => ({ error: null }))

    const outcome = await resolveAuthReturn(
      client,
      `${ORIGIN}/acme?entity=Sofa#error=access_denied&error_description=Denied`,
    )

    expect(outcome).toEqual({ error: 'Denied', url: `${ORIGIN}/acme?entity=Sofa` })
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('exchanges a code and leaves the session in place on success', async () => {
    const { client, signOut, exchangeCodeForSession } = stubClient(async () => ({ error: null }))

    const outcome = await resolveAuthReturn(client, `${ORIGIN}/acme?code=abc123&entity=Sofa`)

    expect(exchangeCodeForSession).toHaveBeenCalledWith('abc123')
    expect(outcome).toEqual({ error: null, url: `${ORIGIN}/acme?entity=Sofa` })
    expect(signOut).not.toHaveBeenCalled()
  })

  it('drops the local session when the exchange is refused', async () => {
    const { client, signOut } = stubClient(async () => ({
      error: { message: 'invalid request: both auth code and code verifier should be non-empty' },
    }))

    const outcome = await resolveAuthReturn(client, `${ORIGIN}/acme?code=abc123`)

    expect(outcome.error).toMatch(/code verifier/)
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('drops the local session when the exchange throws', async () => {
    const { client, signOut } = stubClient(async () => { throw new Error('network down') })

    expect(await resolveAuthReturn(client, `${ORIGIN}/acme?code=abc123`))
      .toEqual({ error: 'network down', url: `${ORIGIN}/acme` })
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' })
  })
})
