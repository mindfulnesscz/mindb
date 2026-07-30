import { readFileSync } from 'node:fs';
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/* Stamped into every error report, so a stack can be matched to the build that produced it — the
   other half of what makes a production trace readable, alongside source maps. */
const APP_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version;

const fromHere = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
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
  plugins: [react()],

  resolve: {
    alias: {
      // Shared auth/db logic lives in the web/ workspace and is consumed as raw
      // TS source (Vite transpiles it; type-only imports are erased at build).
      "@dc-hub/auth": fromHere("../packages/auth/src/index.ts"),
      "@dc-hub/database": fromHere("../packages/database/src/index.ts"),
      "@dc-hub/domain": fromHere("../packages/domain/src/index.ts"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // Let the dev server read the shared packages in the sibling web/ tree.
    fs: { allow: [fromHere("..")] },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
