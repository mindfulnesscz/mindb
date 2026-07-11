# Versioning

The whole monorepo shares **one version**. The root `package.json` is the canonical source. Do not edit any part's npm, Cargo, Tauri, lockfile, or changelog versions by hand.

```bash
npm run version:patch       # 2.2.0 -> 2.2.1
npm run version:minor       # 2.2.0 -> 2.3.0
npm run version:major       # 2.2.0 -> 3.0.0
npm run version:set -- 2.5.0
npm run version:check
```

A bump updates, in one pass:

- `package.json` (root, canonical)
- `desktop/package.json` + `desktop/package-lock.json`
- `desktop/src-tauri/tauri.conf.json`, `Cargo.toml`, `Cargo.lock`
- `web/package.json` + workspace packages (`apps/client-hub`, `packages/asset-library`) + `web/package-lock.json`
- `docs/package.json` + `docs/package-lock.json`
- `CHANGELOG.md` — a new section is inserted when one doesn't exist yet; replace the generated placeholder before committing

Version commands do not commit, tag, or push. After reviewing the changes, commit them and create the matching `vX.Y.Z` tag. CI (`.github/workflows/version.yml`) rejects mismatched manifests and release tags.
