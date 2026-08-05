// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

const supabaseMock = vi.hoisted(() => ({
  maybeSingle: vi.fn(async () => ({
    data: {
      cloud_destinations: [{
        id: 'super-admin-destination',
        name: 'Maintainer export',
        role: 'client',
        minRole: 'super_admin',
        enabled: true,
        showInPortal: true,
        config: { type: 'local', path: '' },
      }],
    },
    error: null,
  })),
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: supabaseMock.maybeSingle })),
      })),
    })),
  },
}))

const { destinationsVisibleToRole, fetchDestinations } = await import('./destinationService')

describe('destination visibility', () => {
  it('preserves a super_admin minimum role when deserializing portal config', async () => {
    const destinations = await fetchDestinations('client-1')

    expect(destinations).toHaveLength(1)
    expect(destinations[0].minRole).toBe('super_admin')
    expect(destinationsVisibleToRole(destinations, 'member')).toEqual([])
    expect(destinationsVisibleToRole(destinations, 'super_admin')).toEqual(destinations)
  })
})
