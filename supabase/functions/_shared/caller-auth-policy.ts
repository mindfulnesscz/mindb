/* Why supabase-js refused the caller's token — the edge-function half of the caller-auth contract.
 *
 * The vocabulary (`session_invalid` vs `not_authenticated`, the messages, which GoTrue codes mean a
 * dead session) is shared with the cdn-gate Worker and the portal in
 * `packages/domain/src/callerAuth.ts`, and that module explains WHY the distinction exists at all.
 * What lives here is only what supabase-js makes necessary.
 *
 * ── The supabase-js problem ───────────────────────────────────────────────────
 * These functions do not read GoTrue's response. They call `auth.getUser()`, and supabase-js
 * INTERCEPTS `session_not_found` and rethrows it as `AuthSessionMissingError` — no code, status 400,
 * "Auth session missing!" — which is byte-for-byte what it throws locally, with no network call at
 * all, when no Authorization header was supplied. So the single most important case (a revoked
 * session on a tab that still looks signed in) is indistinguishable from an anonymous caller by the
 * error alone. (Pinned by the contract test beside this file, which drives the installed client
 * against a stubbed GoTrue; it is what will fail if a future version starts distinguishing them.)
 *
 * What separates them is not the error but the REQUEST: a session token was presented and GoTrue
 * refused to resolve it. Hence the `authHeader` argument.
 */

import {
  callerAuthFailure,
  isDeadSessionAuthCode,
  NOT_AUTHENTICATED,
  SESSION_INVALID,
  type CallerAuthCode,
  type CallerAuthFailureBody,
} from '../../../packages/domain/src/callerAuth.ts';

export interface CallerAuthFailure extends CallerAuthFailureBody {
  /** GoTrue's own code, for logs. Null when the failure carried none — the common case, see above. */
  authCode: string | null;
}

/** Three dot-separated non-empty segments. Enough to tell a session token from an API key sent in
 *  the wrong header (`sb_publishable_…`), which is a caller bug and not an expired session. */
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/** The presented session token, or null if the caller offered no JWT to resolve. */
function bearerJwt(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const match = /^bearer\s+(\S+)$/i.exec(authHeader.trim());
  const token = match?.[1];
  return token && JWT_SHAPE.test(token) ? token : null;
}

function readCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code ? code : null;
}

/** supabase-js's shape for "there is no session behind this call" — including a revoked one. */
function isSessionMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return name === 'AuthSessionMissingError'
    || (typeof message === 'string' && message.toLowerCase().includes('auth session missing'));
}

/**
 * Classify a failed `auth.getUser()`.
 *
 * @param error      whatever supabase-js returned — an `AuthApiError`, an `AuthSessionMissingError`,
 *                   or null when the call produced no user without failing.
 * @param authHeader the caller's raw `Authorization` header, which is what distinguishes a refused
 *                   session token from no session token at all.
 */
export function classifyCallerAuthFailure(
  error: unknown,
  authHeader: string | null | undefined,
): CallerAuthFailure {
  const authCode = readCode(error);
  // No JWT to refuse: nobody is signed in, whatever GoTrue may also have said about it.
  const verdict: CallerAuthCode = !bearerJwt(authHeader)
    ? NOT_AUTHENTICATED
    : isSessionMissing(error) || isDeadSessionAuthCode(authCode)
      ? SESSION_INVALID
      : NOT_AUTHENTICATED;
  return { ...callerAuthFailure(verdict), authCode };
}

/**
 * The 401 body itself. `authCode` is deliberately not in it: GoTrue's vocabulary belongs in logs,
 * and the portal branches on `code`.
 */
export function callerAuthFailureBody(
  error: unknown,
  authHeader: string | null | undefined,
): CallerAuthFailureBody {
  const { code, error: message } = classifyCallerAuthFailure(error, authHeader);
  return { error: message, code };
}
