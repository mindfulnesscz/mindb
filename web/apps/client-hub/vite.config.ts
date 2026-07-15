import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    // Prefer TypeScript sources — stale compiled .js files must not shadow .tsx.
    extensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.mts', '.json'],
    alias: {
      '@dc-hub/asset-library': resolve(__dirname, '../../packages/asset-library/src/index.ts'),
    },
  },
})
