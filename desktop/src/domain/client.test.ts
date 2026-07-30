/* Client + destination shape.

   `resolveExportShape` is the single arbiter of a destination's export layout, and the
   pair (exportLayout, includePackages) must stay internally consistent no matter which
   direction the data came from — desktop UI, portal JSON, or a legacy row. Git history
   carries three fixes here ("allow legacy packages layout in resolveExportShape typing",
   "desktop export shape types and duplicate destination keys", "export package folders
   per destination"), so the invariant is pinned rather than re-reasoned. */

import { describe, it, expect } from 'vitest';
import {
  resolveExportShape, makeClient, makeDestination, normalizeDestination,
  clientInitials, tokenStatus, cloudToken,
  type CloudToken,
} from './client';

describe('resolveExportShape', () => {
  it('defaults to folders when the layout is missing or unrecognised', () => {
    expect(resolveExportShape({}).exportLayout).toBe('folders');
    expect(resolveExportShape({ exportLayout: undefined }).exportLayout).toBe('folders');
    // A legacy/unknown string must not leak through as a third layout.
    expect(resolveExportShape({ exportLayout: 'packages' as never }).exportLayout).toBe('folders');
  });

  it('honours an explicit flat layout', () => {
    expect(resolveExportShape({ exportLayout: 'flat' }).exportLayout).toBe('flat');
  });

  it('THE invariant: flat can never include packages', () => {
    // Packages nest inside the folder tree; there is nowhere to put them in a flat
    // dump. Allowing both would mirror package folders into the flat root.
    expect(resolveExportShape({ exportLayout: 'flat', includePackages: true })).toEqual({
      exportLayout: 'flat', includePackages: false,
    });
  });

  it('allows packages with the folders layout', () => {
    expect(resolveExportShape({ exportLayout: 'folders', includePackages: true })).toEqual({
      exportLayout: 'folders', includePackages: true,
    });
  });

  it('coerces a truthy non-boolean includePackages to a real boolean', () => {
    expect(resolveExportShape({ includePackages: 1 as never }).includePackages).toBe(true);
    expect(resolveExportShape({ includePackages: undefined }).includePackages).toBe(false);
  });
});

describe('makeDestination', () => {
  it('applies the resolved shape, not the raw partial', () => {
    const d = makeDestination({ exportLayout: 'flat', includePackages: true });
    expect(d.exportLayout).toBe('flat');
    expect(d.includePackages).toBe(false);
  });

  it('does not let a raw partial spread overwrite the resolved shape', () => {
    // The `...rest` spread deliberately excludes exportLayout/includePackages so the
    // resolved pair always wins, whatever order the keys appear in.
    const d = makeDestination({ includePackages: true, exportLayout: 'flat', name: 'Client' });
    expect(d.name).toBe('Client');
    expect(d.includePackages).toBe(false);
  });

  it('gives every destination a distinct id', () => {
    expect(makeDestination().id).not.toBe(makeDestination().id);
  });

  it('defaults to an internal, portal-visible, enabled local destination', () => {
    const d = makeDestination();
    expect(d).toMatchObject({
      role: 'internal', minRole: 'member', generateLink: false,
      showInPortal: true, allowRevealLocal: true, enabled: true,
      exportLayout: 'folders', includePackages: false,
      config: { type: 'local', path: '' },
    });
  });
});

