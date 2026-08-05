/* The `clients` row projection — now the only one, so it carries both apps.
 *
 * Before this existed, desktop and the portal each mapped the row themselves and had drifted: desktop
 * read five columns, the portal read all of them, and `dimension_labels` was defaulted in three
 * places with three copies of the literals. The tests that matter here are the ones about the shape
 * the database actually hands over — `Json`, nullable columns, partial objects — because that is where
 * two independent implementations disagree.
 */

import { describe, it, expect } from 'vitest'
import {
  toClientIdentity, toDimensionLabels, dimensionLabelsToJson,
  CLIENT_IDENTITY_SELECT, DEFAULT_DIMENSION_LABELS,
} from './clients.js'
import type { ClientRow } from './index.js'

const row = (over: Partial<ClientRow> = {}): ClientRow => ({
  id: 'c1',
  name: 'ESS Pricing',
  accent: '#2E6E4E',
  initials: 'EP',
  slug: 'ess',
  logo_url: null,
  website: null,
  portal_bg: null,
  domain_whitelist: [],
  dimension_labels: null,
  cloud_destinations: null,
  created_at: '2026-07-30T00:00:00Z',
  ...over,
} as unknown as ClientRow)

describe('toClientIdentity', () => {
  it('maps snake_case columns onto the camelCase shape both apps use', () => {
    const c = toClientIdentity(row({
      logo_url: 'https://cdn/logo.png', website: 'https://ess.test', portal_bg: '#fff',
      domain_whitelist: ['ess.test'],
    }))

    expect(c).toMatchObject({
      id: 'c1', name: 'ESS Pricing', accent: '#2E6E4E', initials: 'EP', slug: 'ess',
      logoUrl: 'https://cdn/logo.png', website: 'https://ess.test', portalBg: '#fff',
      domainWhitelist: ['ess.test'],
    })
  })

  it('turns nullable columns into undefined, not null', () => {
    // The domain type uses optional properties; leaking null means every consumer needs `?? undefined`
    // and one of them will forget.
    const c = toClientIdentity(row({ slug: null, logo_url: null, website: null, portal_bg: null }))
    expect(c.slug).toBeUndefined()
    expect(c.logoUrl).toBeUndefined()
    expect(c.website).toBeUndefined()
    expect(c.portalBg).toBeUndefined()
  })

  it('falls back to a usable accent — a null one would paint the UI with "null"', () => {
    // NOT NULL in the schema, but a row read through a narrower select can still arrive without it.
    expect(toClientIdentity(row({ accent: null as unknown as string })).accent).toBe('#161616')
    expect(toClientIdentity(row({ accent: '' })).accent).toBe('#161616')
  })

  it('always produces complete dimension labels, so consumers need no fallbacks', () => {
    expect(toClientIdentity(row()).dimensionLabels).toEqual(DEFAULT_DIMENSION_LABELS)
  })
})

describe('toDimensionLabels', () => {
  it('keeps a full set as given', () => {
    expect(toDimensionLabels({ entity: 'Product line', angle: 'Story', format: 'Medium' }))
      .toEqual({ entity: 'Product line', angle: 'Story', format: 'Medium' })
  })

  it('defaults each label INDEPENDENTLY', () => {
    // The rule that all-or-nothing defaulting gets wrong: a client who renamed one dimension and left
    // the others must keep that one rename.
    expect(toDimensionLabels({ entity: 'Product line' }))
      .toEqual({ entity: 'Product line', angle: 'Angle', format: 'Format' })
  })

  it('treats a blank or whitespace-only label as absent', () => {
    // An empty string would render as an unlabelled filter group.
    expect(toDimensionLabels({ entity: '', angle: '   ', format: 'Medium' }))
      .toEqual({ entity: 'Entity', angle: 'Angle', format: 'Medium' })
  })

  it('survives every non-object the Json column can hold', () => {
    // The generator types this column as `Json`, so at runtime it may be anything at all.
    for (const junk of [null, undefined, 'Entity', 42, true, [], ['a']]) {
      expect(toDimensionLabels(junk)).toEqual(DEFAULT_DIMENSION_LABELS)
    }
  })

  it('ignores non-string values inside the object', () => {
    expect(toDimensionLabels({ entity: 123, angle: { nested: true }, format: null }))
      .toEqual(DEFAULT_DIMENSION_LABELS)
  })

  it('returns a fresh object each time — the default must not be mutable by a caller', () => {
    const a = toDimensionLabels(null)
    a.entity = 'Mutated'
    expect(toDimensionLabels(null).entity).toBe('Entity')
    expect(DEFAULT_DIMENSION_LABELS.entity).toBe('Entity')
  })
})

describe('dimensionLabelsToJson', () => {
  it('round-trips through the Json column', () => {
    const labels = { entity: 'Product line', angle: 'Story', format: 'Medium' }
    expect(toDimensionLabels(dimensionLabelsToJson(labels))).toEqual(labels)
  })

  it('copies rather than aliasing, so a later edit cannot reach a pending write', () => {
    const labels = { ...DEFAULT_DIMENSION_LABELS }
    const json = dimensionLabelsToJson(labels)
    labels.entity = 'Changed'
    expect((json as { entity: string }).entity).toBe('Entity')
  })
})

describe('CLIENT_IDENTITY_SELECT', () => {
  it('names every column the projection reads', () => {
    // The guard against the original bug: desktop selected five columns and silently had no website,
    // portal background or domain whitelist. If a field is added to the projection it must be added
    // here too, or it arrives undefined with nothing to say so.
    const columns = CLIENT_IDENTITY_SELECT.split(',')
    for (const needed of [
      'id', 'name', 'accent', 'initials', 'slug', 'logo_url',
      'website', 'portal_bg', 'domain_whitelist', 'dimension_labels',
    ]) {
      expect(columns).toContain(needed)
    }
  })

  /* The other direction, and it cost a broken desktop: this list is sent to Production, Staging AND
     Local, and PostgREST rejects the WHOLE query with "column does not exist" against any database
     missing one of them. Adding `preview_page_limit` here made every environment without the
     migration fail with "Could not load clients" — no client list at all, for a page-count setting.
     A column belongs here only once every environment is guaranteed to have it; anything newer is
     read by its own query that can degrade. */
  it('omits columns that may not exist in every environment yet', () => {
    for (const tooNew of ['preview_page_limit']) {
      expect(CLIENT_IDENTITY_SELECT).not.toContain(tooNew)
    }
  })

  it('is a bare column list — it is interpolated into a select, not parsed', () => {
    expect(CLIENT_IDENTITY_SELECT).not.toMatch(/\s/)
    expect(CLIENT_IDENTITY_SELECT).not.toMatch(/[*();]/)
  })
})
