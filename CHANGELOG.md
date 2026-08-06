# Changelog

All notable changes to Sotto are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

---

## [3.2.2] — 2026-08-06

A hotfix for 3.2.1, which could not run a pipeline at all on a fresh install.

### Fixed

- **Native commands refused every real working folder.** A fresh 3.2.1 install failed each asset with
  `Refusing <x> outside Sotto's approved working directories`, and a run ended in hundreds of errors
  across thumbnails, CDN upload and collect. Two independent causes, both introduced with the S5
  command-surface hardening:
  - The folder pickers called `open({ directory: true })` without `recursive`, so Tauri granted only
    the picked folder and its immediate children. Every asset lives deeper than that — a source
    folder nests project / shoot / `OUT` — so the grant never covered the files the pipeline touches.
  - `path_policy` read the persisted working directories **only at startup**. On a fresh install the
    configuration is written afterwards, as clients are set up, so at boot there was nothing to grant
    and every native command refused for the rest of the session. The grants are now re-read once on
    a scope miss before refusing.

  The boundary itself is unchanged: roots still come only from Rust reading the machine-local
  configuration or from a folder the user picked, never from an IPC argument.

- **The filesystem capability is a deliberate scope again**, replacing 3.2.1's machine-wide `**`
  stopgap: `$HOME/**` + `/Volumes/**` + `$APPDATA/**`, declared once through `fs:scope` (the plugin
  unions the global scope with each command scope, so one declaration covers every command).
  `requireLiteralLeadingDot: false` stays in the fs plugin config — the plugin reads it only from
  there, it defaults to true on unix, and without it the globs stop matching `.dchub.json`.

  Note these are two independent mechanisms: `tauri-plugin-fs` seeds its runtime scope from
  `FsScope::default()` — empty — so capability globs are invisible to `path_policy` and vice versa.
  Changing one never fixes the other, which is why 3.2.1's `**` did not help the native commands.

- **Reconcile failures say why.** `cdn-reconcile` returns `failures[]` of `{asset_id, stage, reason}`
  and writes the same reason to `cdn_move_queue.last_error`; the desktop prints them as warnings
  under the run summary instead of the opaque `⟳ 0 moved · 2 failed`. Identical reasons are grouped,
  because one unset secret fails every video in the batch. An unset `CF_STREAM_TOKEN` now reads as
  "stream token not configured for this environment" rather than a bare failure.

### Added

- **Regression coverage for the bugs above**: the prune guard's four decisions for thumbnails and
  originals (red against the pre-fix behaviour), the `path_policy` re-read, the fs capability's
  shape, and an out-of-appdata pipeline smoke test that runs scan → identity → thumbnail → CDN
  upload against a **real** temp directory via the new `realFs` harness — the shape of path the
  in-memory `vfs` cannot represent, and the one 3.2.1 broke.

- **Build badge in both apps**, so which build and which backend is never a guess. The desktop shows
  the active environment and version in the nav rail; the portal pins the same pair to the corner —
  always for staff, and for everyone whenever the backend is not production. The portal derives its
  label from the Supabase project ref rather than a separate env var, so the badge cannot disagree
  with the backend it describes. See
  [which build am I looking at](docs/pages/reference/versioning.mdx).

### Documentation

- [Desktop native security](docs/pages/desktop/native-security.mdx) **dropped a claim that was no
  longer true.** It stated the filesystem capability "contains no repository-wide or machine-wide
  `**` rule" while 3.2.1 shipped exactly that on ten permissions. It now describes the real scope,
  and separates the two independent mechanisms that made the regression so hard to read.
- [Access levels](docs/pages/cloud-storage/access-levels.mdx) and
  [Video](docs/pages/cloud-storage/video.mdx) document what a reconcile failure reports, and why an
  environment can run for months before an unset `CF_STREAM_TOKEN` surfaces.
- [Testing](docs/pages/reference/testing.mdx) documents `realFs` — and, as importantly, what it
  cannot prove: Tauri's capability scope and `path_policy` do not exist under vitest, so the
  end-to-end check is still a packaged build on a clean profile.
- [Troubleshooting](docs/pages/operations/troubleshooting.mdx) gains entries for the two new
  diagnosable failures and for reading the build badge first.


## [3.2.1] — 2026-08-06

A security and correctness release. An external audit produced 42 findings; this closes all of them,
along with the regressions the first round of fixes introduced. Nothing here changes what the product
does — it changes what it refuses to do.

Two themes run through it. **Privileges are now enforced where they are checked**, not one layer
above: a member can no longer write their own `role`, a storage grant no longer covers the whole
bucket, and a portal caller can no longer assert which tenant they belong to. And **destructive
stages fail closed**: a transient read error, an unreadable folder, or a half-finished reconcile now
keeps files rather than deleting them.

### Added

- **CDN garbage collection.** Per-asset pruning only heals identities the desktop touches again;
  hard-deleted rows and never-revisited identities leave objects in both buckets that nothing points
  at. A dry-run-first collector now reads the whole bucket pair against every asset reference, with
  one shared classification behind three surfaces: `node scripts/gc-cdn-objects.mjs --env <dev|staging|production>`
  for operators, **Admin → CDN GC** for super admins, and a desktop settings card.

  Nothing is deleted without a fresh plan being reviewed and separately confirmed. Execution rebuilds
  the analysis, binds the confirmation to a deterministic plan id, re-checks the row snapshot
  immediately before deleting, and refuses any object not classified as an orphan. Disconnected rows
  and `branding/` are protected, and a blast-radius gate blocks execution rather than trusting an
  implausibly large plan. See [CDN garbage collection](docs/pages/operations/cdn-garbage-collection.mdx).
