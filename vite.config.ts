import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

// GitHub Pages 部署路径（根据仓库名调整）
const BASE_PATH = "/ai-novel-reader-v2/";

export default defineConfig({
  base: BASE_PATH,
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        runtimeCaching: [
          // Model files are downloaded through backend proxy, not from GitHub Pages
          // Don't cache /models/ paths to avoid interfering with the fetch interceptor
        ],
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: "AI 小说精读助手",
        short_name: "小说精读",
        theme_color: "#0a0a0a",
        background_color: "#0a0a0a",
        display: "standalone",
        start_url: BASE_PATH,
        scope: BASE_PATH,
        icons: [
          { src: `${BASE_PATH}icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
          { src: `${BASE_PATH}icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
          { src: `${BASE_PATH}icon-512-maskable.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        screenshots: [
          { src: `${BASE_PATH}screenshot-desktop.png`, sizes: "1280x720", type: "image/png" },
          { src: `${BASE_PATH}screenshot-mobile.png`, sizes: "720x1280", type: "image/png" },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    chunkSizeWarningLimit: 1000,
  },
  server: {
    host: "0.0.0.0",
    port: 5174,
    proxy: {
      "/api": "http://localhost:5173",
      "/admin": "http://localhost:5173",
    },
    hmr: {
      overlay: false,
    },
    watch: {
      usePolling: false,
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "src/test/"],
    },
  },
});
