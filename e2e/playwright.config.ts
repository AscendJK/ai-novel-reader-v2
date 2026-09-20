import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/**
 * 单独占一个端口，不撞开发者自己开的 5174（vite.config.ts:120-133），
 * 也不撞后端 5173/8443——撞了的症状是"页面打得开但行为像别人的实例"。
 */
const PORT = Number(process.env.E2E_PORT ?? 5274);
/** base 路径必须带（vite.config.ts:9），不带会 404 到 vite 的根重定向。 */
const BASE_URL = `http://127.0.0.1:${PORT}/ai-novel-reader-v2/`;

export default defineConfig({
  testDir: "./specs",
  outputDir: path.join(repoRoot, "test-results"),
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(repoRoot, "playwright-report"), open: "never" }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // dev 下 Service Worker 不注册、crossOriginIsolated 直接为 true（本机实测），
  // 所以主套不需要处理"页面自己刷新"。构建产物那一套另开 project，见计划 §3.2。
  projects: [{ name: "chromium" }],
  webServer: {
    // 直调 vite.js：绕开 npx 与 .cmd 在 Windows shell 下的差异，也不沿用 npm run dev 的 0.0.0.0
    command: `node "${path.join(repoRoot, "node_modules/vite/bin/vite.js")}" --host 127.0.0.1 --port ${PORT} --strictPort`,
    cwd: repoRoot,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