- **Scanner-safe magic links.** A corporate mail scanner (Microsoft Safe Links) prefetches the link
  and spends the token before the recipient clicks. Confirmation now happens on a page the user
  interacts with, and the link is verified against its matching type.
- **`file_md5` (Rust command)** — Google Drive publishes an MD5 for binary files, so the skip test can
  compare content instead of size. Hashed in Rust in 64 KiB chunks: the webview never loads the file.

### Fixed — security

- **A member could grant themselves `super_admin`.** The `profiles` self-update policy checked the
  row's owner but not which columns changed. It now runs `WITH CHECK` against a security-definer
  function that freezes `role`, `client_id` and `can_create_clients`; benign self-edits still pass. A
  pgTAP test asserts `42501` on each escalation attempt.
- **Storage grants were bucket-wide.** `r2-grant` minted credentials over the entire bucket for any
  editor. They are now prefix-scoped per client and tier (`{client_id}/`, `guest|client|internal/{client_id}/`),
  and a grant that would resolve to no prefix throws rather than widening.
- **Sign-up trusted caller-supplied tenancy.** `handle_new_user` read `client_id` out of
  `raw_user_meta_data` — anyone talking to Supabase Auth directly could name the tenant they joined.
  Tenancy is now derived only from the server-side `domain_whitelist`.
- **CORS matched `*.vercel.app` by suffix**, so any Vercel deployment could call the edge functions
  credentialed. Now exact allow-list membership.
- **The Tauri command surface was open.** Path-taking commands are confined by a new `path_policy`
  module (app data plus folders approved through a picker), `remove_dir_all` is forced to the exact
  `<stem>-thumb/` sidecar, `supabase_request` is bound to the configured origin and no longer follows
  redirects, the reveal bridge has an origin allow-list and an exact identity match, and `csp: null`
  is replaced by a real CSP with a network allow-list.
- **Native engine downloads were unverified.** Every PDFium and LibreOffice artifact now carries a
  real sha256; an unpinned entry hard-fails the fetch, and the cache is validated by digest.
- **The admin UI failed open** when unconfigured, and portal permission gates disagreed with the
  documented matrix.

### Fixed — data loss and correctness

- **The cross-level prune deleted objects the portal was still serving.** When an asset moved tier,
  the prune excluded the asset's own row from the "still referenced" check, assuming the same run
  would repoint the database. If the reconcile did not fully land, the live object was deleted
  anyway — observed as `pruned stale thumbnail (was public)` for keys the database still pointed at.
  An object is now kept while **any** live row references it, including its own, and pruned only once
  it is a genuine orphan. Reclaiming cross-level orphans is a separate, reference-checked pass.
- **"Dry run" was not dry.** It skipped some stages and not others. It is now threaded through every
  side-effecting stage: CDN uploads and prunes, Supabase inserts/patches/disconnects, manifest writes,
  Stream, version history, tag sync and cloud uploads.
- **A transient read error deleted live files.** An unreadable directory was indistinguishable from
  an empty one, so reconcile treated "cannot list" as "nothing there". Unreadable subtrees are now
  marked protected and skipped, on both source and target sides.
- **A failed read of existing rows produced duplicate inserts** — the export planner now aborts
  before planning rather than treating "unknown" as "absent".
- **Tag sync could delete portal-authored tags** from a stale source. The delete pass is now behind
  the blast-radius guard and locked at the caller while the source is dirty.
- **`mtime` skips lost edits.** A same-size, same-mtime change is now caught by a byte comparison in
  Rust after the cheap gate; raster thumbnails key on a `src_mtime+size+width+quality` fingerprint
  instead of mere existence.
- **The Stop button did not stop.** `isStopping` is now checked at every stage checkpoint.
- **Google Drive created duplicate folders** under concurrent uploads (list-then-create with no
  in-flight dedup), and skipped changed files of identical size. Folder creation is deduped in flight
  and the skip test now compares MD5.
- **Two assets sharing a filename stem overwrote each other's `download_urls`.** Cloud URLs are keyed
  by `stableId:childId` — the asset's real identity — everywhere they are written and read.
- **A portal-editable tag label became path structure.** A label containing `/` or `..` flowed
  unescaped into a filesystem path; `sanitizeSegment` now normalises every user-editable label used as
  a path segment, including reserved Windows device names.
- **Rename tasks were a placebo** — the queue flipped `pending → completed` and applied nothing.
  Removed, rather than left reporting success it never delivered.
- **Large images failed to decode.** A 9922×14104 TIFF hit the image crate's 512 MiB default; the
  budget is now 2 GiB, with files ≥32 MiB serialised behind a mutex so eight concurrent decodes cannot
  peak at 16 GiB and kill the app. Three compile-time assertions pin the budget between the measured
  floor and a sane ceiling.
- **A failed thumbnail showed the browser's broken-image glyph** in four places that still rendered a
  bare `<img>`. All four now degrade to a named placeholder with a download link.
- **Unstable pagination** — `fetchAllForClient` now orders by `id`, so a page boundary cannot drop or
  repeat a row.
