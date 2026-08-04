/* A `clients` row, projected into the shape both apps actually use.
 *
 * WHY THIS IS SHARED
 * The database owns client identity — name, accent, logo, dimension labels. Desktop and the portal
 * both read that row and both turned it into a domain object, separately, and the two drifted:
 *
 *   - desktop hand-wrote its own `DbClientRow` interface, so the schema could change without any
 *     type error appearing (a hand-written row type cannot drift *loudly*);
 *   - desktop selected five columns, the portal selected all of them, so a field added to the portal
 *     was simply absent on desktop with nothing to say so;
 *   - `dimension_labels` arrives as `Json` and was defaulted in two places, with two sets of literals;
 *   - one column ended up with two names: `accent` in the database and the portal, `brandColor` on
 *     desktop.
 *
 * So the projection lives here, once, next to the generated types it reads. Desktop's `Client` adds
 * its machine-local fields on top of `ClientIdentity`; the portal's `Client` *is* `ClientIdentity`.
 * That is the shape of the standing goal — the portal as a slightly limited desktop, not a parallel
 * implementation of the same row.
 */

import type { ClientRow, Json } from './index.js'

export interface DimensionLabels {
  entity: string
  angle:  string
  format: string
}

export const DEFAULT_DIMENSION_LABELS: DimensionLabels = {
  entity: 'Entity',
  angle:  'Angle',
  format: 'Format',
}

/**
 * Every column a client's identity is read from. Shared so the two apps cannot select different
 * subsets — the failure that made a portal field silently invisible on desktop.
 */
export const CLIENT_IDENTITY_SELECT =
  /* `preview_page_limit` is deliberately NOT here. This list is shared with the desktop, which runs
     against Production, Staging and Local — and PostgREST rejects the WHOLE query with
     "column does not exist" against any database where the migration has not been applied yet. That
     broke client loading entirely ("Could not load clients"), which is a far worse failure than not
     knowing a page limit. The pipeline reads the limit through `fetchPreviewPageLimit`, which is a
     separate query that degrades to the documented default; the portal admin reads it via
     `select('*')`. Add a column here only once every environment is guaranteed to have it. */
  'id,name,accent,initials,slug,logo_url,website,portal_bg,domain_whitelist,dimension_labels'

/** The portal-owned facts about a client. Machine-local state (folders, tokens) is never in here. */
export interface ClientIdentity {
  id:               string
  name:             string
  slug?:            string
  accent:           string
  initials:         string
  logoUrl?:         string
  website?:         string
  portalBg?:        string
  domainWhitelist?: string[]
  dimensionLabels:  DimensionLabels
  /** Pages of a document the pipeline renders previews for. 0 disables page previews entirely.
   *
   *  Optional because several places construct a client identity for DISPLAY — the portal header,
   *  test fixtures — where the limit is irrelevant and inventing one would be noise. `toClientIdentity`
   *  always fills it from the row, so anything reading a real client gets a number. */
  previewPageLimit?: number
}

/**
 * `dimension_labels` is typed `Json` by the generator, so it is unknown-shaped at compile time and
 * partial at runtime — a client may have renamed one dimension and left the others. Each label falls
 * back on its own; an all-or-nothing default would silently discard the one rename that was made.
 */
export function toDimensionLabels(value: unknown): DimensionLabels {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_DIMENSION_LABELS }
  const l = value as Partial<Record<keyof DimensionLabels, unknown>>
  const pick = (k: keyof DimensionLabels) =>
    typeof l[k] === 'string' && (l[k] as string).trim() ? (l[k] as string) : DEFAULT_DIMENSION_LABELS[k]
  return { entity: pick('entity'), angle: pick('angle'), format: pick('format') }
}

export function toClientIdentity(row: ClientRow): ClientIdentity {
  return {
    id:              row.id,
    name:            row.name,
    slug:            row.slug ?? undefined,
    // `accent` is NOT NULL with a default in the schema, but an older row read through a narrower
    // select can still arrive as null — hence the fallback rather than a bare assertion.
    accent:          row.accent || '#161616',
    initials:        row.initials,
    logoUrl:         row.logo_url ?? undefined,
    website:         row.website ?? undefined,
    portalBg:        row.portal_bg ?? undefined,
    domainWhitelist: row.domain_whitelist,
    dimensionLabels: toDimensionLabels(row.dimension_labels),
    /* NOT NULL with a default in the schema, but a row read through a narrower select — or one from
       before the column existed — can still arrive undefined. Falls back to the same value as the
       column default; see DEFAULT_PREVIEW_PAGE_LIMIT in the pipeline, which must agree. */
    previewPageLimit: row.preview_page_limit ?? 50,
  }
}

/**
 * Labels on their way BACK into the `dimension_labels` column.
 *
 * `Json` requires an index signature and `DimensionLabels` deliberately does not have one — being
 * exactly three known keys is the point. So the conversion needs one cast, and it lives here rather
 * than at each write site, where it was being spelled differently every time.
 */
export function dimensionLabelsToJson(labels: DimensionLabels): Json {
  return { ...labels } as unknown as Json
}
