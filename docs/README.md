# DC Hub Documentation

Documentation site for **DC Hub** — a local-to-cloud digital asset publishing system. The desktop application ([dc-hub](https://github.com/mindfulnesscz/dc-hub)) discovers and transforms creative files, publishes binaries to Cloudflare R2 and optional cloud drives, and synchronizes metadata to Supabase. The web portal ([dc-hub-front](https://github.com/mindfulnesscz/dc-hub-front)) reads that metadata and presents role-aware client galleries, feedback, downloads, and administration.

These pages describe what the current source code actually does — including ordering, skip rules, failure boundaries, security implications, and known limitations.

Built with [Nextra](https://nextra.site/) (Next.js).

## Running locally

```bash
npm install
npm run dev     # http://localhost:3001
```

`npm run build` + `npm run start` for a production build.

## Content map

| Section | What's inside |
|---|---|
| `pages/getting-started/` | First run, architecture, trust boundaries |
| `pages/pipeline.mdx` | The desktop asset pipeline, step by step |
| `pages/desktop/` | Pipeline lifecycle, logs, troubleshooting |
| `pages/data-model/` | Assets, taxonomy, stable identity, sync semantics |
| `pages/cloud-storage/` | R2 / Dropbox / OneDrive / Google Drive setup and comparison |
| `pages/web-portal/` | Authentication, permissions, administration |
| `pages/operations/` | Publishing runbook, troubleshooting |
| `pages/reference/` | Repository map, code map |

Start at `pages/index.mdx` for the reading paths per role (operator, developer, cloud administrator).

## Conventions

- Docs track **actual code behavior**, not intent — when the pipeline changes, the relevant page changes in the same breath (see `CHANGELOG.md`).
- Version references follow the desktop app's version (currently 2.2.0).