- **A revoked session left the portal looking signed in.** An access token stays signature-valid after
  its session row is revoked (a password change, a sign-out elsewhere, a reset database), so reads
  kept working while every GoTrue-resolving call refused — **Admin → CDN GC** answered "Not
  authenticated" beneath a header showing a super admin. Backends now distinguish "your session ended"
  from "you are not signed in", and the portal ends the session instead of rendering the contradiction.
  This mattered most where it was least visible: the CDN cookie renews on a timer, so a dead session
  meant an endless 401 loop behind blank gated thumbnails. See
  [Revoked sessions](docs/pages/auth.mdx).

### Changed

- **The fs capability is a deliberate static scope again.** Replacing it with runtime grants broke
  real working folders — a `~/Library/CloudStorage/Dropbox-…` source was refused, which surfaced as
  "no folder identity" on every asset rather than as a permission error. The command-surface
  hardening (`path_policy`, CSP) is unaffected and stays.
- **CI gates are no longer vacuous.** A new `e2e` job boots the full Supabase stack; `smoke:functions`
  and `test:e2e` hard-fail on a missing stack instead of passing green, and a 404 no longer counts as
  "booted".
- **One shared caller-auth vocabulary** in `@sotto/domain`, used by the edge functions, the cdn-gate
  Worker and the portal. Three backends answer the same question and one portal acts on the answer; a
  drifted copy of those strings fails silently.
- Workflow `permissions:` blocks are least-privilege (6/6), and `cdn-reconcile`'s scheduled `dry_run`
  defaults to `true`.

### Documentation

- **Where OAuth provider credentials live, per environment** — the clearest description of the local
  mechanism was in a gitignored file, so a fresh clone never saw it. Local is `config.toml` +
  `.env.local` (now with a committed example), staging and production are each project's dashboard.
  Includes the `set -a; source supabase/.env.local; set +a` step, the Entra permissions and expiry
  failure, and a warning against `supabase config push` at a shared project.
- Keychain credential storage, CDN garbage collection, revoked sessions, and the Google Drive skip
  rules are documented; `permissions.mdx` now matches `permissions.ts`, and the README describes the
  real test suite.


## [3.2.0] — 2026-08-04

Thumbnails need nothing installed, and a document can be paged through in the portal. The rendering
engines ship inside the app — no `brew install`, no missing-tool errors — and PDFs, decks and Word
documents now publish a preview per page alongside the title thumbnail.

### Changed — the app is now **Sotto**

Every user-facing reference: app name, window title, `SOTTO` wordmark, npm scope (`@sotto/*`), crate
and binary (`sotto-app`), docs. Three identifiers deliberately keep the old name because renaming each
costs data or breaks identity, and none is ever shown to anyone:

| Kept | Why |
|---|---|
| `com.disruptcollective.dc-hub` | The macOS bundle identifier **is** the app-data path. Renaming points the app at an empty directory — environments, settings, client configs, vocab caches, R2 upload cache. |
| `.dchub.json` | Per-folder asset identity (183 manifests in the ESS library alone). Renaming re-mints `child_id`s, changes every R2 key, orphans published URLs and detaches comments. |
| `dc-hub-*` R2 buckets | Cannot be renamed in place; would mean copying the library and repointing every stored URL. |

Two stored keys are **migrated**, not just renamed, because a rename alone reads as data loss:
`sotto-auth-<host>` carries an existing session across so nobody is signed out, and
`sotto_supabase_*` falls back to the old keys so a manually configured browser is not left saying
"not configured".

### Added

- **Bundled render engines.** LibreOffice (MPL-2.0, ~800MB) and PDFium ship with the app on macOS and
  Windows; on Linux LibreOffice is a declared `.deb`/`.rpm` dependency, so the package manager
  installs it and the user still touches no terminal. Fetched per-platform by
  `scripts/fetch-native-deps.mjs` (`npm run deps:native`), never committed, cached in CI. Pinned to
  LibreOffice 26.2.x — the line whose deck rendering was reviewed. **Treat a major bump as a visual
  change**, not a dependency update: re-render real decks and compare first. See
  [Third-party engines](docs/pages/reference/third-party-engines.mdx).
- **`npm run build:app`** — builds a distributable bundle. Use it instead of `npm run tauri build`,
  which now produces an app with **no LibreOffice**: it works on the build machine, which has one
  installed, and fails on a clean one.
- **Per-page document previews.** A PDF, PowerPoint or Word document gets `<stem>-thumb.webp` as
  before plus a `<stem>-thumb/` folder of `001.webp…`, published to a new `pages/` R2 namespace and
  shown as a page strip in the portal that opens the existing lightbox. Spreadsheets render one page:
  a wide sheet paginates into dozens of near-empty slices. Word and Excel also gain thumbnails, which
  they never had.
- **`clients.preview_page_limit`** (default 50, 0 disables) — an admin sets it per client in the
  client admin. `assets.preview_page_count` and `preview_page_total` are separate columns on purpose:
  when the limit caps rendering the portal shows what it has and says *"Showing the first 5 of 40
  pages. Download the asset to see the rest."* One column could render the pages it had but could not
  tell a capped document from a short one.
- **`npm run smoke:functions`** — asserts every Supabase edge function boots. They are Deno modules
  outside every tsconfig, so nothing else in the repo type-checks or runs them. Wired into CI; use
  `--fresh` locally, because the runtime caches a module on first import and ignores later edits.

### Changed

- **Rendering happens in-process.** `cwebp` and `pdftoppm` are gone, replaced by statically-linked
  libwebp and bundled PDFium. Both were resolved from `PATH`, which a packaged app does not inherit —
  see Fixed. Release output beats the old `cwebp` on every asset measured (a 16000×9000 JPEG: 850ms →
  535ms).
