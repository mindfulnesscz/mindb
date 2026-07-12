# Versioning

The whole monorepo shares **one version**. The root `package.json` is the canonical source. Do not edit any part's npm, Cargo, Tauri, lockfile, or changelog versions by hand.

```bash
npm run version:patch       # X.Y.Z -> X.Y.(Z+1)
npm run version:minor       # X.Y.Z -> X.(Y+1).0
npm run version:major       # X.Y.Z -> (X+1).0.0
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

Version commands do not commit, tag, or push. The release path (branch-protected: `main` only accepts merges from `staging`): commit the bump on a branch → PR to `staging` → verify on staging → PR `staging → main` → merge → create the matching `vX.Y.Z` tag on the merge commit and push it. CI (`.github/workflows/version.yml`) rejects mismatched manifests and release tags.

The contributor-facing release checklist and drift recovery procedure are also available in the documentation site at `/reference/versioning`.
