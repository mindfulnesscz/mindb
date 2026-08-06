# Project rules — Sotto

## ⛔ NEVER RESET OR WIPE A DATABASE WITHOUT ASKING FIRST

**Applies to every environment, including local.** Ask, and wait for an answer, before running anything
that destroys data:

- `npm run db:reset` / `supabase db reset` — drops and reseeds; **wipes local data**
- `supabase stop --no-backup`, `supabase db push` against a shared project, destructive SQL
  (`truncate`, `delete` without a narrow filter, `drop`)

Local is NOT scratch space. It holds hours of set-up that the seed does not recreate: `stream_uid`
values for provisioned Cloudflare Stream videos, generated thumbnails and page previews, R2 upload
caches, vocabulary, and a tenant configured by hand. A reset looks harmless and then presents as a
feature being broken — this has already happened twice, most recently wiping every `stream_uid` so
video playback and animated thumbnails stopped working locally, which read as a code regression and
cost a long hunt in the wrong place.

To apply a new migration WITHOUT destroying data, use `supabase migration up` (applies pending
migrations only). Reach for `db:reset` only when the user has asked for a clean slate.

The release path is **local → staging → production**, verified at each step. Never suggest deploying
to a shared environment to "see if it works".

- **This folder IS the project.** Project root: `/Users/petrmucha/Sites/localhost/dc-hub`.
- Always ensure filesystem access to this folder at the start of a session (request it if not already connected). There is no relevant content in the Obsidian vault — the project lives here.
- Architecture reference: `docs/pages/` (see `desktop/cdn.mdx`, `cloud-storage/security.mdx`, `getting-started/architecture.mdx`).
- Identity is `stable_id` + `child_id` (v3.0.0). Never reintroduce filename-keyed lookups.

## Native render engines (2026-08-04)

- **Never shell out to a helper binary by bare name.** A packaged app inherits the OS's minimal PATH, so anything resolved from PATH is invisible to it even when installed — that shipped once as `cwebp not found` on every asset. Engines are bundled and resolved by absolute path through `desktop/src-tauri/src/native.rs`, which is the only module that knows where they live. Add new engines to `scripts/fetch-native-deps.mjs` + `native.rs`.
- **PDFium cannot be used concurrently in one process.** Not slow — it fails (8 threads on 8 distinct documents: 160/160 `FormatError`, then segfaults). Every PDF rasterisation runs in a one-shot worker process (`render::WORKER_FLAG`). Do not "simplify" this back into threads.
- **Thumbnail speed depends on the build profile**, now that rendering is Rust rather than `cwebp`. `[profile.dev.package."*"] opt-level = 3` in `desktop/src-tauri/Cargo.toml` is load-bearing — without it a large JPEG takes 21s instead of 0.25s. Do not remove it.
- LibreOffice is bundled (MPL-2.0, ~800MB) on macOS/Windows and a package dependency on Linux. In a **release** build on macOS/Windows the bundled copy is the ONLY copy: `render.rs::soffice_from` hard-errors instead of falling back to `/Applications` or `PATH`, because a silent fallback works on every dev machine and fails only on a client's. Host fallbacks survive for Linux and `tauri dev` (`cfg!(debug_assertions)`) only. `package-desktop.mjs` and the release workflow both assert the placed `soffice` is executable in the finished `.app`.
- **Never set `LSUIElement`/`LSBackgroundOnly` in the nested `LibreOffice.app/Contents/Info.plist`** to keep it out of the Dock — it breaks the sealed signature `ditto` preserves, which notarisation requires. The flag set (`--headless --invisible --nodefault --nologo --nolockcheck --norestore`) is the only lever; `soffice.bin` directly is the next step if it ever proves insufficient.
- **Every subprocess gets a deadline.** The LibreOffice conversion and the PDFium worker both run under `render.rs::output_with_timeout` (60s, child killed on expiry). Without one, a hung conversion holds a pipeline worker slot forever. Never go back to a bare `.output()`.
- See `docs/pages/reference/third-party-engines.mdx` for licence obligations and the macOS signing order.

