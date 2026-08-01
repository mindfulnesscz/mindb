import type { AssetActions, Asset } from '@dc-hub/asset-library'
import { reportError } from './reportError'
import { isGatedUrl } from '../services/cdnGate'

export const webAssetActions: AssetActions = {
  download: async (asset: Asset) => {
    const url = asset.downloadUrl
    if (!url) {
      // A missing URL means the desktop pipeline hasn't published this original yet.
      console.warn(`Asset "${asset.name}" (${asset.id}) has no download_url`)
      window.alert('This file has no download available yet — it will appear after the next publish run.')
      return
    }
    try {
      // The anchor `download` attribute is ignored for cross-origin URLs (the CDN),
      // so fetch to a blob first. Requires CORS on the R2 public domain.
      // no-referrer so a hotlink-protected CDN treats this like a direct hit.
      //
      // Credentials are sent ONLY to the gated CDN, and that distinction is load-bearing rather
      // than tidiness. A gated original needs the cookie or the Worker refuses it; a PUBLIC-tier
      // URL must not be asked for credentials at all, because the public buckets answer with
      // `Access-Control-Allow-Origin: *` and the browser rejects a wildcard origin outright on a
      // credentialed request. Sending them everywhere breaks every existing download — and breaks
      // it quietly, the only symptom being that the save dialog silently becomes a new tab via the
      // fallback below. See isGatedUrl.
      const res = await fetch(url, {
        referrerPolicy: 'no-referrer',
        credentials: isGatedUrl(url) ? 'include' : 'same-origin',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = asset.name
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
    } catch (err) {
      // No CORS or network failure — hand the URL to the browser directly so the
      // user still gets the file, just without a forced save dialog.
      reportError('asset.assetActions.download(blob)', err)
      window.open(url, '_blank', 'noopener')
    }
  },
  // openInFolder: desktop only — not available in the web build
}
