/* The cookie: minting, verifying, and every way verification must fail.
 *
 * Runs in plain Node — Web Crypto's `crypto.subtle` is the same API in Node 18+ and in workerd, so
 * the HS256 path under test here is genuinely the shipped one.
 */

import { describe, it, expect } from 'vitest';
import { mint, verify, readCookie, setCookieHeader, clearCookieHeader, COOKIE_NAME } from './token';

const SECRET = 'test-secret-at-least-32-characters-long';
const OTHER_SECRET = 'a-completely-different-secret-value-here';
const CLIENT_A = '8f3e1c2a-0000-4000-8000-000000000001';
const NOW = 1_775_000_000_000; // fixed clock — a real one makes expiry tests flaky

const mintFor = (over: Partial<Parameters<typeof mint>[0]> = {}) =>
  mint({ sub: 'u-1', lvl: 'client', cid: CLIENT_A, st: false, ttlSeconds: 1800, now: NOW, ...over }, SECRET);

describe('mint + verify — the happy path', () => {
  it('round-trips every claim the Worker authorizes on', async () => {
    const { token } = await mintFor({ lvl: 'internal', cid: null, st: true });
    const claims = await verify(token, SECRET, NOW);
    expect(claims).toMatchObject({ sub: 'u-1', lvl: 'internal', cid: null, st: true });
  });

  it('sets exp from the TTL, and reports it so the portal can refresh in time', async () => {
    const { token, exp } = await mintFor({ ttlSeconds: 900 });
    expect(exp).toBe(NOW / 1000 + 900);
    expect((await verify(token, SECRET, NOW))?.exp).toBe(exp);
  });

  it('produces a compact token — this rides on every request in a 50-tile grid', async () => {
    const { token } = await mintFor();
    expect(token.length).toBeLessThan(400);
  });
});

describe('verify — every failure is the same failure', () => {
  /* Null for all of them, deliberately. A caller told WHICH half failed has been told which half
     to attack, and the Worker has no reason to distinguish "expired" from "forged" anyway: both
     mean not signed in. */

  it('rejects an absent cookie', async () => {
    expect(await verify(null, SECRET, NOW)).toBeNull();
    expect(await verify('', SECRET, NOW)).toBeNull();
  });

  it('rejects an expired token, exactly at the boundary', async () => {
    const { token, exp } = await mintFor({ ttlSeconds: 60 });
    expect(await verify(token, SECRET, exp * 1000 - 1)).not.toBeNull();
    expect(await verify(token, SECRET, exp * 1000)).toBeNull();
    expect(await verify(token, SECRET, exp * 1000 + 1)).toBeNull();
  });

  it('rejects a signature made with another secret', async () => {
    const { token } = await mintFor();
    expect(await verify(token, OTHER_SECRET, NOW)).toBeNull();
  });

  it('rejects a payload edited in place — the signature is over both halves', async () => {
    // The attack that matters: take a valid member token and promote it to staff.
    const { token } = await mintFor({ st: false });
    const [header, payload, sig] = token.split('.');
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    expect(decoded.st).toBe(false);
    decoded.st = true;
    const forged = btoa(JSON.stringify(decoded)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verify(`${header}.${forged}.${sig}`, SECRET, NOW)).toBeNull();
  });

  it('rejects a token with no signature at all', async () => {
    const { token } = await mintFor();
    const [header, payload] = token.split('.');
    expect(await verify(`${header}.${payload}.`, SECRET, NOW)).toBeNull();
    expect(await verify(`${header}.${payload}`, SECRET, NOW)).toBeNull();
  });

  it('rejects structurally wrong values without throwing', async () => {
    for (const bad of ['garbage', 'a.b.c', '...', 'a.b.c.d', '%%%.%%%.%%%']) {
      expect(await verify(bad, SECRET, NOW)).toBeNull();
    }
  });

  it('rejects a validly-signed token whose claims are the wrong shape', async () => {
    // A token this Worker did not mint but that shares the secret — e.g. some other service's
    // JWT. Shape-checking the claims is what stops it being read as an authorization.
    const enc = new TextEncoder();
    const b64 = (o: unknown) =>
      btoa(String.fromCharCode(...enc.encode(JSON.stringify(o))))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const header = b64({ alg: 'HS256', typ: 'JWT' });
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sign = async (payload: string) => {
      const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${payload}`)));
      return `${header}.${payload}.${btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    };

    const exp = NOW / 1000 + 600;
    expect(await verify(await sign(b64({ sub: 'u', exp })), SECRET, NOW)).toBeNull();               // no lvl/st
    expect(await verify(await sign(b64({ sub: 'u', exp, st: false, lvl: 'public' })), SECRET, NOW)).toBeNull();
    expect(await verify(await sign(b64({ sub: 'u', exp, st: 'yes', lvl: 'client', cid: null })), SECRET, NOW)).toBeNull();
    expect(await verify(await sign(b64({ exp, st: false, lvl: 'guest', cid: null })), SECRET, NOW)).toBeNull(); // no sub
  });
});

describe('readCookie', () => {
  it('finds the cookie among others, and is not fooled by a prefix', async () => {
    expect(readCookie(`a=1; ${COOKIE_NAME}=tok; b=2`, COOKIE_NAME)).toBe('tok');
    expect(readCookie(`${COOKIE_NAME}=tok`, COOKIE_NAME)).toBe('tok');
    expect(readCookie(`x_${COOKIE_NAME}=nope`, COOKIE_NAME)).toBeNull();
    expect(readCookie(`${COOKIE_NAME}_x=nope`, COOKIE_NAME)).toBeNull();
    expect(readCookie(null, COOKIE_NAME)).toBeNull();
    expect(readCookie('malformed', COOKIE_NAME)).toBeNull();
  });
});

describe('setCookieHeader', () => {
  it('carries every attribute the cross-subdomain design depends on', async () => {
    const header = setCookieHeader('tok', '.disruptcollective.com', 1800);
    // Domain: without it the cookie is scoped to files.disruptcollective.com alone and the
    // portal's <img> requests never send it. This is the load-bearing attribute.
    expect(header).toContain('Domain=.disruptcollective.com');
    // Lax rather than None: <img> cannot pass credentials, so same-site is the only thing that
    // makes the cookie ride along — and None would walk straight into third-party blocking.
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Secure');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=1800');
  });

  it('clears with Max-Age=0 on the same Domain — a different Domain leaves the cookie in place', () => {
    const header = clearCookieHeader('.disruptcollective.com');
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('Domain=.disruptcollective.com');
  });
});