- **PDF rasterisation runs in a worker process, one per document.** PDFium keeps process-global state
  and **cannot** be used concurrently: with eight threads on eight *different* documents, all 160
  renders failed. One worker per document, not per page, so process spawn amortises across its pages —
  233 pages/s at 8-way for multi-page documents.
- **Page objects are moved and their sources deleted when an access level changes.** They appear in no
  URL column, so both movers (`cdn-reconcile`, `scripts/rekey-gated-objects.mjs`) were blind to them.
  Unlike a thumbnail, a superseded page cannot be left behind: with no column to repoint it stays
  readable at the old, wider level. Orphaned is not unreachable.

### Fixed

- **`cwebp not found` on every asset in a packaged build.** An app launched from Finder/Dock/Explorer
  inherits the OS's minimal `PATH`, so Homebrew's prefix is invisible to it — the tools resolved under
  `tauri dev` and failed in the DMG. Engines are now resolved by absolute path through
  `desktop/src-tauri/src/native.rs`.
- **Thumbnailing was ~75× slower in `tauri dev`.** `cwebp` was an optimised binary, so the build
  profile never mattered; now the work is Rust and an unoptimised build took **21s** on an 8000×4500
  JPEG. `[profile.dev.package."*"] opt-level = 3` is load-bearing — do not remove it.
- **A previews folder was collected as an asset.** `<stem>-thumb/` inherits the long-standing
  `-thumb` exclusion, but only if it is applied before a walker branches on file-vs-directory — the
  page files are `001.webp` and carry no `-thumb`. Two walkers checked only files: `pipeline/fs.ts`
  would have packaged and uploaded the pages as assets, and `dam/scan.ts` would have given every
  previewed document a spurious vault note.
- **A large image failed to thumbnail with "Memory limit exceeded".** The `image` crate's default
  decode budget is 512 MiB, which a real asset exceeded: `falling-up@600x.tif`, 9922x14104 RGB, needs
  534 MiB for its final buffer alone and more again for TIFF strips. Raised to 2 GiB — measured: 1024
  MiB still failed, 1536 succeeded in ~100ms. Deliberately bounded rather than unlimited, and large
  decodes now take a gate so only one runs at a time: the pipeline renders eight thumbnails in ONE
  process, so a 2 GiB per-image budget would otherwise be a 16 GiB peak and kill the app instead of
  reporting one asset. Compile-time assertions keep the budget above the measured floor.
- **A failed thumbnail showed the browser's broken-image glyph**, which reads as a broken product
  rather than a missing preview. Any thumbnail that 401s or 404s — or was never generated — now
  degrades to a placeholder naming the asset with a **Download** link, because a missing preview is
  not a missing asset. Adopted at the four places that still rendered a bare `<img>`: gallery cards,
  the hover strip, disconnected sub-assets, and the document page strip.
- **An environment without the migration could not sync assets at all.** PostgREST rejects the whole
  write when one column is unknown (`PGRST204`), so sending the new page-count fields to a database
  that had not had the migration failed the **parent** row — and every child then skipped for want of
  a `parent_id`. One additive metadata column stopped an entire package from syncing. The export now
  probes once per run and withholds the two fields when they are absent, logging that it did; the same
  over-reach in `CLIENT_IDENTITY_SELECT` broke client loading outright and is likewise fixed. Both have
  regression tests.
- **A page sweep jammed `cdn_move_queue`, which broke video.** The first version listed R2 with
  credentials scoped `object-read-write`, which does not permit `ListBucket`. Every asset was marked
  failed and nothing was dequeued — and because the same pass sets Cloudflare Stream's
  `requireSignedURLs`, video playback and animated thumbnails stopped working. Pages are now addressed
  from the recorded count, a missing source is silence rather than a failure, and the stream flag is
  reconciled first so it cannot be starved.


## [3.1.1] — 2026-08-03

Desktop release CI installs the full workspace again, so a version tag can produce a
macOS `.dmg` instead of dying on `eslint: command not found`.

### Fixed

- **`release-desktop.yml`** — ran `npm ci` only under `desktop/`, then root `npm run check`.
  Root `.bin` (eslint and the rest) was empty, so tagged builds failed with exit 127 and
  never uploaded installer artifacts. Now uses `npm run setup` like `check.yml`, caches
  both lockfiles, and installs the clippy component for `lint:rust`.


## [3.1.0] — 2026-08-03

The portal's views are addressable. A filtered grid, an open asset, the focused frame and the
lightbox all live in the URL, so a view can be sent to someone, survives a reload and a
magic-link round trip, and Back does what it should.

### Added

- **Filter params on `/:slug`** — `?q= &latest= &status= &perm= &type= &entity= &format= &angle=`.
  Multi-value params are **repeated** (`?entity=Sofa&entity=Chair`), never comma-joined: tag labels
  are free text from a client's own vocabulary, and a comma inside one would otherwise split it into
  two tags silently. Names are stable dimension **keys**, never a client's renamed
  `dimensionLabels`, so a rename cannot break links already sent.
- **`/:slug/a/:assetId`** — the detail drawer is a route. Cold-loads the grid and the drawer
  together. The id may be a gallery child or a format variant, neither of which is ever a card in
  the grid; it resolves upwards and opens the parent with that row focused, which is what makes a
  link forwarded out of someone's lightbox work.
- **`?focus=<uuid>` and `?lb=1`** on the detail route — the focused child or variant, and the
  lightbox. Ids, not indices: a position would point at a different picture the moment a sibling is
  added or disconnected. A link copied mid-scrub opens on the frame that was on screen.
