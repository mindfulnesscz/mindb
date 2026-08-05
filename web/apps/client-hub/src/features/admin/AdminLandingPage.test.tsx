// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/supabase', () => ({
  isConfigured: () => false,
  supabase: null,
}))
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    session: null,
    profile: null,
    loading: false,
    signOut: vi.fn(),
  }),
}))

const { default: AdminLandingPage } = await import('./AdminLandingPage')

describe('AdminLandingPage without Supabase configuration', () => {
  it('shows a locked state instead of the admin dashboard', () => {
    render(<AdminLandingPage />)

    expect(screen.getByRole('heading', { name: 'Admin unavailable' })).toBeInTheDocument()
    expect(screen.getByText(/not configured for Supabase sign-in/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Users' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clients' })).not.toBeInTheDocument()
  })
})
