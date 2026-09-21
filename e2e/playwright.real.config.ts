import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/**
 * 真后端那一档的台架：跑**发版包**，不跑开发目录。
 *
 * 与 `playwright.config.ts` 分开的理由有三条，都是这台机器上量出来的：
 *  1. 一份 config 里的 `webServer` 数组**不管选哪个 project 都会全部起**，
 *     把"真后端"塞进去就等于每次跑主套都白起一个后端；
 *  2. 判据完全不同：主套与 H 组的后端都是 `page.route` 桩，这里**一个桩都不装**，
 *     真下载模型、真建 RAG 索引、真调厂商；
 *  3. 产物目录与 trace 要能一键关死：Playwright 的 trace 会**原样记下请求头**，
 *     带着厂商 key 的那一档绝不能留 trace/截图（`ANR_REAL_ARTIFACTS=off`）。
 *
 * 起后端不归这里管（见 `docs/e2e-real-deploy-plan-2026-09.md` §1）：
 * 全包解压在仓库外、独立 `npm install`、PATH 里剥掉 mkcert 强制 HTTP-only，
 * 所以这里只指向它，并在 `preflight.ts` 里先用一只探针确认它真的在跑
 * ——宁可红得明白，也不要"连不上就全用 `not.toBeVisible` 蒙混过去"。
 */
const REAL_ORIGIN = process.env.ANR_REAL_ORIGIN ?? "http://127.0.0.1:5399";
/** base 路径必须带（`vite.config.ts:9` 的 `base`），不带会 404 到根重定向。 */
export const REAL_BASE_URL = process.env.ANR_REAL_BASE ?? `${REAL_ORIGIN}/ai-novel-reader-v2/`;

const artifactsOff = process.env.ANR_REAL_ARTIFACTS === "off";

export default defineConfig({
  testDir: "./specs-real",
  // 放在 `test-results/` 底下而不是并列一只 `test-results-real/`：`.gitignore:92` 只写着
  // `test-results/`，并列的那只不会被忽略 —— 而这一档会留下带真接口 URL 的 trace。
  // ESLint 同理只忽略了 `test-results`（trace 解出来是压缩 JS，`eslint .` 不读 .gitignore，
  // 一堆 no-undef 会把 verify 整道闸门砸红）。
  outputDir: path.join(repoRoot, "test-results", "real"),
  // 真下载一卷就几十 MB，30 秒那套预算在这里只会造出假红
  timeout: 15 * 60_000,
  expect: { timeout: 20_000 },
  // 串行：这一档所有人共用同一只后端与同一份 tts-cache，
  // 并发跑会互相踩缓存与"全服务器只下一趟"的闸门（那是被测行为，不是干扰源）。
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: REAL_BASE_URL,
    // 定位器本身不该等：这一档每条的天花板是 15 分钟（真下载几十~几百 MB），
    // 不压 actionTimeout 的话，一个写错的标题会把 15 分钟全烧在"waiting for locator"上
    // （实测踩过一次：`navChapter` 等着 `/第三章 归途/`，样本里那章叫"归程"）。
    // 慢的是"等某件事发生"，那种判据各自带显式 `{ timeout: … }`，不受这只闸影响。
    actionTimeout: 60_000,
    navigationTimeout: 60_000,
    trace: artifactsOff ? "off" : "retain-on-failure",
    screenshot: artifactsOff ? "off" : "only-on-failure",
    video: artifactsOff ? "off" : undefined,
  },
  projects: [{ name: "real" }],
  globalSetup: path.join(here, "specs-real", "preflight.ts"),
});