- **`filterUrl.ts`** in `@sotto/asset-library` — `filtersToSearchParams`, `searchParamsToFilters`,
  `filterCacheKey`. Canonical output, tolerant input: a value outside the allowed vocabulary is
  dropped rather than forwarded to PostgREST, which rejects the whole query on an unknown enum.
- **`ASSET_STATUSES`, `ASSET_PERMS`, `ENTITY_TYPES`** — the three closed vocabularies as const
  arrays, types derived from them. A parser cannot validate against a type.
- **A real data cache** (TanStack Query), replacing a `JSON.stringify` key compared inside an
  effect, a ref to decide whether to show a skeleton, and a counter to force refetches. The cache
  key **is** the canonical URL string, so Back and Forward hit warm cache by construction.

### Fixed

- **A magic-link error no longer wipes the view it was returning to.** `ClientPortalPage`'s
  auth-error handler stripped the query string along with the hash. Harmless while the portal had no
  addressable state; from this release it would have discarded exactly the filtered view the
  recipient was sent.
- **`npm run lint` on a developer machine.** ESLint was linting bundled vendor code under
  `supabase/.temp/` and `.wrangler/tmp/` — both gitignored, so CI stayed green while the gate failed
  locally with ~200 errors.

### Changed

- A filter change no longer closes the open drawer. The open asset used to be looked up in the
  current list, so filtering it out closed the drawer under the viewer.

### Removed

- `AppLayout` and `ActivityView` — imported by nothing, with nav pointing at routes that do not
  exist. The routing work chose sibling routes over a nested `<Outlet/>` shell, which is what
  `AppLayout` was for.


## [3.0.0] — 2026-07-28

Folder-based stable identity is now the only identity. The shortcode-matching path that
predated it is gone, along with every one-time upgrade shim around it. Every asset package
on disk already carried a `__<hash>` folder suffix and a `.dchub.json` manifest, so the old
path had no remaining input — it only added ways to go wrong.

**Apply `supabase/migrations/20260728120000_drop_legacy_identity.sql` before running this
build.** It drops the constraint the build stops satisfying.

### Removed

- **Shortcode identity path** — the two-phase upsert keyed on `(client_id, shortcode)`, its
  existing-row map, URL-preservation pass, and the hard-delete stale sweep (~330 lines).
  Rows are matched on `(stable_id, child_id)` and written by row id; a vanished folder is
  soft-disconnected, never deleted, so ratings, comments, approvals and events survive.
- **`clients.identity_migrated`** and all its plumbing. There is nothing left to gate.
- **Shortcode suffixes** — `assets.shortcode` no longer carries `__<hash>:c<N>`. That was a
  duplicate of the row's own `stable_id`/`child_id` columns, glued on so the dropped unique
  constraint would accept two assets rendering the same display text. `shortcode` is now
  purely a display string; `stable_id` and `child_id` are `not null`.
- **Filename-based CDN keys** — thumbnails and originals key only on stable identity. An
  asset outside a hashed package folder is reported and skipped rather than uploaded under a
  key that a rename would strand.
- **CDN inventory pre-population** — parsed the old `thumbnails/{stem}-thumb.webp` key shape,
  so it had already stopped matching anything. URL preservation is handled by omitting absent
  URL fields from the PATCH.
- **`legacy_aliases`** vocabulary aliasing, the `subtype`/`obsidian_tag` tag-shape migration,
  the `clients.json` → DB client adoption (plus vocab-file re-key), the `clients.json`/
  `auth-server.json` environment bootstrap, the `exportPackages`/`flatExport` destination
  fields, the `dam:links_start` note-block stripper, the `'client'` → `'member'` role mapping,
  `migrate-identity.ts`, and two unused bundled `vocabulary.json` seeds.

### Changed

- **Version history** is keyed `(stable_id, shortcode)` instead of shortcode alone. Display
  text repeats across packages, so the old key silently merged two unrelated assets' history
  into whichever was scanned last.
- **Gallery parent slots** in `.dchub.json` are keyed by folder path only; the shared
  `__gallery_parent__` key is gone (existing manifests were migrated in place).

### Fixed

- Gallery children synced with their folder path baked into name, shortcode and CDN lookup
  key (`Gallery/(DC)(M5)(Gll) 03`), which failed the vocabulary parser and matched no
  thumbnail — blank, untagged children in the portal. Regression from `abb496f`, which fixed
  only the stable-identity branch.
- The Obsidian step no longer scans the vault, so a vault nested inside a client's source
  folder can't feed on its own notes — that recursion generated notes about notes, one
  directory level deeper per run.
- A scaffolded asset's reserved `c1` can now actually be claimed by the real file (or by a
  gallery parent, when the deliverable turns out to be a folder of files). The extension
  match against the extensionless placeholder never succeeded, so every scaffolded asset
  minted `c2` and left its draft row behind as a phantom primary.
- **Two packages holding a same-named file or gallery folder no longer collide.** Grouping
  keyed its package-dir and file-path lookups by bare stem, so the second package overwrote
  the first: one package's assets were skipped silently — no error, no log — and then
  disconnected on the next run. Live on two clients (Mucha Family's two `Deda Energie`
  packages sharing `plyn.pdf`/`elektrika.pdf`; four ESS packages each holding an `Old/`
  gallery). Identity now travels on each item instead of through shared stem-keyed maps,
  which also retires `IdentityContext`.

