import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";
import fs from "fs";

// GitHub Pages 部署路径（根据仓库名调整）
const BASE_PATH = "/ai-novel-reader-v2/";

export default defineConfig({
  base: BASE_PATH,
  plugins: [
    // sherpa-onnx 需要正确的 MIME 类型和 CORP header
    {
      name: "sherpa-mime",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith("/sherpa-tts/")) {
            const safePath = req.url.split("?")[0]; // 去掉 query string
            const filePath = path.join(__dirname, "public", safePath);
            // 防路径穿越：确保解析后的路径在 public 目录内
            const publicDir = path.join(__dirname, "public");
            if (!filePath.startsWith(publicDir)) return next();
            if (!fs.existsSync(filePath)) return next();
            const ext = path.extname(filePath);
            const mimes = { ".wasm": "application/wasm", ".data": "application/octet-stream", ".mjs": "application/javascript", ".js": "application/javascript", ".txt": "text/plain" };
            res.setHeader("Content-Type", mimes[ext] || "application/octet-stream");
            res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
            const stream = fs.createReadStream(filePath);
            stream.on("error", () => { res.statusCode = 500; res.end("Internal error"); });
            stream.pipe(res);
            return;
          }
          next();
        });
      },
    },
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
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@xenova/transformers") || id.includes("onnxruntime-web")) {
            return "transformers";
          }
          if (id.includes("d3-force") || id.includes("d3-selection")) {
            return "d3";
          }
          if (id.includes("react-markdown") || id.includes("remark-gfm") || id.includes("rehype-raw")) {
            return "markdown";
          }
          if (id.includes("jszip")) {
            return "epub";
          }
        },
      },
    },
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
    headers: {
      // sherpa-onnx WASM 使用 pthreads，需要 SharedArrayBuffer
      // SharedArrayBuffer 要求页面是 cross-origin isolated
      // 使用 require-corp（比 credentialless 兼容性更好，Firefox 也支持）
      // 注意：生产环境（GitHub Pages）无法设置自定义 header，需使用 coi-serviceworker
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
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
