/* Client form state — the pure mapping between a Client row and the admin form.
 *
 * Extracted from AdminLandingPage so it can be tested without a DOM. `toSlug` in particular is a
 * published format, not a cosmetic detail: the slug is the client's portal URL (`/:slug`), so a
 * change here re-points a live link.
 */

import type { Client } from '@dc-hub/asset-library'

export interface ClientFormState {
  name: string; slug: string; initials: string; accent: string
  logoUrl: string; website: string; portalBg: string; domainWhitelist: string[]
  dimEntity: string; dimAngle: string; dimFormat: string
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
  }
}
