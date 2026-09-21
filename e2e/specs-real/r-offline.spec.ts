/**
 * R-F：H 组那套 PWA/离线判据，搬到**发版包**上复跑。
 *
 * 为什么不算重复（H 组已经在跑 dist/ 了）：H 组的服务器是我自己写的
 * `e2e/serve-dist.mjs`（只发文件、`no-store`、不带任何隔离头），
 * 而发版包是 **express**：base 前缀由 `express.static` 处理、`--full` 的挂载点在
 * `server/index.js`，离线兜底取的是真 API 打过一轮之后的 Cache Storage。
 * 这两台在"外壳怎么回来"这件事上不是同一份代码路径。
 */
import { test, expect } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { sel } from "../pages/app";
import { importFiles, miniNovel, openBook, shelfCard, txtFile, CHAPTER_TITLES } from "../pages/shelf";
import { DATA_DIR, RUN, signIn } from "./fixtures";

const USER = `r组真离线-${RUN}`;
const BOOK = `离线真书-${RUN}`;
/**
 * 发版包解压出来的前端目录。台架约定（见 docs/e2e-real-deploy-plan-2026-09.md §1）：
 * 数据目录 `<包根>/run-data`，所以包根的 `full/dist` 就是 `<DATA_DIR>/../full/dist`。
 * 不对就显式设 `ANR_REAL_PACK_DIR`。
 */
const PACK_DIST = process.env.ANR_REAL_PACK_DIR ?? path.join(path.dirname(DATA_DIR), "full", "dist");

test.describe.serial("真后端：断网重开与包内清单", () => {
  test("R-F1 真后端上断网重开：外壳回来、登录态还在、书架与正文照样读得到", async ({ page, context, baseURL }) => {
    test.setTimeout(6 * 60_000);
    await signIn(page, baseURL!, USER);
    await importFiles(page, [txtFile(`${BOOK}.txt`, miniNovel())]);
    await expect(shelfCard(page, BOOK)).toBeVisible({ timeout: 30_000 });
    await openBook(page, BOOK);
    // 先让这一版被 SW 接管并把外壳与资源预cache好（首启那一刷在 signIn 里已经过去了）
    await page.getByText(CHAPTER_TITLES[2]).first().waitFor({ state: "visible" });

    await context.setOffline(true);
    await page.reload();
    // 白屏能让"某元素不存在"这类判据全绿，所以先钉外壳真挂载了
    await expect(page.locator("#root")).not.toBeEmpty();
    await expect(sel.folderImportButton(page)).toBeVisible({ timeout: 60_000 });
    await expect(shelfCard(page, BOOK)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("3 章")).toBeVisible({ timeout: 30_000 });
    // 正文：离线时读的是浏览器本地库，一个网络请求都不该发出去
    await openBook(page, BOOK);
    await expect(page.locator(".chapter-section").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/黑木崖上有人吹笛/).first()).toBeVisible({ timeout: 30_000 });
    await context.setOffline(false);
  });

  test("R-F2 包内 sw.js 的预缓存清单与包内 dist 真文件一一对上（不发隔离头、不含 TTS 大文件）", async ({ page, baseURL }) => {
    const swUrl = new URL("sw.js", baseURL!).href;
    const res = await page.request.get(swUrl);
    expect(res.status(), "包里没有 sw.js：这一档的离线前提根本不成立").toBe(200);
    const sw = await res.text();

    const entries = [...sw.matchAll(/\{\s*url:\s*"([^"]+)"\s*,\s*revision:\s*("[^"]*"|null)\s*\}/g)]
      .map((m) => m[1]);
    expect(entries.length, "sw.js 里读不出预缓存清单（workbox 生成格式变了？）").toBeGreaterThan(5);

    expect(existsSync(path.join(PACK_DIST, "sw.js")), `对不上包内 dist：${PACK_DIST} 里没有 sw.js（台架路径假设错了）`).toBe(true);
    const onDisk = new Set(readdirSync(path.join(PACK_DIST, "assets")));
    const missing = entries
      .filter((u) => u.startsWith("assets/"))
      .map((u) => u.slice("assets/".length))
      .filter((f) => !onDisk.has(f));
    expect(missing, `sw.js 指向 dist/assets 里不存在的文件（包内 dist 与清单不同步）：${missing.join("、")}`).toEqual([]);

    // 反向：TTS 那几百 MB 绝不能进预缓存（H4 的同一条，在发版包上再钉一次）
    const tts = entries.filter((u) => u.includes("sherpa-tts"));
    expect(tts, `预缓存清单里出现了 TTS 大文件：${tts.join("、")}`).toEqual([]);
  });
});
