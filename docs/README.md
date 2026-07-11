# DC Hub Documentation

Documentation site for DC Hub (see the [monorepo README](../README.md) for the product overview). These pages describe what the current source code actually does — including ordering, skip rules, failure boundaries, security implications, and known limitations.

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

- Docs track **actual code behavior**, not intent — when the pipeline changes, the relevant page changes in the same breath (logged in the root [CHANGELOG.md](../CHANGELOG.md)).
- Version references follow the repo's single canonical version (see [VERSIONING.md](../VERSIONING.md)).
