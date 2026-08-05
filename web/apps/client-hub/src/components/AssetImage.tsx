/* A CDN thumbnail that degrades to a placeholder instead of a broken-image icon.
 *
 * WHY THIS EXISTS. Row visibility and byte delivery are separate gates, so an asset can be perfectly
 * visible while its pixels are not. `perm='guest'` is exactly that case: RLS returns the row to any
 * signed-in user, but the image comes from the gated bucket through the `cdn-gate` Worker, which wants
 * the CDN cookie — and answers 401 without it. The same happens to any gated URL opened in a context
 * that has no cookie yet.
 *
 * The browser's own answer to a 401 on an `<img>` is the broken-image glyph, which reads as "this
 * product is broken" rather than "you are not signed in for this". `/share/:id` is where that lands in
 * front of someone who has never seen the app before, so it is worth a component.
 *
 * Deliberately NOT a retry or a sign-in prompt. The cookie is fetched app-wide by `useCdnCookie` from
 * `AuthContext` already; if it is not there, a second request will not conjure it, and a component
 * that guessed at *why* an image failed would be inventing an authorization answer on the client.
 */

import { useState } from 'react'

export function AssetImage({
  src,
  alt,
  className,
  /** Extra classes for the placeholder box, which needs the same footprint as the image. */
  fallbackClassName,
}: {
  src: string
  alt: string
  className?: string
  fallbackClassName?: string
}) {
  /* The failure is remembered against the URL that produced it, not as a bare boolean. A carousel
     reuses this component instance as it steps, so a plain `failed` flag set on one gated frame would
     show the placeholder for every frame after it. */
  const [failedSrc, setFailedSrc] = useState<string | null>(null)

  if (failedSrc === src) {
    return (
      <div
        className={`flex items-center justify-center bg-gray-150 ${fallbackClassName ?? className ?? ''}`}
        role="img"
        aria-label={`${alt} — preview unavailable`}
      >
        <span className="text-[10px] font-sans uppercase tracking-label text-text-muted px-2 text-center">
          Preview unavailable
        </span>
      </div>
    )
  }

  return (
    <img
      referrerPolicy="no-referrer"
      src={src}
      alt={alt}
      className={className}
      onError={() => setFailedSrc(src)}
    />
  )
}
