/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { compression, defineAlgorithm } from "vite-plugin-compression2";

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    // catherd's server serves these .br and .gz siblings as they are, so nothing is compressed per request.
    compression({
      algorithms: [defineAlgorithm("brotliCompress", { params: { 1: 11 } }), defineAlgorithm("gzip", { level: 9 })],
      threshold: 1024,
    }),
  ],
  build: { outDir: "dist", emptyOutDir: true, assetsDir: "assets", target: "es2022" },
  server: {
    // the panel answers only its own Host and Origin, so the proxy speaks as the panel's page
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4317",
        ws: true,
        changeOrigin: true,
        headers: { origin: "http://127.0.0.1:4317" },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // User-event tests run several seconds on a loaded CI runner; 5 s flakes.
    testTimeout: 20_000,
  },
});
