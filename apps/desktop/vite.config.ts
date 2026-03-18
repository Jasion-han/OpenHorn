import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const TAURI_DEV_HOST = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: TAURI_DEV_HOST || false,
    hmr: TAURI_DEV_HOST
      ? {
          protocol: "ws",
          host: TAURI_DEV_HOST,
          port: 5173,
        }
      : undefined,
    fs: {
      allow: [path.resolve(__dirname, "../..")],
    },
  },
});
