# Changelog

All notable changes to the DC Hub web portal are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

---

## [0.1.0] — 2026-07-11

Initial tracked release: client portal monorepo (`apps/client-hub` + `packages/asset-library` + `supabase/`).

### Added

- **client-hub** — Vite + React portal: gallery with taxonomy filtering, asset detail drawer (ratings, comments, approvals, view/download counters), client/admin views, Supabase Auth sign-in
- **asset-library** — shared types, filter logic, permission helpers (`canDownload` et al.), mock data
- **supabase/** — schema, RLS policies, and migration scripts (`add_stable_identity`, `add_download_url`, `add_download_key`, `add_asset_events`, `add_primary_tags`, …)

### Fixed

- **Download button did nothing** (2026-07-11): the handler silently returned when `asset.downloadUrl` was empty — and it usually was, because the desktop sync was wiping `assets.download_url` (fixed desktop-side in DC Hub 2.2.0). The handler now fetches the file to a blob so the browser's save dialog works for cross-origin CDN URLs, falls back to opening the URL directly when CORS blocks the fetch, and tells the user when an asset has no published file instead of failing silently (`src/lib/assetActions.ts`)

### Known issues

- R2/CDN bucket has no CORS policy yet — until one is added in the Cloudflare dashboard (allow `GET`/`HEAD` from the portal origin or `*`), downloads fall back to opening in a new tab rather than a forced save dialog
