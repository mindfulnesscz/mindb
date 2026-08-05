/* Page previews for a document asset — the grid, and the lightbox it opens.
 *
 * A previewed PDF, deck or Word document publishes one WebP per rendered page. There is no page URL
 * column: the addresses are derived from the asset's thumbnail URL by `pageUrlsFromThumbnail`, so the
 * pages inherit whatever domain and access level the thumbnail already resolved to and cannot drift
 * from it. See that function for why deriving beats rebuilding.
 *
 * `previewPageCount` is what exists; `previewPageTotal` is what the document has. When the client's
 * page limit capped rendering the two differ, and the difference is surfaced rather than hidden —
 * a viewer who sees five pages of a forty-page report should know the other thirty-five exist and
 * that the download has them.
 */

import { useState } from 'react'
import { pageUrlsFromThumbnail } from '@dc-hub/domain'
import type { Asset } from '@dc-hub/asset-library'
import { ImageLightbox, type LightboxItem } from '../ImageLightbox'

export function DocumentPagesPanel({
  asset,
  onDownload,
}: {
  asset: Asset
  onDownload?: () => void
}) {
  const [openAt, setOpenAt] = useState<number | null>(null)

  const rendered = asset.previewPageCount ?? 0
  const total = asset.previewPageTotal ?? rendered
  const urls = pageUrlsFromThumbnail(asset.thumbnailUrl, rendered)

  /* Nothing to show for a raster, a video, or a document processed before page previews existed.
     Also covers the case where a count survives on the row but the thumbnail URL does not, which
     would otherwise render a grid of broken images. */
  if (urls.length === 0) return null

  const hiddenPages = Math.max(0, total - rendered)

  const items: LightboxItem[] = urls.map((src, i) => ({
    src,
    alt: `${asset.name} — page ${i + 1}`,
    // The cap is visible inside the viewer too, not only in the grid below it.
    title: `Page ${i + 1} of ${total}`,
    downloadUrl: asset.downloadUrl,
    assetId: asset.id,
  }))

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
          Pages
        </h3>
        <span className="text-[10px] font-sans text-text-muted">
          {hiddenPages > 0 ? `${rendered} of ${total}` : `${total} page${total === 1 ? '' : 's'}`}
        </span>
      </div>

      <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {urls.map((src, i) => (
          <li key={src}>
            <button
              type="button"
              onClick={() => setOpenAt(i)}
              aria-label={`Open page ${i + 1} of ${total}`}
              className="group block w-full overflow-hidden rounded-sm border border-border bg-surface-sunken transition-colors hover:border-cosmos-black focus:outline-none focus-visible:border-cosmos-black"
            >
              <img
                src={src}
                alt={`Page ${i + 1}`}
                /* Pages are small and numerous; letting the browser defer the ones below the fold
                   keeps a forty-page document from firing forty requests on open. */
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                className="block w-full h-auto"
              />
              <span className="block px-1 py-0.5 text-[9px] font-mono text-text-muted text-center">
                {i + 1}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {/* After the last available page: say what is missing and where to get it. */}
      {hiddenPages > 0 && (
        <p className="mt-2 text-[11px] font-sans text-text-muted">
          {`Showing the first ${rendered} of ${total} pages. `}
          {asset.downloadUrl ? (
            <a
              href={asset.downloadUrl}
              onClick={onDownload}
              className="underline decoration-dotted underline-offset-2 hover:text-cosmos-black"
            >
              Download the asset
            </a>
          ) : (
            'Download the asset'
          )}
          {' to see the rest.'}
        </p>
      )}

      {openAt !== null && (
        <ImageLightbox
          items={items}
          index={openAt}
          onClose={() => setOpenAt(null)}
          onIndexChange={setOpenAt}
          onDownload={onDownload ? () => onDownload() : undefined}
        />
      )}
    </div>
  )
}
