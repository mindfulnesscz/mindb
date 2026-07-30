// Flat ESLint config (ESLint 9+). Phase 0 of REFACTOR_PLAN.md.
//
// Wired into `npm run lint`, `npm run check`, and CI (.github/workflows/check.yml)
// with `--max-warnings 0`. The gate is a true zero: every remaining exemption is
// an explicit override block below with a reason, not an accumulating warning
// count. Formatting is Prettier's job (`npm run format`); eslint-config-prettier
// last disables every stylistic rule that would fight it.

import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    // Never lint build output, deps, generated types, or the stale compiled
    // .js sitting next to the .tsx sources (Vite builds from main.tsx).
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/out/**',
      '**/target/**',
      '**/*.d.ts',
      'packages/database/src/database.types.ts',
      'web/apps/client-hub/src/lib/database.types.ts',
      'web/apps/client-hub/src/**/*.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      // `_`-prefixed bindings are the codebase's "deliberately unused" marker —
      // honour it for args, vars, caught errors and array holes alike.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // Error paths go through reportError(), never a bare console — see the
      // override below, which is what makes that seam enforceable.
      'no-console': ['warn', { allow: ['warn'] }],
    },
  },

  /* ── App code: browser globals, React hook correctness ────────────────── */
  {
    files: ['desktop/src/**/*.{ts,tsx}', 'web/apps/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The correctness rule — a conditional hook call is always a bug.
      'react-hooks/rules-of-hooks': 'error',
      // Advisory and frequently intentional here (effects that must not re-run
      // on every store change). Revisit in Phase 2 when the views are split.
      'react-hooks/exhaustive-deps': 'off',
    },
  },

  /* ── @dc-hub/domain must stay platform-free ───────────────────────────────
     The whole value of this package is that the SAME rules run in the desktop pipeline,
     in the web portal, and (later) in a script or edge function with no shim. One
     `@tauri-apps/*` import would make it desktop-only; one React import would make it
     unusable outside a component tree. A comment cannot hold that line, so CI does.
     Shared UI belongs in @dc-hub/asset-library, which may depend on React. */
  {
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'react', message: '@dc-hub/domain must stay React-free — put shared UI in @dc-hub/asset-library.' },
        ],
        patterns: [
          { group: ['@tauri-apps/*'], message: '@dc-hub/domain must stay platform-free — pass the data in instead of reading it here.' },
          { group: ['@supabase/*'], message: '@dc-hub/domain must stay transport-free — the caller owns the client.' },
          { group: ['node:*', 'fs', 'path'], message: '@dc-hub/domain must not touch the filesystem — pass paths in as strings.' },
          { group: ['../../../*'], message: '@dc-hub/domain must not reach outside the package.' },
        ],
      }],
    },
  },

  /* ── reportError: the one place a raw console.error belongs ───────────── */
  {
    files: ['desktop/src/services/reportError.ts', 'web/apps/client-hub/src/lib/reportError.ts'],
    rules: { 'no-console': 'off' },
  },

  /* ── Node tooling: scripts and framework config files ─────────────────── */
  {
    files: [
      '**/*.mjs',
      '**/*.cjs',
      'scripts/**/*.js',
      '*.config.js',
      'docs/next.config.js',
      'desktop/vite.config.ts',
      'desktop/vitest.config.ts',
    ],
    languageOptions: { globals: globals.node },
    rules: {
      // These are CLIs — stdout IS the user interface.
      'no-console': 'off',
      // next.config.js is CommonJS by necessity.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  /* ── Supabase edge functions run on Deno, not Node ────────────────────── */
  {
    files: ['supabase/functions/**/*.ts'],
    languageOptions: { globals: { ...globals.deno, Deno: 'readonly' } },
    rules: { 'no-console': 'off' },
  },

  /* ── TODO(phase3): `(supabase as any)` casts ──────────────────────────────
     Every `any` in these files is a cast around the portal's untyped Supabase
     client. Phase 3 generates database.types.ts in CI and consumes it here;
     delete this block then — do not add files to it. */
  {
    files: [
      'web/apps/client-hub/src/features/portal/ClientPortalPage.tsx',
      'web/apps/client-hub/src/services/assetService.ts',
      'web/apps/client-hub/src/services/commentService.ts',
      'web/apps/client-hub/src/services/eventService.ts',
      'web/apps/client-hub/src/services/ratingService.ts',
    ],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },

  prettier,
)
