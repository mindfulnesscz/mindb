// Flat ESLint config (ESLint 9+). Phase 0 scaffold.
//
// ACTIVATION (one-time, run locally so the lockfiles update):
//   npm i -D eslint @eslint/js typescript-eslint eslint-plugin-react-hooks eslint-config-prettier prettier   # root workspace
//   npm --prefix desktop i -D eslint @eslint/js typescript-eslint eslint-config-prettier
// Then add to each workspace package.json scripts:  "lint": "eslint . --max-warnings 0"
// and, once the tree is clean, add `npm run lint --workspace=web/apps/client-hub` to the root `check` script + check.yml.
//
// This file is inert until ESLint + the plugins above are installed; it does not
// affect `npm run check`, `npm ci`, or CI in its current state.

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
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
      // Start lenient so the existing tree is not a wall of errors; tighten later.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  prettier,
)