describe('normalizeDestination', () => {
  it('keeps a valid minRole and rejects anything else down to member', () => {
    expect(normalizeDestination({ minRole: 'admin' }).minRole).toBe('admin');
    expect(normalizeDestination({ minRole: 'public' }).minRole).toBe('public');
    expect(normalizeDestination({ minRole: 'owner' as never }).minRole).toBe('member');
    expect(normalizeDestination({}).minRole).toBe('member');
  });

  it('treats showInPortal and enabled as opt-OUT (absent means true)', () => {
    expect(normalizeDestination({}).showInPortal).toBe(true);
    expect(normalizeDestination({}).enabled).toBe(true);
    expect(normalizeDestination({ showInPortal: false }).showInPortal).toBe(false);
    expect(normalizeDestination({ enabled: false }).enabled).toBe(false);
  });

  it('treats allowRevealLocal as opt-IN, unlike makeDestination', () => {
    // Deliberate divergence: a destination arriving from portal JSON must not gain
    // local-reveal permission by omission. makeDestination (desktop-authored) defaults
    // it true; normalizeDestination (portal-authored) defaults it false.
    expect(makeDestination({}).allowRevealLocal).toBe(true);
    expect(normalizeDestination({}).allowRevealLocal).toBe(false);
    expect(normalizeDestination({ allowRevealLocal: true }).allowRevealLocal).toBe(true);
  });

  it('enforces the flat/packages invariant on portal data too', () => {
    expect(normalizeDestination({ exportLayout: 'flat', includePackages: true })).toMatchObject({
      exportLayout: 'flat', includePackages: false,
    });
  });
});

describe('makeClient', () => {
  it('fills defaults and lets the partial override them', () => {
    const c = makeClient({ name: 'ESS', accent: '#ff0000' });
    expect(c.name).toBe('ESS');
    expect(c.accent).toBe('#ff0000');
    expect(c.cloudDestinations).toEqual([]);
    expect(c.dimensionLabels).toEqual({ entity: 'Entity', angle: 'Angle', format: 'Format' });
  });

  it('gives every client a distinct id', () => {
    expect(makeClient().id).not.toBe(makeClient().id);
  });
});

describe('clientInitials', () => {
  it('takes the first letter of the first two words, uppercased', () => {
    expect(clientInitials('Disrupt Collective')).toBe('DC');
    expect(clientInitials('european surface solutions')).toBe('ES');
  });

  it('uses one letter for a single word', () => {
    expect(clientInitials('Acme')).toBe('A');
  });

  it('ignores extra words beyond the second', () => {
    expect(clientInitials('One Two Three Four')).toBe('OT');
  });

  it('survives irregular whitespace and an empty name', () => {
    expect(clientInitials('  Mucha   Family  ')).toBe('MF');
    expect(clientInitials('')).toBe('');
    expect(clientInitials('   ')).toBe('');
  });
});

describe('tokenStatus', () => {
  const token = (over: Partial<CloudToken>): CloudToken => ({
    accessToken: 'at', refreshToken: 'rt', expiresAt: 0,
    email: 'a@b.c', displayName: 'A', ...over,
  });
  const HOUR = 60 * 60 * 1000;

  it('reports none for a missing or empty token', () => {
    expect(tokenStatus(null)).toBe('none');
    expect(tokenStatus(token({ accessToken: '' }))).toBe('none');
  });

  it('reports expired once the deadline has passed', () => {
    expect(tokenStatus(token({ expiresAt: Date.now() - 1000 }))).toBe('expired');
  });

  it('reports expiring inside the last hour — the refresh window', () => {
    expect(tokenStatus(token({ expiresAt: Date.now() + 30 * 60 * 1000 }))).toBe('expiring');
  });

  it('reports fresh beyond an hour out', () => {
    expect(tokenStatus(token({ expiresAt: Date.now() + 2 * HOUR }))).toBe('fresh');
  });

  it('treats an empty access token as none even if the expiry is fine', () => {
    // Order matters: a blank token with a future expiry must not read as "fresh".
    expect(tokenStatus(token({ accessToken: '', expiresAt: Date.now() + 10 * HOUR }))).toBe('none');
  });
});

describe('cloudToken', () => {
  it('returns null for a local destination — there is nothing to authenticate', () => {
    expect(cloudToken({ type: 'local', path: '/x' })).toBeNull();
  });

  it('returns the token for a cloud destination, null included', () => {
    const t: CloudToken = {
      accessToken: 'at', refreshToken: 'rt', expiresAt: 1, email: '', displayName: '',
    };
    expect(cloudToken({ type: 'dropbox', clientId: 'c', remotePath: '/p', token: t })).toBe(t);
    expect(cloudToken({ type: 'dropbox', clientId: 'c', remotePath: '/p', token: null })).toBeNull();
  });
});
