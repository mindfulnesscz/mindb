/* The authorization decision, exhaustively.
 *
 * These run in plain Node — the module is deliberately I/O-free and framework-free, so proving it
 * needs no workerd, no Miniflare and no bucket. That is worth having: the matrix below is the
 * actual security contract, and a suite that needs a container to run is a suite that stops being
 * run. Cache behaviour and Range handling live in index.ts and DO need `wrangler dev` — see the
 * README, and remember the Cache API is a silent no-op on workers.dev.
 */

import { describe, it, expect } from 'vitest';
import {
  parseGatedKey, authorize, levelForProfile, isStaffRole, parseRangeHeader, resolveContentRange,
  type CdnClaims, type Level,
} from './authz';

const CLIENT_A = '8f3e1c2a-0000-4000-8000-000000000001';
const CLIENT_B = '8f3e1c2a-0000-4000-8000-000000000002';

const key = (level: Level, clientId = CLIENT_A) =>
  parseGatedKey(`/${level}/${clientId}/thumbnails/a1000001/c1.webp`)!;

const claims = (over: Partial<CdnClaims> = {}): CdnClaims => ({
  sub: 'u-1', lvl: 'client', cid: CLIENT_A, st: false, exp: 9999999999, ...over,
});

const ANON = null;
const GUEST = claims({ lvl: 'guest', cid: null });
const MEMBER_A = claims({ lvl: 'client', cid: CLIENT_A });
const MEMBER_B = claims({ lvl: 'client', cid: CLIENT_B });
const STAFF = claims({ lvl: 'internal', cid: null, st: true });

describe('parseGatedKey', () => {
  it('splits level, client and the rest of the key', () => {
    const parsed = parseGatedKey('/client/8f3e1c2a-0000-4000-8000-000000000001/originals/a1000001/c1.mp4');
    expect(parsed).toEqual({
      level: 'client',
      clientId: CLIENT_A,
      rest: 'originals/a1000001/c1.mp4',
      key: `client/${CLIENT_A}/originals/a1000001/c1.mp4`,
    });
  });

  it('accepts every level', () => {
    for (const level of ['public', 'guest', 'client', 'internal'] as const) {
      expect(parseGatedKey(`/${level}/${CLIENT_A}/x.webp`)?.level).toBe(level);
    }
  });

  it('decodes percent-encoding, since object keys hold spaces', () => {
    expect(parseGatedKey(`/client/${CLIENT_A}/originals/a1/My%20Deck.pdf`)?.rest)
      .toBe('originals/a1/My Deck.pdf');
  });

  it('refuses anything whose level it cannot determine', () => {
    // Every one of these must be a 404. An unparseable level is not a public level — the whole
    // design rests on the key being the authority, so a key it cannot read is not a key at all.
    expect(parseGatedKey('/')).toBeNull();
    expect(parseGatedKey('/client')).toBeNull();
    expect(parseGatedKey(`/client/${CLIENT_A}`)).toBeNull();          // no object part
    expect(parseGatedKey(`/secret/${CLIENT_A}/x.webp`)).toBeNull();   // not a level
    expect(parseGatedKey('/client/not-a-uuid/x.webp')).toBeNull();
    expect(parseGatedKey('/client//x.webp')).toBeNull();              // empty segment
    expect(parseGatedKey('/%E0%A4%A/x/y')).toBeNull();                // malformed encoding
  });

  it('refuses traversal, before and after decoding', () => {
    expect(parseGatedKey(`/client/${CLIENT_A}/../internal/${CLIENT_A}/x.webp`)).toBeNull();
    expect(parseGatedKey(`/client/${CLIENT_A}/%2e%2e/internal/x.webp`)).toBeNull();
    expect(parseGatedKey(`/client/${CLIENT_A}/./x.webp`)).toBeNull();
  });
});

describe('authorize — every level against every kind of caller', () => {
  /* The matrix IS the specification. Read down a column to see what one caller can reach; read
     across a row to see who can reach one level. */
  const CASES: Array<[string, CdnClaims | null, Record<Level, boolean>]> = [
    ['anonymous',            ANON,     { public: true, guest: false, client: false, internal: false }],
    ['signed in, no client', GUEST,    { public: true, guest: true,  client: false, internal: false }],
    ['member of client A',   MEMBER_A, { public: true, guest: true,  client: true,  internal: false }],
    ['member of client B',   MEMBER_B, { public: true, guest: true,  client: false, internal: false }],
    ['staff',                STAFF,    { public: true, guest: true,  client: true,  internal: true }],
  ];

  for (const [who, actor, expected] of CASES) {
    for (const level of ['public', 'guest', 'client', 'internal'] as const) {
      const verb = expected[level] ? 'may' : 'may NOT';
      it(`${who} ${verb} fetch a ${level}-level object of client A`, () => {
        expect(authorize(key(level, CLIENT_A), actor)).toBe(expected[level]);
      });
    }
  }

  it('refuses a member client A object even with the exact URL — the tenant boundary', () => {
    expect(authorize(key('client', CLIENT_B), MEMBER_A)).toBe(false);
    expect(authorize(key('client', CLIENT_A), MEMBER_B)).toBe(false);
  });

  it('lets staff cross the tenant boundary, which is their job', () => {
    expect(authorize(key('client', CLIENT_B), STAFF)).toBe(true);
    expect(authorize(key('internal', CLIENT_B), STAFF)).toBe(true);
  });

  it('trusts `st` over `lvl` for staff, and neither for anyone else', () => {
    // A token claiming the internal level without the staff flag is not staff. The two claims are
    // minted together from one profile, so disagreement means tampering — and `st` is the one the
    // client and internal branches consult.
    const liar = claims({ lvl: 'internal', cid: CLIENT_B, st: false });
    expect(authorize(key('internal', CLIENT_A), liar)).toBe(false);
    expect(authorize(key('client', CLIENT_A), liar)).toBe(false);
  });
});

