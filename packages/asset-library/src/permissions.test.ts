/* The portal's access mirror.
 *
 * These functions are not the security boundary — Postgres RLS decides which rows a session can
 * discover, and the CDN Worker decides who gets the bytes. What they are is the UI's copy of the
 * same rules, and a copy that disagrees with the original is worse than no copy: it shows a
 * Download button that 403s, or hides an asset the client is entitled to and generates a support
 * request. The module had no tests at all before 2026-07-31; these pin the parts that mirror SQL.
 *
 * The rule under test, matching the generated `assets.effective_level` column:
 *
 *   effective_level = (status in ('approved','published')) ? perm : 'internal'
 */

import { describe, it, expect } from 'vitest'
import { effectiveLevel, canViewAsset, canDownload, isStaff, canControlPermission } from './permissions.js'
import type { Asset, AssetPerm, AssetStatus, Role } from './types.js'

const asset = (perm: AssetPerm, status: AssetStatus, clientId = 'c-1'): Asset => ({
  id: 'a-1', clientId, name: 'Asset', entityType: 'product', entity: 'Product',
  formats: [], angle: '', status, perm, version: 'v1', latest: true,
  avg: 0, count: 0, comments: 0, approval: 'none', updatedAt: '2026-07-31T00:00:00Z',
})

const ROLES: Role[] = ['public', 'member', 'editor', 'admin', 'super_admin']

describe('effectiveLevel — perm and status are independent axes', () => {
  it('passes perm through once the asset is approved or published', () => {
    for (const status of ['approved', 'published'] as const) {
      for (const perm of ['public', 'guest', 'client', 'internal'] as const) {
        expect(effectiveLevel(asset(perm, status))).toBe(perm)
      }
    }
  })

  it('downgrades every unreleased state to internal, whatever perm says', () => {
    // The exposure this rule exists to close: work marked world-readable before sign-off.
    for (const status of ['draft', 'review', 'archived', 'disconnected'] as const) {
      expect(effectiveLevel(asset('public', status))).toBe('internal')
      expect(effectiveLevel(asset('guest', status))).toBe('internal')
      expect(effectiveLevel(asset('client', status))).toBe('internal')
    }
  })
})

describe('canViewAsset', () => {
  it('shows a published public asset to everyone', () => {
    for (const role of ROLES) expect(canViewAsset(role, asset('public', 'published'))).toBe(true)
  })

  it('hides a DRAFT public asset from everyone but staff', () => {
    expect(canViewAsset('public', asset('public', 'draft'))).toBe(false)
    expect(canViewAsset('member', asset('public', 'draft'))).toBe(false)
    expect(canViewAsset('editor', asset('public', 'draft'))).toBe(true)
    expect(canViewAsset('admin', asset('public', 'draft'))).toBe(true)
  })

  it('hides an internal asset from members', () => {
    expect(canViewAsset('member', asset('internal', 'published'))).toBe(false)
    expect(canViewAsset('editor', asset('internal', 'published'))).toBe(true)
  })

  it('shows a client-level asset to a member of that client only', () => {
    const a = asset('client', 'published', 'c-1')
    expect(canViewAsset('member', a, 'c-1')).toBe(true)
    expect(canViewAsset('member', a, 'c-2')).toBe(false)
    expect(canViewAsset('editor', a, 'c-2')).toBe(true)   // staff cross client deliberately
  })

  it('shows a guest-level asset to every role, session-checking left to RLS', () => {
    // Role `public` covers both an anonymous visitor and a signed-in email-capture profile, and
    // this module cannot tell them apart. RLS requires `auth.uid() is not null` for the guest
    // level, so an anonymous session never receives such a row to filter. See the note in
    // permissions.ts — a display filter is the wrong place to re-check authentication.
    for (const role of ROLES) expect(canViewAsset(role, asset('guest', 'published'))).toBe(true)
  })
})

describe('canDownload', () => {
  it('lets a guest download released public and guest-level assets', () => {
    expect(canDownload('public', asset('public', 'published'))).toBe(true)
    expect(canDownload('public', asset('guest',  'approved'))).toBe(true)
  })

  it('refuses a guest anything unreleased or tenant-scoped', () => {
    expect(canDownload('public', asset('public', 'draft'))).toBe(false)
    expect(canDownload('public', asset('client', 'published'))).toBe(false)
  })

  it('gates a member on release state, not on perm — RLS already scoped the row', () => {
    expect(canDownload('member', asset('client', 'published'))).toBe(true)
    expect(canDownload('member', asset('client', 'review'))).toBe(false)
  })

  it('lets staff download unreleased work, which is the point of unreleased work', () => {
    expect(canDownload('editor', asset('internal', 'draft'))).toBe(true)
  })
})

describe('isStaff', () => {
  it('is editor and above, matching the SQL is_staff()', () => {
    // Postgres `is_staff()` is `role in ('editor','admin')`; super_admin is a portal-side
    // elevation of admin, so it counts here too.
    expect(['editor', 'admin', 'super_admin'].every(r => isStaff(r as Role))).toBe(true)
    expect(isStaff('member')).toBe(false)
    expect(isStaff('public')).toBe(false)
  })
})

describe('canControlPermission', () => {
  it('is editors and above — the same set the server lets write', () => {
    // It used to say admins only and was never called, while the panel gated on isStaff. Two
    // answers to one access question, with the permissive one shipping. Confirmed 2026-08-01:
    // editors change visibility, matching the `assets: staff write` policy.
    expect(canControlPermission('editor')).toBe(true)
    expect(canControlPermission('admin')).toBe(true)
    expect(canControlPermission('super_admin')).toBe(true)
    expect(canControlPermission('member')).toBe(false)
    expect(canControlPermission('public')).toBe(false)
  })
})
