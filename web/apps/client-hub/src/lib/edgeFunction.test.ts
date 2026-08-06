import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureSessionEndedHandler, edgeFunctionError } from './edgeFunction'

/** What `functions.invoke` hands back: a generic error with the real response on `context`. */
function invokeError(status: number, body: unknown): Error {
  return Object.assign(new Error('Edge Function returned a non-2xx status code'), {
    context: new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  })
}

afterEach(() => configureSessionEndedHandler(null))

describe('edgeFunctionError', () => {
  it('returns the function\'s own message instead of the generic one', async () => {
    const message = 'Storage not provisioned — missing R2_GATED_BUCKET'
    expect(await edgeFunctionError(invokeError(503, { error: message }))).toBe(message)
  })

  it('ends the session when the function says it is no longer valid', async () => {
    const ended = vi.fn()
    configureSessionEndedHandler(ended)
    const message = await edgeFunctionError(
      invokeError(401, { error: 'Your session is no longer valid. Sign out and sign in again.', code: 'session_invalid' }),
    )
    expect(ended).toHaveBeenCalledOnce()
    expect(message).toContain('no longer valid')
  })

  it('leaves the session alone for an ordinary 401', async () => {
    // An anonymous caller, or a key refused as a Bearer token — signing the operator out of a
    // working session over either would be its own bug.
    const ended = vi.fn()
    configureSessionEndedHandler(ended)
    await edgeFunctionError(invokeError(401, { error: 'Not authenticated', code: 'not_authenticated' }))
    expect(ended).not.toHaveBeenCalled()
  })

  it('leaves the session alone for a 403 the caller simply lacks the role for', async () => {
    const ended = vi.fn()
    configureSessionEndedHandler(ended)
    await edgeFunctionError(invokeError(403, { error: 'CDN garbage collection is for super admins only.' }))
    expect(ended).not.toHaveBeenCalled()
  })

  it('is null-safe on a failure that carries no response — a network error', async () => {
    expect(await edgeFunctionError(new Error('Failed to send a request to the Edge Function'))).toBeNull()
    expect(await edgeFunctionError(undefined)).toBeNull()
  })

  it('survives a non-JSON body rather than masking the original failure', async () => {
    const error = Object.assign(new Error('boom'), {
      context: new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    })
    expect(await edgeFunctionError(error)).toBeNull()
  })
})
