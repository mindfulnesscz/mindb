/* The /auth route's refusals.
 *
 * Only the refusals: minting a cookie is covered by token.test.ts, and this route's remaining job is
 * to tell a caller WHICH kind of "no" it got. That distinction is load-bearing — `useCdnCookie`
 * renews on a timer for as long as the tab is open, so a revoked session that reads as an ordinary
 * refusal becomes a permanently blank gallery instead of a sign-out.
 *
 * Plain node, no workerd: /auth touches neither the R2 binding nor the cache.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './index';

const env = {
  GATED: {} as R2Bucket,
  CDN_COOKIE_SECRET: 'secret-secret-secret-secret-secret',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  COOKIE_DOMAIN: '.example.com',
  ALLOWED_ORIGINS: 'https://portal.example.com',
} satisfies Env;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

/** GoTrue's own refusal shape — `error_code` in the body, which this route reads directly. */
function gotrueRefuses(status: number, errorCode: string) {
  return vi.fn(async () => new Response(JSON.stringify({ code: status, error_code: errorCode, msg: 'no' }), {
    status, headers: { 'Content-Type': 'application/json' },
  }));
}

function authRequest(authorization?: string): Request {
  return new Request('https://files.example.com/auth', {
    method: 'POST',
    headers: authorization ? { Authorization: authorization } : {},
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('/auth refusals', () => {
  it('tells a revoked session to sign in again', async () => {
    // The case the whole contract exists for: signature-valid token, session row gone.
    vi.stubGlobal('fetch', gotrueRefuses(403, 'session_not_found'));
    const res = await worker.fetch(authRequest('Bearer a.b.c'), env, ctx);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      code: 'session_invalid',
      error: expect.stringMatching(/sign in again/i),
    });
  });

  it('does not tell an anonymous caller their session ended', async () => {
    // No Authorization header: nothing was presented, so nothing can have expired.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await worker.fetch(authRequest(), env, ctx);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ code: 'not_authenticated', error: 'Not authenticated' });
    expect(fetchSpy).not.toHaveBeenCalled(); // refused before spending a round trip
  });

  it('does not sign anyone out over a credential GoTrue never accepted as a token', async () => {
    vi.stubGlobal('fetch', gotrueRefuses(401, 'no_authorization'));
    const res = await worker.fetch(authRequest('Bearer sb_publishable_ABC'), env, ctx);
    expect((await res.json() as { code: string }).code).toBe('not_authenticated');
  });

  it('survives a refusal that is not JSON', async () => {
    // A proxy's HTML error page must still produce a well-formed answer, not a crash.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })));
    const res = await worker.fetch(authRequest('Bearer a.b.c'), env, ctx);
    expect(res.status).toBe(401);
    expect((await res.json() as { code: string }).code).toBe('not_authenticated');
  });

  it('does not read a 200 with no user id as an ended session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    const res = await worker.fetch(authRequest('Bearer a.b.c'), env, ctx);
    expect((await res.json() as { code: string }).code).toBe('not_authenticated');
  });

  it('still reports an unprovisioned gate as 503 rather than a refusal', async () => {
    // "Not configured yet" must never read as "you are not allowed" — it is fixed somewhere else.
    const res = await worker.fetch(authRequest('Bearer a.b.c'), { ...env, CDN_COOKIE_SECRET: '' }, ctx);
    expect(res.status).toBe(503);
  });
});
