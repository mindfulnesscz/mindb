import { readFileSync } from 'node:fs'

/* Stamped into every error report, so a stack can be matched to the build that produced it — the
   other half of what makes a production trace readable, alongside source maps. */
const APP_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    /* 'hidden' emits the .map files but leaves no //# sourceMappingURL comment in the bundle, so
       browsers do not fetch them and they are not advertised in devtools. Without maps a production
       stack is `index-4f2a.js:1:48210`, which no error sink can make readable — so this is the
       limiting factor on diagnosing a real failure, whatever the sink happens to be.

       They are still deployed alongside the bundle and therefore fetchable by anyone who guesses the
       URL. If that matters later, upload them somewhere private and delete them from dist as a build
       step; do not simply turn this off, or the reports become unreadable again. */
    sourcemap: 'hidden',
  },
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    // Prefer TypeScript sources — stale compiled .js files must not shadow .tsx.
    extensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.mts', '.json'],
    /* Every workspace package is aliased straight to its source, and the list must stay COMPLETE —
       it mirrors `paths` in tsconfig.json. `@sotto/database` was the one omission, so it alone
       resolved through the node_modules symlink instead. That difference is invisible until the
       symlink is briefly absent — during a scope rename, a fresh clone before `npm install`, or a
       dev server started mid-install — and then it fails as
       "Failed to resolve import @sotto/database", pointing at the importing component rather than at
       the missing alias. tsconfig already listed all four; only Vite disagreed. */
    alias: {
      '@sotto/asset-library': resolve(__dirname, '../../../packages/asset-library/src/index.ts'),
      '@sotto/auth': resolve(__dirname, '../../../packages/auth/src/index.ts'),
      '@sotto/database': resolve(__dirname, '../../../packages/database/src/index.ts'),
      '@sotto/domain': resolve(__dirname, '../../../packages/domain/src/index.ts'),
    },
  },
})
