import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { callerAuthFailureBody, classifyCallerAuthFailure } from './caller-auth-policy.ts';
import {
  NOT_AUTHENTICATED_MESSAGE,
  SESSION_INVALID_MESSAGE,
} from '../../../packages/domain/src/callerAuth.ts';

/** Shape only — never verified here, and deliberately not a real token. */
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMiLCJzZXNzaW9uX2lkIjoiZ29uZSJ9.sig';
const BEARER = `Bearer ${JWT}`;

/** What supabase-js raises when there is no session behind the call — revoked or absent. */
function sessionMissing() {
  return Object.assign(new Error('Auth session missing!'), { name: 'AuthSessionMissingError', status: 400 });
}

/** A coded refusal: GoTrue's `error_code` surfaces as `code` on an AuthApiError. */
function authApiError(code: string, message = 'refused', status = 401) {
  return Object.assign(new Error(message), { name: 'AuthApiError', code, status });
}

describe('classifyCallerAuthFailure', () => {
  it('names a revoked session when a JWT was presented and no session came back', () => {
    // The case this module exists for: signature-valid token, session row gone.
    expect(classifyCallerAuthFailure(sessionMissing(), BEARER)).toEqual({
      code: 'session_invalid',
      error: SESSION_INVALID_MESSAGE,
      authCode: null,
    });
  });

  it('leaves an anonymous caller plainly unauthenticated on the identical error', () => {
    // Same error object, no header — supabase-js throws this locally before any network call.
    expect(classifyCallerAuthFailure(sessionMissing(), null)).toEqual({
      code: 'not_authenticated',
      error: NOT_AUTHENTICATED_MESSAGE,
      authCode: null,
    });
    expect(classifyCallerAuthFailure(sessionMissing(), '').code).toBe('not_authenticated');
  });

  it('does not treat an API key in the Authorization header as a dead session', () => {
    // `sb_publishable_…` as a Bearer token is a caller bug; signing anyone out would not fix it.
    const failure = classifyCallerAuthFailure(sessionMissing(), 'Bearer sb_publishable_ABC123');
    expect(failure.code).toBe('not_authenticated');
  });

  it.each(['session_not_found', 'session_expired', 'refresh_token_not_found', 'refresh_token_already_used', 'bad_jwt', 'user_not_found'])(
    'treats a coded %s on a presented JWT as a dead session',
    code => {
      expect(classifyCallerAuthFailure(authApiError(code), BEARER).code).toBe('session_invalid');
      expect(classifyCallerAuthFailure(authApiError(code), BEARER).authCode).toBe(code);
    },
  );

  it('does not claim a session ended when the credential was never accepted as a token', () => {
    const refused = classifyCallerAuthFailure(
      authApiError('no_authorization', 'This endpoint requires a valid Bearer token'), BEARER,
    );
    expect(refused.code).toBe('not_authenticated');
    expect(refused.authCode).toBe('no_authorization');
  });

  it('does not sign out a caller whose account is banned — re-authenticating will not help', () => {
    expect(classifyCallerAuthFailure(authApiError('user_banned', 'banned', 403), BEARER).code)
      .toBe('not_authenticated');
  });

  it('handles a null error — getUser can return no user without failing', () => {
    expect(classifyCallerAuthFailure(null, BEARER).code).toBe('not_authenticated');
  });

  it('ignores a non-string code rather than trusting it', () => {
    expect(classifyCallerAuthFailure({ code: 403 }, BEARER).authCode).toBeNull();
  });

  it('reads a lowercase scheme and surrounding whitespace', () => {
    expect(classifyCallerAuthFailure(sessionMissing(), `  bearer ${JWT}  `).code).toBe('session_invalid');
  });
});

describe('callerAuthFailureBody', () => {
  it('is the 401 body: message plus the code the portal branches on, and no GoTrue vocabulary', () => {
    expect(callerAuthFailureBody(sessionMissing(), BEARER)).toEqual({
      error: SESSION_INVALID_MESSAGE,
      code: 'session_invalid',
    });
  });
});

/* The assumption the whole classification rests on, pinned against the installed client rather than
   asserted in a comment: a revoked session and a missing header are the SAME error object, so only
   the request tells them apart. If a future supabase-js starts distinguishing them, this fails and
   the discriminator above can be simplified. */
describe('supabase-js contract', () => {
  function clientReturning(status: number, body: unknown, headers?: Record<string, string>) {
    return createClient('http://local.test', 'anon-key', {
      global: {
        ...(headers ? { headers } : {}),
        fetch: (async () => new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' },
        })) as unknown as typeof fetch,
      },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  it('reports GoTrue session_not_found as a code-less AuthSessionMissingError', async () => {
    const client = clientReturning(
      403,
      { code: 403, error_code: 'session_not_found', msg: 'Session from session_id claim in JWT does not exist' },
      { Authorization: BEARER },
    );
    const { data, error } = await client.auth.getUser();
    expect(data.user).toBeNull();
    expect(error?.name).toBe('AuthSessionMissingError');
    expect((error as { code?: string })?.code).toBeUndefined();
    expect(classifyCallerAuthFailure(error, BEARER).code).toBe('session_invalid');
  });

  it('reports a missing Authorization header the very same way', async () => {
    const { error } = await clientReturning(401, { code: 401, error_code: 'no_authorization', msg: 'nope' })
      .auth.getUser();
    expect(error?.name).toBe('AuthSessionMissingError');
    expect(classifyCallerAuthFailure(error, null).code).toBe('not_authenticated');
  });

  it('still surfaces a code when GoTrue rejects the token itself', async () => {
    const client = clientReturning(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' }, { Authorization: BEARER });
    const { error } = await client.auth.getUser();
    expect((error as { code?: string })?.code).toBe('bad_jwt');
  });
});
