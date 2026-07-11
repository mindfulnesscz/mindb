# mindb — DC Hub monorepo

DC Hub is a local-to-cloud digital asset publishing system: the **desktop app** discovers and transforms creative files, publishes binaries to Cloudflare R2 and optional cloud drives, and synchronizes metadata to Supabase; the **web portal** reads that metadata and presents role-aware client galleries, feedback, downloads, and administration.

| Part | What it is | Dev |
|---|---|---|
| [`desktop/`](desktop/) | Tauri 2 pipeline app (React/TS + Rust) | `npm run dev:desktop` |
| [`web/`](web/) | Client portal workspace (Vite + React, Supabase) | `npm run dev:web` |
| [`docs/`](docs/) | Nextra documentation site | `npm run dev:docs` (port 3001) |

`python/` (legacy v1 pipeline) and `dc-hub-desktop/` (stray cache) are intentionally untracked.

## Versioning

One version for the whole repo — see [VERSIONING.md](VERSIONING.md) and [CHANGELOG.md](CHANGELOG.md). Current release notes live in the changelog; `npm run version:check` verifies every manifest agrees.

## History

Merged 2026-07-11 from three repositories with full history: `mindfulnesscz/dc-hub` (desktop), `mindfulnesscz/dc-hub-front` (web), `mindfulnesscz/dc-hub-docs` (docs) — now archived in favor of this repo.