## OUT folder layout — render artifacts (2026-08-06)

- **One `thumbnails/` folder sits beside the files it serves** — never nested per asset, never named per asset. `OUT/thumbnails/` for the files directly under OUT, `OUT/<gallery>/thumbnails/` for gallery children. It holds `<stem>-thumb.webp`, the hidden `.<stem>-thumb.webp.json` render cache, and `<stem>/` for a document's page previews (`001.webp` … `.pages.json`). A document's title thumbnail is just another thumbnail; it does not get a folder of its own.
- **LOCATION decides what is an artifact, not the name.** `isPreviewArtifact` (`packages/domain/src/artifactLayout.ts`) is the single gate, and every walker applies it to a directory ENTRY before branching on file-vs-directory — the page files are called `001.webp` and carry no marker, so a filter applied to files alone publishes them to a client as assets. The `-thumb` substring test survives inside that predicate only as the migration safety net for unmigrated libraries; do not build anything new on it, and do not add a fourth copy of the path rules — compose from `thumbPathFor`/`pagesDirFor`.
- **The manifests are caches, not metadata.** Delete them and the whole library re-renders (~6.4s per Office document). They are hidden by a leading dot, which Windows does not honour (`FILE_ATTRIBUTE_HIDDEN`) — accepted, because Sotto ships macOS only; set it in `render.rs` when a Windows build is added. Do not consolidate them into one file per folder: eight render workers writing one manifest is last-writer-wins.
- **Moving artifacts locally costs nothing on the CDN.** R2 keys come from folder identity (`stable_id`/`child_id`), never from a local path, so the migration in `pipeline/artifactMigration.ts` re-keys nothing and orphans nothing. It is a move, not a regenerate: the manifests travel, so nothing re-renders.

## Tauri command threading (2026-08-06)

