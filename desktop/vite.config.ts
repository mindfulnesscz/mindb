import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const fromHere = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
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
