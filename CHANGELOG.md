# Changelog

All notable changes to DC Hub are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

---

## [2.1.0] — 2026-07-02  `feature/cloud-integration`

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

## [0.1.0] — 2026-06-18  *(initial commit)*

- `app.py` — Python pipeline script (distribute + publish)
- `vocab-manager.py` — vocabulary editor
- `vocabulary.json` — initial tag registry