## [2.4.2] — 2026-07-24

- Packages fixed: wiping target packages in export locations, and source folder instead of disconnecting (the reason is that these packages are deplatable).
- Auth with Github, Google and Microsoft. Currently only on web

## [2.4.1] — 2026-07-13

Deployment plumbing and field fixes shaken out while standing up staging and running production against the new auth/storage model.

### Added

- **`bootstrap-env` tool** (`npm run bootstrap:env`) — provisions a hosted environment (a new tier or a whole new agency instance) in one idempotent pass: link + `db push`, functions deploy, function secrets, Auth site-URL/redirect allow-list via the Management API (config as code), invite-based founding admin, and an optional first client with storage + membership. Config lives in a gitignored per-environment file (`scripts/environments/<name>.env`) — no secrets or flags typed on the command line. Dry-run by default; a production ref is refused without `--i-know-its-prod`.
- **Docs: Tags & export destinations workflow** — where to edit taxonomy (parent groups vs leaves) and portal-owned cloud destinations; desktop Sync / OAuth / Reveal bridge; linked from platform division, admin, cloud-storage, and `CLOUD_DESTINATIONS.md`.

### Changed

- CI deploys on **every** push to `main`/`staging`, not only pushes that touch `supabase/**` — a path filter previously let a migration or function already on the branch never actually deploy ("merged but not deployed").
- Desktop sign-in loopback window widened 3 → 10 minutes, since hosted-project magic-link email lands in a real inbox slower than the local Mailpit.
- Desktop cloud destinations UI is credentials-only (structure from portal Sync); asset detail surfaces role-gated source links and optional Reveal in Finder.

### Fixed

- Portal CDN images now load with `referrerPolicy="no-referrer"` (and the download fetch too), so a hotlink-protected CDN serves them as it would a direct hit.
- Documented the CDN blank-image failure modes (hotlink protection, relative/hostless URLs from an empty `r2_public_domain`, 403 missing object, download-as-`.html`) with the null-URLs-then-re-run fix for the stale-skip trap.
- **Package sync mirrors OUT** — Distribute / nested package export always take highest version from sibling OUT, hard-delete orphans in the source package (no `🚫` there), and never keep thumbnails in source packages. Publish destinations still use `🚫` disconnect.
- **CDN browser cache after version bumps** — public URLs append `?v=<content-hash>`; uploads set immutable long cache; DB inventory alone no longer skips re-verification.

### Docs

- Pipeline, distribution, CDN, settings, and environments docs updated for package OUT mirror and CDN cache-busting; tag label-rename notes in taxonomy / tags-and-destinations.

## [2.4.0] — 2026-07-12

Authentication, environments, a credential-free desktop, and the production deployment pipeline. The desktop is gated behind staff sign-in, clients are database-first, no permanent secret exists on any workstation, and the portal ships continuously.

### Added

**Desktop authentication** (authentication-plan Phases 1–3)

- Staff-only login gate: magic link with PKCE via the system browser and the `:7623` loopback callback; sessions persist and auto-refresh; sign-out in the nav rail
- `client_members` assignment table + `clients.identity_migrated` — the identity flag lives in the database, closing the config-drift path to legacy hard-deletes
- **Every Supabase operation runs as the signed-in user under RLS** — the service-role key no longer exists in the desktop; privileged sync fails closed when signed out
- **`r2-grant` Control API** (first edge function): validates session → role → client assignment, then issues 1-hour bucket-scoped R2 credentials via Cloudflare's temporary-access API; bucket + public domain are server-authoritative on the client row; Rust signs `x-amz-security-token` on every R2 command
- Secret-free client exports (`_version: 2.0`); importing an old bundle strips credentials and warns to rotate; anon-key fields reject `sb_secret_*`/service-role keys outright

**Environments & DB-first clients**

- Environments (Local / Staging / Production) as first-class connection configs with switchers on the login screen, in Settings, and in the client picker — switching re-authenticates, making cross-tier mixups structurally impossible
- Clients are fetched from the database per environment (membership-filtered; admins see all) and managed by admins in the picker form (name, colour, storage); machine-local config (folders, OAuth tokens, logo) attaches per `(environment, client)`; legacy `clients.json` migrates automatically including vocab-file re-keying

**Local development stack & database workflow**

- Supabase CLI workflow: consolidated baseline migration verified against production, replayable from zero with seed (demo client, seeded admin `admin@acme.test`, taxonomy, sample assets); `db:start/reset/types` scripts; Docker setup guide
- Migrations CI: PR replay validation; `staging` branch deploys the staging project; `main` deploys production behind approval; edge functions deploy alongside

**Deployment**

- Portal on Vercel (`web/vercel.json`): SPA rewrites, workspace build; production at `hub.disruptcollective.com`, `staging.` branch domain, previews per push; backend switching for local dev via committed Vite mode files (`dev:web:prod`, `dev:web:staging`)
- Desktop releases: version tags build the Tauri `.dmg` on macOS CI into a draft GitHub Release (unsigned pending an Apple Developer ID)
- Three-branch model: `dev` (checks) → `staging` (hosted rehearsal) → `main` (production)

### Fixed

