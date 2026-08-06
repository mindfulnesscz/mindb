import { describe, expect, it } from 'vitest';
import {
  callerAuthFailure,
  classifyGoTrueRefusal,
  isDeadSessionAuthCode,
  NOT_AUTHENTICATED,
  NOT_AUTHENTICATED_MESSAGE,
  SESSION_INVALID,
  SESSION_INVALID_MESSAGE,
} from './callerAuth';

describe('isDeadSessionAuthCode', () => {
  it.each(['session_not_found', 'session_expired', 'refresh_token_not_found', 'refresh_token_already_used', 'bad_jwt', 'user_not_found'])(
    'recognises %s',
    code => expect(isDeadSessionAuthCode(code)).toBe(true),
  );

  it.each([
    ['no_authorization', 'a credential GoTrue never accepted as a token'],
    ['user_banned', 'a remedy that is not re-authenticating'],
    ['validation_failed', 'an unrelated refusal'],
  ])('does not claim %s is a dead session — %s', code => {
    expect(isDeadSessionAuthCode(code)).toBe(false);
  });

  it('is safe on anything that is not a code', () => {
    expect(isDeadSessionAuthCode(undefined)).toBe(false);
    expect(isDeadSessionAuthCode(null)).toBe(false);
    expect(isDeadSessionAuthCode(403)).toBe(false);
    expect(isDeadSessionAuthCode('')).toBe(false);
  });
});

describe('callerAuthFailure', () => {
  it('pairs each verdict with the message the operator reads', () => {
    expect(callerAuthFailure(SESSION_INVALID)).toEqual({
      error: SESSION_INVALID_MESSAGE,
      code: 'session_invalid',
    });
    expect(callerAuthFailure(NOT_AUTHENTICATED)).toEqual({
      error: NOT_AUTHENTICATED_MESSAGE,
      code: 'not_authenticated',
    });
  });

  it('tells the operator what to do about a dead session', () => {
    // The whole point of the distinction: an actionable sentence, not a diagnosis.
    expect(SESSION_INVALID_MESSAGE).toMatch(/sign in again/i);
  });
});

describe('classifyGoTrueRefusal', () => {
  it('names a dead session when a token was presented and GoTrue said the session is gone', () => {
    expect(classifyGoTrueRefusal('session_not_found', true).code).toBe('session_invalid');
  });

  it('will not call it a dead session when no token was presented', () => {
    // Nothing can have expired if nothing was offered — however GoTrue phrased its refusal.
    expect(classifyGoTrueRefusal('session_not_found', false).code).toBe('not_authenticated');
  });

  it('leaves an unrecognised or absent code as plainly unauthenticated', () => {
    expect(classifyGoTrueRefusal('no_authorization', true).code).toBe('not_authenticated');
    expect(classifyGoTrueRefusal(undefined, true).code).toBe('not_authenticated');
  });
});
