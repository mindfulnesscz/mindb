// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import MagicLinkConfirmationPage from './MagicLinkConfirmationPage'
import {
  buildMagicLinkVerificationUrl,
  parseMagicLinkConfirmationFragment,
} from './magicLinkConfirmation'

describe('magic-link confirmation values', () => {
  it('preserves the complete destination, including its own query parameters', () => {
    const result = parseMagicLinkConfirmationFragment(
      '#token_hash=hash%2Fwith%2Bsymbols&redirect_to=https://hub.example.com/ess?entity=Sofa&search=blue',
    )

    expect(result).toEqual({
      tokenHash: 'hash/with+symbols',
      redirectTo: 'https://hub.example.com/ess?entity=Sofa&search=blue',
    })
  })

  it('accepts the desktop loopback callback', () => {
    expect(parseMagicLinkConfirmationFragment(
      '#token_hash=desktop-hash&redirect_to=http%3A%2F%2Flocalhost%3A7623%2Fauth-callback',
    )).toEqual({
      tokenHash: 'desktop-hash',
      redirectTo: 'http://localhost:7623/auth-callback',
    })
  })

  it.each([
    '',
    '#token_hash=missing-redirect',
    '#redirect_to=https://hub.example.com',
    '#token_hash=hash&redirect_to=javascript:alert(1)',
    '#token_hash=%ZZ&redirect_to=https://hub.example.com',
  ])('rejects an incomplete or unsafe fragment: %s', fragment => {
    expect(parseMagicLinkConfirmationFragment(fragment)).toBeNull()
  })

  it('constructs a magic-link verification URL with an allowlisted return destination', () => {
    const result = new URL(buildMagicLinkVerificationUrl(
      'https://project.supabase.co',
      { tokenHash: 'one-time-hash', redirectTo: 'https://hub.example.com/ess?entity=Sofa' },
    ))

    expect(result.origin).toBe('https://project.supabase.co')
    expect(result.pathname).toBe('/auth/v1/verify')
    expect(result.searchParams.get('token')).toBe('one-time-hash')
    // `email` is the numeric-code flow and makes a magic-link token fail at Supabase Auth.
    expect(result.searchParams.get('type')).toBe('magiclink')
    expect(result.searchParams.get('redirect_to')).toBe('https://hub.example.com/ess?entity=Sofa')
  })
})

describe('MagicLinkConfirmationPage', () => {
  it('does not construct or visit the one-time verification URL before a human click', () => {
    const navigate = vi.fn()
    const { container } = render(
      <MagicLinkConfirmationPage
        fragment="#token_hash=one-time-hash&redirect_to=https%3A%2F%2Fhub.example.com%2Fess"
        supabaseUrl="https://project.supabase.co"
        navigate={navigate}
      />,
    )

    expect(navigate).not.toHaveBeenCalled()
    expect(container.querySelector('a[href*="/auth/v1/verify"]')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continue signing in' }))

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate.mock.calls[0][0]).toContain('https://project.supabase.co/auth/v1/verify?')
  })

  it('does not offer confirmation when the email URL is malformed', () => {
    render(
      <MagicLinkConfirmationPage
        fragment="#token_hash=missing-redirect"
        supabaseUrl="https://project.supabase.co"
      />,
    )

    expect(screen.getByText('This sign-in link is incomplete')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue signing in' })).not.toBeInTheDocument()
  })
})