- Production `assets.entities` was TEXT holding JSON strings — converted to a real `text[]` with a GIN index
- Two production-only functions (`get_all_profiles`, `update_user_role`) captured into migrations; production grants gap on new tables repaired with default privileges
- Gallery stuck on skeletons in dev against a real backend (StrictMode double-mount vs a ref-deduped fetch effect)
- Extension-pair stems produced a self-referencing `variant_of` that hid entire asset groups
- Environment switch could strand the app on a blank screen (stale auth client teardown + session-check timeout + visible boot splash)
- Client-load failures now surface in the picker instead of masquerading as an empty list
- Portal build errors that would have failed every deploy (dead password login view, untyped rpc calls)
- Local auth redirects (magic links bounced to `:3000`; portal runs on `:5173`)

---

## [2.3.0] — 2026-07-11

Repository cleanup ahead of the refactoring phase.

### Removed

- `python/` — the legacy v1 CustomTkinter pipeline (superseded by the Tauri app since 2.0.0), including `vocab-manager.py` and migration utilities
- `dc-hub-desktop/` — stray build-cache directory
- `desktop/src/services/airtableService.ts` — Airtable predecessor kept "for reference" since 2.1.0; unreferenced, preserved in git history
- Stray `.DS_Store` files and stale ignore rules

---

## [2.2.0] — 2026-07-11

Folder-based stable identity, CDN originals, and a major R2 sync correctness/performance pass.

### Added

**Folder-based stable identity** (gated per client via `identityMigrated`; live on ESS since 2026-07-09)

- `__hash` package-folder suffix as a rename-proof asset anchor; per-folder `.dchub.json` manifest maps filenames → stable `child_id`s with SHA-256 content-hash fallback for renamed files
- `stableId.ts`, `assetGrouping.ts` domain modules; `scripts/migrate-identity.ts` scaffolds existing folders and maps legacy DB rows
- Two relationship kinds: `parent_id` (gallery grid) vs `variant_of` (rendition picker); variant groups roll shared tags up onto a generically-named primary
- Stale stable-identity rows are soft-marked `disconnected` instead of hard-deleted — ratings/comments/history survive disk churn
- Per-package `readme.md` snapshot (`readmeService.ts`) with taxonomy and feedback stats

**CDN originals**

- `runOriginalUpload` pipeline step — uploads original files to R2 under version-stable keys (`originals/{stableId}/{childId}.ext`, legacy fallback `originals/{shortcode}.ext`), synced to `assets.download_url` for the portal's download button
- Local R2 upload cache (mtime+size+sha256) — unchanged files skip with zero network calls

**Misc**

- `notifyService.ts` — run-completion notifications
- `CLOUD_DESTINATIONS.md` — destination model documentation

### Fixed

- **R2 sync speed**: one upfront `list_r2_keys` manifest per prefix replaces a per-file HEAD + per-file LIST; `upload_to_r2` skips the HEAD when the caller's cached hash or the manifest already answers; shared keep-alive `reqwest` client (was a fresh TLS handshake per request); async file reads; upload concurrency 3→8
- **URL wipe on sync**: cache-skipped uploads never populated the URL maps, so every Supabase sync overwrote `download_url`/`thumbnail_url` with null (268 + 415 nulled rows on ESS). Cached skips now record their deterministic public URL, and the sync fills/omits instead of nulling — a cached or disabled upload phase can no longer erase URLs the DB already has
- **Extension-pair identity collision**: files differing only by extension (`foo.pdf` + `foo.webp`) collapsed to one stem → one child key, deleting each other's R2 original every run. Identity now resolves per file (filename-keyed), and the stale-sibling cleanup can never delete a key claimed by the current run
- **Old versions uploading to CDN**: version files left in OUT all mapped to the asset's single version-stable key and overwrote each other every run. Both CDN steps now upload only the highest version per base+ext (per directory), logged as `⊘ N older version file(s) excluded from CDN`
- **Version bumps splitting identity**: `resolveChildId` gained a version-lineage tier (filename → content-hash → version-stripped base+ext → new), so a version bump keeps its asset's child id, DB row, feedback, and CDN key
- CDN upload logs now show the destination object key (`✓ file.pdf → originals/…/c2.pdf`)
- **Web portal download button did nothing**: the handler silently returned when `downloadUrl` was empty (see the URL-wipe fix above). It now fetches the file to a blob so the browser's save dialog works for cross-origin CDN URLs, falls back to opening the URL directly, and reports when an asset has no published file (`web/apps/client-hub/src/lib/assetActions.ts`). R2 bucket CORS (`GET`/`HEAD` from `*`) configured in Cloudflare to enable the blob path

### Changed

- Repos merged into the **mindb monorepo** (`desktop/` + `web/` + `docs/`, histories preserved) with one canonical version at the root — `scripts/version.mjs` propagates it to every manifest, CI enforces consistency (previously desktop alone disagreed with itself: 0.1.0 / 2.0.0 / 0.1.0 / 2.1.0)
- `docs/pages/pipeline.mdx` — CDN upload section rewritten for the new behavior: highest-version-only eligibility, manifest/cache skip mechanics, per-file stable-identity keys, guarded stale-sibling cleanup
- This file is the **single changelog** for all parts (desktop, web, docs); the short-lived per-part changelogs were folded in here

---

## [2.1.0] — 2026-07-02 `feature/cloud-integration`

Major feature release: Supabase DAM backend, Cloudflare R2 CDN, multi-client system, cloud destinations, and repo reorganisation.

### Added

**Supabase DAM integration**

