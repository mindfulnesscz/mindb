# Project rules — DC Hub

- **This folder IS the project.** Project root: `/Users/petrmucha/Sites/localhost/dc-hub`.
- Always ensure filesystem access to this folder at the start of a session (request it if not already connected). There is no relevant content in the Obsidian vault — the project lives here.
- Architecture reference: `docs/pages/` (see `desktop/cdn.mdx`, `cloud-storage/security.mdx`, `getting-started/architecture.mdx`).
- Identity is `stable_id` + `child_id` (v3.0.0). Never reintroduce filename-keyed lookups.

## Native render engines (2026-08-04)

- **Never shell out to a helper binary by bare name.** A packaged app inherits the OS's minimal PATH, so anything resolved from PATH is invisible to it even when installed — that shipped once as `cwebp not found` on every asset. Engines are bundled and resolved by absolute path through `desktop/src-tauri/src/native.rs`, which is the only module that knows where they live. Add new engines to `scripts/fetch-native-deps.mjs` + `native.rs`.
- **PDFium cannot be used concurrently in one process.** Not slow — it fails (8 threads on 8 distinct documents: 160/160 `FormatError`, then segfaults). Every PDF rasterisation runs in a one-shot worker process (`render::WORKER_FLAG`). Do not "simplify" this back into threads.
- **Thumbnail speed depends on the build profile**, now that rendering is Rust rather than `cwebp`. `[profile.dev.package."*"] opt-level = 3` in `desktop/src-tauri/Cargo.toml` is load-bearing — without it a large JPEG takes 21s instead of 0.25s. Do not remove it.
- LibreOffice is bundled (MPL-2.0, ~800MB) on macOS/Windows and a package dependency on Linux. Bundled resolution must win over any host install: the shipped version is the one whose deck rendering was reviewed. See `docs/pages/reference/third-party-engines.mdx` for licence obligations and the macOS signing order.

## Storage / delivery model (as of 2026-07-31)

- **R2** = source-of-truth originals for the whole asset library (download) + CDN for thumbnails. **Two buckets.** `R2_BUCKET` on `R2_PUBLIC_DOMAIN` holds only `public`-level objects and they ARE bearer links — anyone with the URL can fetch them, and a published URL can never be un-published. `R2_GATED_BUCKET` has no public access at all and is reachable only through the `cdn-gate` Worker on `R2_GATED_DOMAIN`. `?v=<hash>` is cache-busting on both, never auth.
- **Cloudflare Stream** (shipped 2026-08-03) = video playback + stills/animated previews, keyed to the asset row via `stream_uid`. R2 keeps the master; Stream is added alongside, never instead. A gated video is protected by `requireSignedURLs`, which **does** cover the thumbnail endpoints (measured) — so a video's level lives in that flag exactly as an image's lives in its object key, and `cdn-reconcile` flips it when the level changes. See `docs/pages/cloud-storage/video.mdx`.
- **`perm`** (`public` / `guest` / `client` / `internal`) is enforced by Postgres RLS on `public.assets` and controls **discovery**. Byte-level protection **is implemented** (2026-07-31): the `cdn-gate` Worker authorizes each fetch from a signed cookie plus the object key, with no database lookup.
- **Access = `perm` AND `status`.** `assets.effective_level` is a generated column: `(status in ('approved','published')) ? perm : 'internal'`. A `public` asset still in `draft` is staff-only.
- **The level is encoded in the object key**, so changing `perm`/`status` MOVES the bytes. The pipeline writes each asset at its current level; `.github/workflows/reconcile-cdn-keys.yml` heals drift. Key rules live in `packages/domain/src/assetStorage.ts` — use that module, never a fourth copy of the rules.
- A gallery's images **inherit the parent's level** (DB trigger). Variants follow by default, with an opt-out.
- **Three object namespaces**: `thumbnails/` and `originals/` (one object per asset) and `pages/` (one object per rendered page of a document, for the portal's page viewer). Page objects are derived bytes and carry the document's level. They have **no URL column** — the portal derives each address from `thumbnail_url` via `pageUrlsFromThumbnail`, so they cannot drift from the thumbnail's level. Both re-key paths find them by LISTING and **delete the source**, unlike thumbnails: with no column to repoint, a leftover page sits readable at the old, wider level.
- See `docs/pages/cloud-storage/access-levels.mdx`.
