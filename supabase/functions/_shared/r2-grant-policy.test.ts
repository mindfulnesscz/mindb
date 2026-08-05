import { describe, expect, it } from 'vitest';
import {
  grantAllowsKey,
  grantPrefixes,
  temporaryCredentialRequest,
} from './r2-grant-policy';

const CLIENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLIENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('r2-grant tenant prefix policy', () => {
  it('allows client A objects and refuses cross-client public keys', () => {
    const request = temporaryCredentialRequest(
      'public-bucket',
      'parent-key',
      grantPrefixes(CLIENT_A, 'pipeline', 'public'),
      3600,
    );

    expect(request).toMatchObject({
      permission: 'object-read-write',
      prefixes: [`${CLIENT_A}/`],
    });
    expect(grantAllowsKey(request.prefixes, `${CLIENT_A}/originals/stable/c1.pdf`)).toBe(true);
    expect(grantAllowsKey(request.prefixes, `${CLIENT_B}/originals/stable/c1.pdf`)).toBe(false);
  });

  it('scopes every gated level to client A and refuses client B at every level', () => {
    const prefixes = grantPrefixes(CLIENT_A, 'pipeline', 'gated');

    expect(prefixes).toEqual([
      `guest/${CLIENT_A}/`,
      `client/${CLIENT_A}/`,
      `internal/${CLIENT_A}/`,
    ]);
    for (const level of ['guest', 'client', 'internal']) {
      expect(grantAllowsKey(prefixes, `${level}/${CLIENT_A}/thumbnails/stable/c1.webp`)).toBe(true);
      expect(grantAllowsKey(prefixes, `${level}/${CLIENT_B}/thumbnails/stable/c1.webp`)).toBe(false);
    }
  });

  it('keeps branding credentials inside the selected client branding namespace', () => {
    const prefixes = grantPrefixes(CLIENT_A, 'branding', 'public');

    expect(prefixes).toEqual([`branding/${CLIENT_A}/`]);
    expect(grantAllowsKey(prefixes, `branding/${CLIENT_B}/logo.png`)).toBe(false);
  });
});
