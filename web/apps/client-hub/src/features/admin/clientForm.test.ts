/* Client form mapping + role assignment.
 *
 * `toSlug` produces the client's portal URL (`/:slug`), so its rules are a published format — a
 * change re-points a live link. `assignableRoles` is an authorization boundary: it is what stops
 * an ordinary admin from granting admin or super-admin.
 */

import { describe, it, expect } from 'vitest'
import { getInitials, toSlug, emptyForm, clientToForm } from './clientForm'
import { assignableRoles, ROLE_OPTIONS, ROLE_LABELS } from './roles'
import type { Client } from '@dc-hub/asset-library'

describe('getInitials', () => {
  it('takes the first letter of the first two words, uppercased', () => {
    expect(getInitials('Disrupt Collective')).toBe('DC')
    expect(getInitials('european surface solutions')).toBe('ES')
  })

  it('uses one letter for a single word, and ignores words beyond the second', () => {
    expect(getInitials('Acme')).toBe('A')
    expect(getInitials('One Two Three')).toBe('OT')
  })

  it('survives irregular whitespace and an empty name', () => {
    expect(getInitials('  Mucha   Family  ')).toBe('MF')
    expect(getInitials('')).toBe('')
    expect(getInitials('   ')).toBe('')
  })
})

describe('toSlug', () => {
  it('lowercases and hyphenates', () => {
    expect(toSlug('Disrupt Collective')).toBe('disrupt-collective')
    expect(toSlug('ACME')).toBe('acme')
  })

  it('collapses any run of non-alphanumerics into ONE hyphen', () => {
    expect(toSlug('A & B')).toBe('a-b')
    expect(toSlug('Product   Launch')).toBe('product-launch')
    expect(toSlug("Client's  Assets!!")).toBe('client-s-assets')
  })

  it('never leaves a leading or trailing hyphen — that would be an invalid URL segment', () => {
    expect(toSlug('  Acme  ')).toBe('acme')
    expect(toSlug('!Acme!')).toBe('acme')
    expect(toSlug('--Acme--')).toBe('acme')
  })

  it('drops accented characters rather than transliterating them', () => {
    // Same trade-off as slugifyKeyPart on the desktop side; worth knowing for Czech client names.
    expect(toSlug('Šumava')).toBe('umava')
  })

  it('can produce an empty slug when nothing survives', () => {
    // The form must not treat "" as a valid URL — pinned so a guard elsewhere is a deliberate choice.
    expect(toSlug('🎉')).toBe('')
    expect(toSlug('   ')).toBe('')
  })
})

describe('emptyForm', () => {
  it('starts with the default dimension labels, not blanks', () => {
    const f = emptyForm()
    expect(f).toMatchObject({ dimEntity: 'Entity', dimAngle: 'Angle', dimFormat: 'Format' })
    expect(f.accent).toBe('#161616')
    expect(f.domainWhitelist).toEqual([])
  })

  it('returns a fresh object each time, so two drawers cannot share state', () => {
    const a = emptyForm()
    a.domainWhitelist.push('leak.test')
    expect(emptyForm().domainWhitelist).toEqual([])
  })
})

describe('clientToForm', () => {
  const client = (over: Partial<Client> = {}): Client => ({
    id: 'c1', name: 'Acme', accent: '#111', initials: 'AC', ...over,
  })

  it('maps a full client across', () => {
    const f = clientToForm(client({
      slug: 'acme', logoUrl: 'https://x/l.png', website: 'https://x', portalBg: '#fff',
      domainWhitelist: ['acme.test'],
      dimensionLabels: { entity: 'Brand', angle: 'Purpose', format: 'Kind' },
    }))
    expect(f).toMatchObject({
      name: 'Acme', slug: 'acme', initials: 'AC', accent: '#111',
      logoUrl: 'https://x/l.png', website: 'https://x', portalBg: '#fff',
      domainWhitelist: ['acme.test'],
      dimEntity: 'Brand', dimAngle: 'Purpose', dimFormat: 'Kind',
    })
  })

  it('substitutes empty strings for absent optional fields, never undefined', () => {
    // These feed controlled inputs; undefined would make React warn and the field uncontrolled.
    const f = clientToForm(client())
    expect(f.slug).toBe('')
    expect(f.logoUrl).toBe('')
    expect(f.website).toBe('')
    expect(f.portalBg).toBe('')
    expect(f.domainWhitelist).toEqual([])
  })

  it('falls back to the default dimension labels when the client has none', () => {
    expect(clientToForm(client())).toMatchObject({
      dimEntity: 'Entity', dimAngle: 'Angle', dimFormat: 'Format',
    })
  })

  it('fills each dimension label independently', () => {
    const f = clientToForm(client({ dimensionLabels: { entity: 'Brand', angle: '', format: '' } }))
    expect(f.dimEntity).toBe('Brand')
    // An empty string is a real value here, not absence — it is NOT replaced by the default.
    expect(f.dimAngle).toBe('')
  })
})

describe('assignableRoles', () => {
  it('a super admin may assign every role', () => {
    expect(assignableRoles(true)).toEqual([...ROLE_OPTIONS])
  })

  it('an ordinary admin may NOT grant admin or super_admin', () => {
    // The authorization boundary. RLS enforces the same rule server-side; this stops the UI from
    // offering an option that would fail confusingly.
    const roles = assignableRoles(false)
    expect(roles).not.toContain('admin')
    expect(roles).not.toContain('super_admin')
    expect(roles).toEqual(['public', 'member', 'editor'])
  })

  it('every option has a display label', () => {
    for (const r of ROLE_OPTIONS) expect(ROLE_LABELS[r]).toBeTruthy()
  })
})
