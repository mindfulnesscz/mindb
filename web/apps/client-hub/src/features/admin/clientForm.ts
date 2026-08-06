/* Client form state — the pure mapping between a Client row and the admin form.
 *
 * Extracted from AdminLandingPage so it can be tested without a DOM. `toSlug` in particular is a
 * published format, not a cosmetic detail: the slug is the client's portal URL (`/:slug`), so a
 * change here re-points a live link.
 */

import type { Client } from '@sotto/asset-library'

/* Mirrors the column default in 20260804120000_document_page_previews.sql and the pipeline's
   DEFAULT_PREVIEW_PAGE_LIMIT. All three must agree, or a client created here would render a
   different number of pages than the admin sees. */
export const DEFAULT_PREVIEW_PAGE_LIMIT = 50
/** The check constraint on the column. Enforced here too so the form reports it before the DB does. */
export const MAX_PREVIEW_PAGE_LIMIT = 500

/**
 * Parse the page-limit field, or null when it is not a usable value.
 *
 * Null means "do not send it", which leaves the stored value untouched — the same no-opinion rule
 * the pipeline uses for URLs. An out-of-range number is rejected rather than clamped: silently
 * turning 5000 into 500 hides a typo that the admin would otherwise notice.
 */
export function parsePreviewPageLimit(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null
  const n = Number(raw.trim())
  return n >= 0 && n <= MAX_PREVIEW_PAGE_LIMIT ? n : null
}

export interface ClientFormState {
  name: string; slug: string; initials: string; accent: string
  logoUrl: string; website: string; portalBg: string; domainWhitelist: string[]
  dimEntity: string; dimAngle: string; dimFormat: string
  /** Kept as a string so a half-typed value does not become NaN mid-edit. */
  previewPageLimit: string
}

export function getInitials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('')
}

/** Client name → portal URL segment. Changing these rules re-points existing portal links. */
export function toSlug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function emptyForm(): ClientFormState {
  return {
    name: '', slug: '', initials: '', accent: '#161616', logoUrl: '', website: '', portalBg: '',
    domainWhitelist: [], dimEntity: 'Entity', dimAngle: 'Angle', dimFormat: 'Format',
    previewPageLimit: String(DEFAULT_PREVIEW_PAGE_LIMIT),
  }
}

export function clientToForm(c: Client): ClientFormState {
  return {
    name: c.name, slug: c.slug ?? '', initials: c.initials, accent: c.accent,
    logoUrl: c.logoUrl ?? '', website: c.website ?? '', portalBg: c.portalBg ?? '',
    domainWhitelist: c.domainWhitelist ?? [],
    dimEntity: c.dimensionLabels?.entity ?? 'Entity',
    dimAngle:  c.dimensionLabels?.angle  ?? 'Angle',
    dimFormat: c.dimensionLabels?.format ?? 'Format',
    previewPageLimit: String(c.previewPageLimit ?? DEFAULT_PREVIEW_PAGE_LIMIT),
  }
}
