/* What a backend says when it will not accept the caller's session token — the wire contract.
 *
 * Three independent backends resolve a caller against GoTrue: the Supabase edge functions, the
 * cdn-gate Worker's `/auth` route, and (indirectly) anything else that validates an access token.
 * The portal acts on their answer, and there is exactly one answer it can act on: "this session is
 * finished, sign in again". So the vocabulary has to be one thing, not three.
 *
 * ── Why this matters more than the usual duplication ─────────────────────────
 * An access token stays signature-valid and unexpired after its session row is revoked — by a
 * password change, a sign-out in another tab, or a reset database. The edge gateway forwards it and
 * PostgREST keeps serving reads off it, so the portal renders a signed-in operator while every
 * GoTrue-resolving call refuses them. The portal's only escape is a backend naming the case.
 *
 * A copy of these strings that drifts does not fail loudly: the Worker would answer `session_ended`
 * instead of `session_invalid`, the portal's check would quietly never match, and gated thumbnails
 * would go blank forever on a tab that looks signed in. That is the exact failure this module is
 * here to make impossible.
 *
 * WHAT IS SHARED IS THE VOCABULARY, NOT THE CLASSIFICATION. How a backend arrives at a verdict
 * differs by how it talks to GoTrue, and neither adapter belongs here:
 *   · the Worker calls `/auth/v1/user` with a raw fetch, so it reads GoTrue's `error_code` straight
 *     off the body — `deadSessionAuthCode` below is all it needs
 *   · the edge functions go through supabase-js, which mangles `session_not_found` into a code-less
 *     `AuthSessionMissingError` indistinguishable from "no header at all"; unpicking that needs the
 *     request, and lives in `supabase/functions/_shared/caller-auth-policy.ts`
 */

/** The verdict a backend returns, and the portal branches on. */
export type CallerAuthCode = 'session_invalid' | 'not_authenticated';

/** Re-authenticating fixes it: the credential is finished, the person behind it is fine. */
export const SESSION_INVALID: CallerAuthCode = 'session_invalid';
/** Nobody is signed in, or the credential was never a session token. Signing out would not help. */
export const NOT_AUTHENTICATED: CallerAuthCode = 'not_authenticated';

export const SESSION_INVALID_MESSAGE =
  'Your session is no longer valid. Sign out and sign in again.';
export const NOT_AUTHENTICATED_MESSAGE = 'Not authenticated';

/* GoTrue `error_code` values that mean the session behind a real token is gone.
   `user_not_found` is here because a deleted-and-recreated user leaves tabs holding a token for an
   id that no longer exists — same stale-tab shape, same fix.
   `no_authorization` is deliberately ABSENT: it is what GoTrue says about a credential it never
   accepted as a token (an API key in the Authorization header), which signing out would not improve.
   `user_banned` is absent for the same reason — re-authenticating is not the remedy. */
const DEAD_SESSION_AUTH_CODES: readonly string[] = [
  'session_not_found',
  'session_expired',
  'refresh_token_not_found',
  'refresh_token_already_used',
  'bad_jwt',
  'user_not_found',
];

/** Does this GoTrue `error_code` mean the caller's session is gone rather than absent? */
export function isDeadSessionAuthCode(code: unknown): boolean {
  return typeof code === 'string' && DEAD_SESSION_AUTH_CODES.includes(code);
}

/* The body a backend returns with its 401. Same shape everywhere, which is the point.
   A type alias rather than an interface so it stays assignable to the `Record<string, unknown>`
   that JSON response helpers take — an interface has no implicit index signature, and the fix for
   that at each call site is a cast. */
export type CallerAuthFailureBody = {
  error: string;
  code: CallerAuthCode;
};

export function callerAuthFailure(code: CallerAuthCode): CallerAuthFailureBody {
  return code === SESSION_INVALID
    ? { error: SESSION_INVALID_MESSAGE, code: SESSION_INVALID }
    : { error: NOT_AUTHENTICATED_MESSAGE, code: NOT_AUTHENTICATED };
}

/**
 * Verdict for a backend that reads GoTrue's response itself — the Worker's case.
 *
 * @param authCode GoTrue's `error_code` from the refused `/auth/v1/user` response, if it carried one.
 * @param presentedToken whether the caller actually offered a session token. Without one there is
 *        nothing to have expired, however GoTrue phrased its refusal.
 */
export function classifyGoTrueRefusal(
  authCode: unknown,
  presentedToken: boolean,
): CallerAuthFailureBody {
  return callerAuthFailure(
    presentedToken && isDeadSessionAuthCode(authCode) ? SESSION_INVALID : NOT_AUTHENTICATED,
  );
}
