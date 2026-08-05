// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../lib/supabase', () => ({
  isConfigured: () => false,
  supabase: null,
}))
vi.mock('./AuthContext', () => ({
  useAuth: () => ({
    // Even a stale or incorrectly supplied profile must not become authority without config.
    profile: { role: 'super_admin', name: 'Stale Admin', initials: 'SA' },
  }),
}))

const { RoleProvider, useRole } = await import('./RoleContext')

function RoleProbe() {
  const { role, activeClient, user } = useRole()
  return <div>{`${role}|${activeClient?.id ?? 'none'}|${user.name}`}</div>
}

describe('RoleProvider without Supabase configuration', () => {
  it('fails closed to a public user with no active client', () => {
    render(
      <RoleProvider>
        <RoleProbe />
      </RoleProvider>,
    )

    expect(screen.getByText('public|none|Guest')).toBeInTheDocument()
  })
})
