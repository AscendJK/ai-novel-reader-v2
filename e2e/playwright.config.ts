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

/** 构建产物那一套（H 组）另占一个端口，见 e2e/serve-dist.mjs 顶部"为什么不用 vite preview"。 */
const BUILD_PORT = Number(process.env.E2E_BUILD_PORT ?? 5275);
const BUILD_BASE_URL = `http://127.0.0.1:${BUILD_PORT}/ai-novel-reader-v2/`;

export default defineConfig({
  testDir: "./specs",
  outputDir: path.join(repoRoot, "test-results"),
  timeout: 30_000,
  // 5s 是给"点了之后应当立刻有反应"那类判据的。刷新之后等书架回来不在此列——
  // 那条路径实测会随并发拉长（10 worker 下 B7 全程 14.6s，单跑 5.0s），
  // 所以那种断言各自显式给 `{ timeout: 20_000 }`，别把全局预算抬成掩盖真问题的余量。
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
  // 所以主套不需要处理"页面自己刷新"。构建产物那一套是另一个 project：
  // 它跑 dist/，SW 真注册、COI 真靠 SW 注入，页面会自己刷新——判据完全不同，
  // 所以分开目录（./specs-build），不混进主套。
  projects: [
    { name: "chromium" },
    { name: "build", testDir: "./specs-build", use: { baseURL: BUILD_BASE_URL } },
  ],
  webServer: [
    {
      // 直调 vite.js：绕开 npx 与 .cmd 在 Windows shell 下的差异，也不沿用 npm run dev 的 0.0.0.0
      command: `node "${path.join(repoRoot, "node_modules/vite/bin/vite.js")}" --host 127.0.0.1 --port ${PORT} --strictPort`,
      cwd: repoRoot,
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // 起之前可能要重建 dist/（源码比产物新），所以这一档的预算给到构建的量级
      command: `node "${path.join(here, "serve-dist.mjs")}"`,
      cwd: repoRoot,
      url: BUILD_BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
  ],
});
