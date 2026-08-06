# Sotto Desktop

Tauri 2 desktop app for the Sotto asset pipeline (see the [monorepo README](../README.md) for the product overview). Processes, versions, distributes, and syncs marketing assets across cloud storage and a Supabase DAM backend.

Version history lives in the root [CHANGELOG.md](../CHANGELOG.md); the version workflow in [VERSIONING.md](../VERSIONING.md).

---

## What it does

1. **Organise** — assets follow a strict bracket-tag naming convention (`(Entity)(Angle)(Format) Description vX-Y-Z.ext`) enforced by the vocabulary registry
2. **Distribute** — copies assets from source → internal and client-facing destinations (local folders, Dropbox, OneDrive, Google Drive)
3. **Publish to CDN** — uploads to Cloudflare R2, returns public CDN URLs
4. **Sync to DAM** — upserts asset metadata and version history into Supabase; powers the web portal
5. **Generate thumbnails** — Office and PDF → WebP sidecars, rendered in-process by bundled PDFium + statically-linked libwebp (LibreOffice converts Office documents to PDF first)
6. **Build Obsidian vault** — generates markdown notes with inherited taxonomy tags for the DAM

---

## Architecture

```text
desktop/                      ← this directory (Tauri 2 desktop app), part of the Sotto monorepo
  src/                       ← React + TypeScript frontend
  src-tauri/                 ← Rust backend (Tauri commands)
  NAMING CONVENTION.md       ← canonical naming reference (company-wide)
  settings.json              ← machine-local app-data file (not committed)

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

Tags are administered in the web portal and synchronized through Supabase. The desktop keeps a
machine-local vocabulary cache for naming and pipeline work.

---

## Supabase (DAM backend)

Single Supabase project, multi-tenant via Row Level Security. All clients share the same tables; RLS policies enforce isolation by `client_id`.

| Credential | Where used |
| --- | --- |
| Project URL + anon/publishable key | Desktop and portal bootstrap |
| Supabase user session | Desktop and portal reads/writes under RLS |
| `service_role` | Trusted Edge Functions only; never desktop or browser config |

The desktop proxies Supabase calls through the Rust `supabase_request` command (native `reqwest`),
but authorization still comes from the signed-in user's JWT and database RLS.

Schema and replayable migrations live in [`../supabase`](../supabase).

---

## Cloud storage (Cloudflare R2)

The environment has public and gated R2 tiers. The pipeline requests short-lived, client-scoped
credentials from `r2-grant`, uploads identity-keyed objects to the appropriate tier, and writes the
resulting URLs into Supabase asset rows. Permanent parent credentials never reach desktop config.

R2 operations are handled by native Rust commands (`upload_to_r2`, `list_r2_keys`, etc.) in `src-tauri/src/r2.rs`.

---

## Multi-client support

Clients are database-first (list from Supabase after sign-in). Each workstation stores machine-local fields:

- Source, target, and vault folder paths
- Cloud destination preferences (structure comes from the portal); OAuth tokens and the Google
  client secret persist in the OS keychain, not `client-local.json`
- Last active client

Step-by-step destination setup: [CLOUD_DESTINATIONS.md](CLOUD_DESTINATIONS.md). Product workflow (tags + destinations ownership): [docs/pages/getting-started/tags-and-destinations.mdx](../docs/pages/getting-started/tags-and-destinations.mdx).

---

## Development

**Prerequisites:** Node.js 24, Rust (stable), `cargo install tauri-cli`, and `npm run deps:native`
from the repo root to fetch the bundled render engines (PDFium + LibreOffice, ~290MB download). No
separately installed thumbnail tools are required.

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