- `supabase_request` Rust command — proxies all Supabase HTTP calls via native `reqwest`, bypassing Supabase's browser-key restriction (service_role key would 401 from a WebView context)
- `supabaseService.ts` — full pipeline sync replacing Airtable: upsert assets, sync version history, archive stale records
- `resolveClientId` — auto-bootstraps the client row in Supabase on first run; no manual DB setup needed
- Upsert strategy: unique constraint on `(client_id, shortcode)`; shortcode renames archive the old record and create a new one
- Version history: upserts on `(asset_id, version)`, transitions records to `Disconnected` or `Removed` when no longer found on disk
- `checkSupabaseConnection` — connection ping used by Settings UI

**Cloudflare R2 CDN**

- `r2.rs` Rust module: `upload_to_r2`, `check_r2_connection`, `list_r2_keys`, `delete_r2_object`
- Per-client R2 config: endpoint, access key, secret key, bucket, public domain
- CDN URLs written into `assets.download_urls` in Supabase after upload

**Cloud destinations**

- `CloudDestination` model — multiple destinations per client (local, Dropbox, OneDrive, GDrive)
- `internal` vs `client` destination roles; flat export and generate-link flags
- `upload_to_dropbox` Rust command + OAuth flow via `wait_for_oauth_redirect` (localhost:7623)
- `cloud.rs` Rust module for cloud upload operations
- `CloudDestinations.tsx` — destinations panel in Settings

**Client management**

- `client.ts` domain — replaces the old per-settings Airtable fields with a full Client model
- `clientStore.ts` — Zustand store for multi-client state
- `clientService.ts` — persist and load client configs from tauri-plugin-store
- `ClientPickerModal.tsx` — client picker in Pipeline view
- Per-client: source folder, target folder, vault folder, cloud destinations, Supabase credentials, R2 credentials

### Changed

- `Client` domain model: removed `airtableBaseId`, `airtableToken`, `airtableTable`; added `supabaseUrl`, `supabaseServiceKey`, `supabaseAnonKey`, `r2Endpoint`, `r2AccessKeyId`, `r2SecretKey`, `r2Bucket`, `r2PublicDomain`
- `SettingsView.tsx`: Supabase config fields replace Airtable fields; new R2 section
- `PipelineView.tsx`: wired to `resolveClientId` + `exportAssetsToSupabase` + `syncVersionHistory`; client picker integrated
- `pipelineService.ts`: "Airtable" references updated; cloud URL collection passed to Supabase sync
- `Cargo.toml`: added `reqwest` (with TLS features) and `tokio` for async Rust HTTP
- `capabilities/default.json`: network permissions updated for Supabase and R2 endpoints
- NavRail: clients and cloud views added

### Removed

- Airtable dependency from the pipeline (service is kept as `airtableService.ts` for reference)
- `fix_v1.py`, `patch_v1.py` — legacy migration scripts no longer needed

### Repo

- `dc-hub-python/` moved out of the git-tracked repo (standalone directory, no `.git`)
- `dc-hub-migration/design_handoff_dc_hub/` moved out of the tracked repo
- `dc-hub-desktop/` is now the repo root; `dc-hub/` is the Tauri project inside it
- Added `README.md` and `CHANGELOG.md` at repo root

---

## [2.0.0] — 2026-06-21

Complete rebuild of the Python v1 POC as a native desktop app.

### Added

- Tauri 2 + React 19 + TypeScript + Vite 7 desktop app
- Zustand state management (appStore, pipelineStore, vocabularyStore, settingsStore)
- DC design system: Commissioner variable font, Minion Pro Medium, `tokens.css` design tokens
- NavRail — 84px fixed left rail, Cosmos Black, icon + label navigation
- **Pipeline view** — 3-zone layout: config sidebar + live activity log + issues panel; distribute + publish + thumbnail + Obsidian export actions; stats strip
- **Vocabulary view** — dimension tabs (Entity / Angle / Format), collapsible subtype groups, edit modal
- **Generator view** — 3 dimension panels + result rail; builds a compliant filename from tag selections
- **Settings view** — in-app screen (not modal); folder paths, cloud auth, feature toggles
- Rust commands: `generate_thumbnail` (PPTX/PDF → WebP via LibreOffice + pdftoppm + cwebp), `wait_for_oauth_redirect` (localhost:7623 OAuth listener, 3-min timeout)
- `pipelineService.ts` — distribute and publish logic ported from Python to TypeScript
- `vocabService.ts` — vocabulary read/write, tag resolution, Obsidian tag inheritance
- `settingsService.ts` — maps both snake_case (Python legacy) and camelCase settings formats
- `damService.ts` — Obsidian vault builder
- Vocabulary seeded from Python POC's `vocabulary.json`, bundled as Tauri resource

---

## [1.1.0] — 2026-06-18

### Added

- Tag inheritance: `obsidian_tag` field accepts space-delimited values; each tag implies its broader parent categories in the Obsidian vault (e.g. `Bnn` generates `#banner #print`)
- Dimension language: dimension names formalised as Entity / Angle / Format

---

## [1.0.0] — 2026-06-18

First versioned release of the Python pipeline.

### Added

- Round-bracket `()` filename parsing
- Legacy alias resolver: `_`, `+-`, `~`, `=` prefixes silently remapped via `legacy_aliases`
- Updated taxonomy with subtype prefix rules (`p-`, `c-`, `x-`, `e-`)
- Semantic versioning in filenames: `vMAJOR-MINOR-PATCH`
- Export renaming: shortcodes translated to human-readable labels on deploy to SharePoint / OneDrive

---

## [0.1.0] — 2026-06-18 _(initial commit)_

- `app.py` — Python pipeline script (distribute + publish)
- `vocab-manager.py` — vocabulary editor
- `vocabulary.json` — initial tag registry
