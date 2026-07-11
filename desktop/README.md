# DC Hub Desktop

Tauri 2 desktop app for the DC Hub asset pipeline (see the [monorepo README](../README.md) for the product overview). Processes, versions, distributes, and syncs marketing assets across cloud storage and a Supabase DAM backend.

Version history lives in the root [CHANGELOG.md](../CHANGELOG.md); the version workflow in [VERSIONING.md](../VERSIONING.md).

---

## What it does

1. **Organise** — assets follow a strict bracket-tag naming convention (`(Entity)(Angle)(Format) Description vX-Y-Z.ext`) enforced by the vocabulary registry
2. **Distribute** — copies assets from source → internal and client-facing destinations (local folders, Dropbox, OneDrive, Google Drive)
3. **Publish to CDN** — uploads to Cloudflare R2, returns public CDN URLs
4. **Sync to DAM** — upserts asset metadata and version history into Supabase; powers the web portal
5. **Generate thumbnails** — PPTX and PDF → WebP sidecars via LibreOffice + pdftoppm + cwebp
6. **Build Obsidian vault** — generates markdown notes with inherited taxonomy tags for the DAM

---

## Architecture

```text
desktop/                      ← this directory (Tauri 2 desktop app), part of the mindb monorepo
  src/                       ← React + TypeScript frontend
  src-tauri/                 ← Rust backend (Tauri commands)
  NAMING CONVENTION.md       ← canonical naming reference (company-wide)
  settings.json              ← local dev overrides (not committed)

../web/                       ← client portal monorepo workspace (same repo)
  apps/client-hub/           ← client-facing DAM portal (reads Supabase via anon key)
  packages/asset-library/    ← shared types, filters, permissions

../docs/                      ← Nextra documentation site (same repo)
```

---

## Naming convention

The filename format is the core data model for every asset in the library. The canonical reference is [NAMING CONVENTION.md](NAMING CONVENTION.md).

```text
(Entity)(Angle)(Format) Description vX-Y-Z.ext

(p-Sln)(SAL)(SlD) Main Deck v2-1-0.pptx
(c-BMW)(ABM)(SlD)v3-0-0.pptx
(e-PEX)(p-Sln)(EVT)(Bnn)v1-0-0.pdf
```

Tag dimensions:

- **Entity** — who or what the asset is about (`p-Sln`, `c-BMW`, `e-PEX`, `ESS`, …)
- **Angle** — purpose or content type (`SAL`, `TEC`, `ABM`, `EVT`, …)
- **Format** — deliverable type (`SlD`, `PDF`, `Vid`, `Bnn`, …)

Tags live in `src/assets/vocabulary.json` — the desktop app and web portal both read from this via Supabase.

---

## Supabase (DAM backend)

Single Supabase project, multi-tenant via Row Level Security. All clients share the same tables; RLS policies enforce isolation by `client_id`.

| Key | Where used |
| --- | --- |
| `supabaseServiceKey` (service_role) | Desktop pipeline — bypasses RLS for writes |
| `supabaseAnonKey` | Web portal — respects RLS for reads |

The service_role key is **never** used from a browser context. The Tauri app proxies all Supabase calls through the Rust `supabase_request` command (native `reqwest`) to avoid Supabase's browser-key restriction.

Schema: `dc-hub-migration/` (separate directory, not tracked by this repo).

---

## Cloud storage (Cloudflare R2)

Each client has its own R2 bucket config. The pipeline uploads assets and returns public CDN URLs, which are written into the Supabase `assets.download_urls` column.

R2 operations are handled by native Rust commands (`upload_to_r2`, `list_r2_keys`, etc.) in `src-tauri/src/r2.rs`.

---

## Multi-client support

Clients are configured in the Settings view. Each client has:

- Source and target folder paths
- Cloud destinations (local, Dropbox, OneDrive, GDrive)
- Supabase project credentials
- Cloudflare R2 credentials

Client configs are stored in `tauri-plugin-store` (OS app-data dir), never in plain files.

Step-by-step setup and connection instructions for each destination type are in [CLOUD_DESTINATIONS.md](CLOUD_DESTINATIONS.md).

---

## Development

**Prerequisites:** Node.js 18+, Rust (stable), `cargo install tauri-cli`. For thumbnails: LibreOffice, poppler (`pdftoppm`), `cwebp`.

```bash
npm install
npm run tauri dev
```

Frontend hot-reloads at `http://localhost:1420`. Rust recompiles on save.

```bash
npm run tauri build   # output: src-tauri/target/release/bundle/
```

**Stack:** Tauri 2 · React 19 · TypeScript · Vite 7 · Zustand · plain CSS Modules

**Project structure:**

```text
src/
  app/           # NavRail + root layout
  features/      # Pipeline, Vocabulary, Generator, Settings, Clients, Cloud views
  domain/        # vocabulary.ts, naming.ts, version.ts, client.ts
  services/      # pipelineService, vocabService, settingsService, damService,
                 # supabaseService, clientService, cloudService
  store/         # Zustand stores (app, pipeline, vocabulary, settings, client)
  styles/        # Design tokens (tokens.css) + global CSS

src-tauri/src/
  lib.rs         # generate_thumbnail, wait_for_oauth_redirect
  supabase.rs    # supabase_request — native HTTP proxy for Supabase
  r2.rs          # upload_to_r2, check_r2_connection, list_r2_keys, delete_r2_object
  cloud.rs       # upload_to_dropbox
```

Settings (folder paths, client configs, cloud tokens) are stored in the OS app-data directory via `tauri-plugin-store` — never in local files.