describe('levelForProfile — mirrors the RLS policies', () => {
  it('gives staff the internal level whatever client they are attached to', () => {
    for (const role of ['editor', 'admin', 'super_admin']) {
      expect(levelForProfile(role, null)).toBe('internal');
      expect(levelForProfile(role, CLIENT_A)).toBe('internal');
    }
  });

  it('gives a member with a client the client level', () => {
    expect(levelForProfile('member', CLIENT_A)).toBe('client');
    // `role='public'` is the default a magic-link sign-in lands on; attached to a client it is
    // still that client's material they are entitled to.
    expect(levelForProfile('public', CLIENT_A)).toBe('client');
  });

  it('gives anyone else signed in the guest level', () => {
    expect(levelForProfile('public', null)).toBe('guest');
    expect(levelForProfile('member', null)).toBe('guest');
  });
});

describe('Range parsing — the numbers behind Content-Range', () => {
  /* These exist because the first deployed version answered a Range request with a correct body,
     a correct Content-Length, and `Content-Range: bytes NaN-NaN/1500`. It had read the served
     range back off `object.range` instead of owning the arithmetic. A player given that header
     stalls, and nothing in a smoke test notices. */

  const SIZE = 1500;
  const resolved = (header: string, size = SIZE) => {
    const spec = parseRangeHeader(header);
    return spec ? resolveContentRange(spec, size) : null;
  };
  const contentRange = (header: string, size = SIZE) => {
    const r = resolved(header, size);
    return r && `bytes ${r.start}-${r.start + r.length - 1}/${size}`;
  };

  it('handles a closed range', () => {
    expect(parseRangeHeader('bytes=0-99')).toEqual({ offset: 0, length: 100 });
    expect(contentRange('bytes=0-99')).toBe('bytes 0-99/1500');
    expect(contentRange('bytes=500-999')).toBe('bytes 500-999/1500');
  });

  it('handles an open-ended range', () => {
    expect(parseRangeHeader('bytes=100-')).toEqual({ offset: 100 });
    expect(contentRange('bytes=100-')).toBe('bytes 100-1499/1500');
  });

  it('handles a suffix range — what a player uses to read a trailing index', () => {
    expect(parseRangeHeader('bytes=-50')).toEqual({ suffix: 50 });
    expect(contentRange('bytes=-50')).toBe('bytes 1450-1499/1500');
  });

  it('clamps a range that overruns the object', () => {
    // Satisfiable, and must report what was actually sent rather than what was asked for.
    expect(contentRange('bytes=0-99999')).toBe('bytes 0-1499/1500');
    expect(contentRange('bytes=-99999')).toBe('bytes 0-1499/1500');
    expect(contentRange('bytes=1400-99999')).toBe('bytes 1400-1499/1500');
  });

  it('never produces NaN, for any input it accepts', () => {
    for (const h of ['bytes=0-0', 'bytes=0-', 'bytes=-1', 'bytes=1499-', 'bytes=0-1499', 'bytes=1400-1499']) {
      const r = resolved(h)!;
      expect(Number.isFinite(r.start), `${h} start`).toBe(true);
      expect(Number.isFinite(r.length), `${h} length`).toBe(true);
      expect(r.start).toBeGreaterThanOrEqual(0);
      expect(r.start + r.length).toBeLessThanOrEqual(SIZE);
    }
  });

  it('falls back to the whole object rather than guessing', () => {
    // Every one of these is legal to answer with a plain 200 — RFC 7233 allows ignoring a Range.
    for (const h of [null, '', 'bytes=', 'bytes=-', 'bytes=abc-def', 'items=0-99',
                     'bytes=0-9,20-29', 'bytes=99-0', 'bytes=-0', 'garbage']) {
      expect(parseRangeHeader(h), String(h)).toBeNull();
    }
  });
});

describe('isStaffRole', () => {
  it('is editor and above, matching the SQL is_staff() as widened by 20260724120001', () => {
    expect(['editor', 'admin', 'super_admin'].every(isStaffRole)).toBe(true);
    expect(isStaffRole('member')).toBe(false);
    expect(isStaffRole('public')).toBe(false);
  });
});