- **Any command that blocks must be `#[tauri::command(async)]`.** Tauri v2 runs a command declared without the `async` keyword *on the main thread*, which is the OS event loop — so a sync command doing real work freezes the window for its whole duration (that shipped as 3.2.2's beachball: ~6.4s per Office document, a window that would not repaint). It also silently defeats the pipeline's 8-at-a-time batching, because every sync command serialises onto that one thread. `(async)` moves a *sync* fn to a worker thread with no change to its body or to any call site. Do **not** convert to `async fn` instead — that parks blocking work on the async runtime's executor, which is the same bug in a different place. Trivial commands (keychain, reveal) stay sync deliberately.

## Native command security (2026-08-05)

- Path-taking Rust commands must pass canonical paths through `desktop/src-tauri/src/path_policy.rs`. The allowed roots are app data plus folders approved through a Tauri folder picker; persisted machine-local client roots are read by Rust at startup **and re-read once on a scope miss** — a startup-only pass grants nothing on a fresh install, where the config is written after launch (that shipped as 3.2.1 refusing every working folder). Never replace this with an arbitrary IPC-supplied root or a lexical `starts_with` check.
- **Folder pickers must pass `recursive: true`.** `open({ directory: true })` alone makes Tauri grant only `<dir>` and `<dir>/*`, so anything deeper is refused by `path_policy` — and every asset is deeper. `desktop/src/components/folderPickerScope.test.ts` fails if any call site drops it.
- **The JS fs capability and `path_policy` are two different scopes.** `tauri-plugin-fs` builds its runtime scope from `FsScope::default()` (empty) and fills it only from `allow_directory`/`allow_file`, so capability globs are invisible to `path_policy` and vice versa — changing one never fixes the other. The capability declares its roots once via `fs:scope` (`$HOME/**`, `/Volumes/**`, `$APPDATA/**`; the plugin unions global + per-command scopes). Never widen it back to `**`, and never move `requireLiteralLeadingDot: false` out of `tauri.conf.json` → `plugins.fs` — the plugin reads it only from there, it defaults to true on unix, and without it the globs stop matching `.dchub.json`. Guarded by `desktop/src/app/fsCapability.test.ts`.
- Per-page previews may only replace the exact `<dir>/thumbnails/<stem>/` directory COMPUTED from the source path (see the artifact layout below). `render::validate_preview_area` runs in both the Tauri command and the one-shot PDFium worker immediately before `remove_dir_all`; keep that worker-local check, and never relax it into a prefix test — "somewhere under `thumbnails/`" lets one document's render delete another's pages.
- `supabase_request` is restricted to the active origin in the persisted environment configuration and does not follow redirects. Adding another native proxy must preserve the same destination binding before it forwards authorization headers.
- The reveal bridge accepts JSON `POST /reveal` only from the production, staging, and local portal origins. Its manifest lookup is an exact parsed `stable_id` match. Update the bridge allowlist when a new portal origin is deployed; never restore wildcard CORS or substring identity matching.
- The desktop CSP has an explicit network allowlist. When a provider endpoint changes, update `connect-src` narrowly and document why; do not set CSP back to `null` or broaden it to all HTTPS origins.

## Storage / delivery model (as of 2026-07-31)

- **R2** = source-of-truth originals for the whole asset library (download) + CDN for thumbnails. **Two buckets.** `R2_BUCKET` on `R2_PUBLIC_DOMAIN` holds only `public`-level objects and they ARE bearer links — anyone with the URL can fetch them, and a published URL can never be un-published. `R2_GATED_BUCKET` has no public access at all and is reachable only through the `cdn-gate` Worker on `R2_GATED_DOMAIN`. `?v=<hash>` is cache-busting on both, never auth.
- **Cloudflare Stream** (shipped 2026-08-03) = video playback + stills/animated previews, keyed to the asset row via `stream_uid`. R2 keeps the master; Stream is added alongside, never instead. A gated video is protected by `requireSignedURLs`, which **does** cover the thumbnail endpoints (measured) — so a video's level lives in that flag exactly as an image's lives in its object key, and `cdn-reconcile` flips it when the level changes. See `docs/pages/cloud-storage/video.mdx`.
- **`perm`** (`public` / `guest` / `client` / `internal`) is enforced by Postgres RLS on `public.assets` and controls **discovery**. Byte-level protection **is implemented** (2026-07-31): the `cdn-gate` Worker authorizes each fetch from a signed cookie plus the object key, with no database lookup.
- **Access = `perm` AND `status`.** `assets.effective_level` is a generated column: `(status in ('approved','published')) ? perm : 'internal'`. A `public` asset still in `draft` is staff-only.
- **The level is encoded in the object key**, so changing `perm`/`status` MOVES the bytes. The pipeline writes each asset at its current level; `.github/workflows/reconcile-cdn-keys.yml` heals drift. Key rules live in `packages/domain/src/assetStorage.ts` — use that module, never a fourth copy of the rules.
- A gallery's images **inherit the parent's level** (DB trigger). Variants follow by default, with an opt-out.
- **Three object namespaces**: `thumbnails/` and `originals/` (one object per asset) and `pages/` (one object per rendered page of a document, for the portal's page viewer). Page objects are derived bytes and carry the document's level. They have **no URL column** — the portal derives each address from `thumbnail_url` via `pageUrlsFromThumbnail`, so they cannot drift from the thumbnail's level. Both re-key paths find them by LISTING and **delete the source**, unlike thumbnails/originals: with no column to repoint, a leftover page sits readable at the old, wider level.
- **Reconcile residue is healed per asset by the desktop.** `cdn-reconcile` leaves thumbnail/original sources in place for reversibility; after confirming the current target, the next upload prunes that identity from every non-current level, while retaining keys another live row references. Hard-deleted or never-touched-again identities are handled by the dry-run-first bucket collector: super admins use web **Admin → CDN GC** or desktop **Settings → CDN garbage collection**, and operators can run `node scripts/gc-cdn-objects.mjs --env <dev|staging|production>`. All surfaces use the shared domain classification, protect disconnected references plus `branding/`, report the complete two-bucket plan, and require a separately confirmed execution; see `docs/pages/operations/cdn-garbage-collection.mdx`.
- See `docs/pages/cloud-storage/access-levels.mdx`.
