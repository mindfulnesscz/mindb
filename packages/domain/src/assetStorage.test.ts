/* The key shape is a contract between three programs that cannot import each other.
 *
 * The desktop pipeline writes these keys, the re-key script moves objects between them, and the
 * cdn-gate Worker parses them back to decide who may fetch the bytes. The Worker is a separate
 * deployment with its own bundle, so its parser (`workers/cdn-gate/src/authz.ts`, parseGatedKey)
 * restates this shape by hand. These tests write the shape down literally so a change here is
 * visibly a change there too — a mismatch shows up as a 404 or a leak, never as a type error.
 */

import { describe, it, expect } from 'vitest';
import {
  effectiveLevel, tierFor, storageTarget, assetUrl, stripVersion, type AccessLevel,
} from './assetStorage';

const CLIENT = '8f3e1c2a-0000-4000-8000-000000000001';

describe('effectiveLevel — perm and status both gate', () => {
  it('passes perm through once released', () => {
    for (const status of ['approved', 'published']) {
      for (const perm of ['public', 'guest', 'client', 'internal'] as const) {
        expect(effectiveLevel({ perm, status })).toBe(perm);
      }
    }
  });

  it('downgrades everything unreleased to internal', () => {
    for (const status of ['draft', 'review', 'archived', 'disconnected']) {
      expect(effectiveLevel({ perm: 'public', status })).toBe('internal');
    }
  });

  it('resolves the unknown to internal, never to a default', () => {
    // The safe direction for a value that decides who can read something. A typo in `perm`, a
    // column that has not been backfilled, a row from a future migration — none of them should
    // widen access by falling back to a permissive default.
    expect(effectiveLevel({ perm: 'nonsense', status: 'published' })).toBe('internal');
    expect(effectiveLevel({ perm: null, status: 'published' })).toBe('internal');
    expect(effectiveLevel({ perm: 'public', status: null })).toBe('internal');
    expect(effectiveLevel({ perm: undefined, status: undefined })).toBe('internal');
  });
});

describe('tierFor', () => {
  it('sends only public bytes down the public path', () => {
    expect(tierFor('public')).toBe('public');
    for (const l of ['guest', 'client', 'internal'] as AccessLevel[]) expect(tierFor(l)).toBe('gated');
  });
});

describe('storageTarget — the key shape, written out', () => {
  it('leaves PUBLIC keys exactly as the pipeline has always written them', () => {
    // Load-bearing: anything already legitimately public keeps the address it already has, so the
    // re-key does not have to touch it and existing URLs keep resolving.
    expect(storageTarget('public', CLIENT, 'thumbnails', 'a1000001', 'c1', '.webp')).toEqual({
      tier: 'public',
      key: `${CLIENT}/thumbnails/a1000001/c1.webp`,
    });
    expect(storageTarget('public', CLIENT, 'originals', 'a1000001', 'c1', '.pdf')).toEqual({
      tier: 'public',
      key: `${CLIENT}/originals/a1000001/c1.pdf`,
    });
  });

  it('prefixes GATED keys with the level, which is what the Worker authorizes on', () => {
    for (const level of ['guest', 'client', 'internal'] as AccessLevel[]) {
      expect(storageTarget(level, CLIENT, 'thumbnails', 'a1000001', 'c1', '.webp')).toEqual({
        tier: 'gated',
        key: `${level}/${CLIENT}/thumbnails/a1000001/c1.webp`,
      });
    }
  });

  it('puts level and client in the first two segments — parseGatedKey depends on it', () => {
    const { key } = storageTarget('client', CLIENT, 'originals', 'a1000001', 'c1', '.mp4');
    const [level, clientId, kind] = key.split('/');
    expect(level).toBe('client');
    expect(clientId).toBe(CLIENT);
    expect(kind).toBe('originals');
  });

  it('handles an extensionless original without a trailing dot', () => {
    expect(storageTarget('client', CLIENT, 'originals', 'a1', 'c1').key)
      .toBe(`client/${CLIENT}/originals/a1/c1`);
  });
});

describe('assetUrl', () => {
  it('carries the content stamp on both tiers', () => {
    expect(assetUrl('https://cdn.example.com', 'k/x.webp', 'abcdef0123456789'))
      .toBe('https://cdn.example.com/k/x.webp?v=abcdef012345');
    expect(assetUrl('https://files.example.com', 'client/c/k/x.webp', 'abcdef0123456789'))
      .toBe('https://files.example.com/client/c/k/x.webp?v=abcdef012345');
  });

  it('truncates the hash to 12 chars and tolerates a trailing slash on the domain', () => {
    expect(assetUrl('https://cdn.example.com/', 'k.webp', 'a'.repeat(64)))
      .toBe(`https://cdn.example.com/k.webp?v=${'a'.repeat(12)}`);
  });

  it('omits the stamp when there is no hash', () => {
    expect(assetUrl('https://cdn.example.com', 'k.webp')).toBe('https://cdn.example.com/k.webp');
  });
});

describe('stripVersion', () => {
  it('lets a stored URL be compared against a computed target', () => {
    expect(stripVersion('https://cdn.example.com/k.webp?v=abc')).toBe('https://cdn.example.com/k.webp');
    expect(stripVersion('https://cdn.example.com/k.webp')).toBe('https://cdn.example.com/k.webp');
  });
});
