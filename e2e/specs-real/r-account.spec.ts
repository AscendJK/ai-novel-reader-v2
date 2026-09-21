/**
 * R-A / R-B：发版包起后端 + 真浏览器，**一个接口桩都不装**的那一档。
 *
 * 与主套的分工要说清：主套 54 条验的是"前端拿到这些响应会不会做对"（后端是 `page.route` 桩），
 * 这一档验的是"服务端和前端接起来之后，用户真看得见吗"。同一条形状在两边都跑不是重复——
 * 桩会把产品的真实响应形状替我们写好，桩层永远看不见"服务端其实回的是另一个样子"。
 *
 * 台架与红线见 docs/e2e-real-deploy-plan-2026-09.md §1：跑的是仓库外的全包，数据目录独立，
 * 开发目录的 `server/data/`（真库、证书、口令）只 stat 不读不写，收尾那条判据盯着它。
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { sel } from "../pages/app";
import { txtFile, importFiles, shelfCard, openBook, backToShelf, navChapter } from "../pages/shelf";
import { DEV_DATA_BASELINE, devDataFingerprint } from "./preflight";
import { ORIGIN, RUN, api, realNovel, signIn, waitIsolated } from "./fixtures";

const USER = `r组真账号-${RUN}`;
const BOOK = `真后端测试书-${RUN}`;

test.describe.serial("真后端：起得来、进得去、数据真是它的", () => {
  test("R-B0 首启为了拿隔离会自刷一次，登录页敲进去的用户名不许被这次刷新吃掉", async ({ page, baseURL }) => {
    // 实测到的形状：首访 16ms → SW 接管后 1780ms 页面自己导航一次（`ensureCrossOriginIsolated`），
    // 刷完 crossOriginIsolated 才为 true。开发态不注册 SW、不自刷，所以这条只有在这一档看得见。
    await page.goto(baseURL!);
    await page.waitForSelector("#user-select");
    await page.selectOption("#user-select", "__new__");
    await page.fill("#new-username", USER);
    await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 20_000 }).toBe(true);
    // 刷完之后：既要是同一个新建流程，也要还带着那三个字
    await expect(page.locator("#user-select")).toHaveValue("__new__");
    await expect(page.locator("#new-username")).toHaveValue(USER);
    await expect(page.getByTestId("login-submit")).toBeEnabled();
  });

  test("R-A2 全包伺服的前端能挂载，Service Worker 注册的是包里那一份", async ({ page, baseURL }) => {
    await page.goto(baseURL!);
    await expect(page.locator("#root")).not.toBeEmpty();
    // 精简包（没有 dist）时这段整个不存在：判据要能分辨"伺服的是前端"还是"只有 API"
    const sw = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return r?.active?.scriptURL ?? r?.installing?.scriptURL ?? r?.waiting?.scriptURL ?? "";
    });
    expect(sw, "SW 没注册：这一档的离线与隔离前提全部落空").toContain("/ai-novel-reader-v2/");
    expect(sw).toMatch(/sw\.js$/);
  });

  test("R-A3 隔离头是 sw.js 注入的，不是后端白送的（服务器自己不发 COOP/COEP）", async ({ page, baseURL }) => {
    const raw = await page.request.get(`${ORIGIN}/ai-novel-reader-v2/`);
    // 缺项时 Playwright 给的是 undefined（不是 null），判"没发这个头"只能判假值
    expect(raw.headers()["cross-origin-opener-policy"], "后端自己发了 COOP：这条判据就被台架白送了").toBeFalsy();
    expect(raw.headers()["cross-origin-embedder-policy"], "同上（COEP）").toBeFalsy();
    await page.goto(baseURL!);
    await waitIsolated(page);
  });

  test("R-B1 点界面创建的用户真进了服务端的库，不只是浏览器自己记着", async ({ page, baseURL }) => {
    await page.goto(baseURL!);
    await expect(sel.loginGate(page)).toBeVisible();
    await signIn(page, baseURL!, USER);
    await expect(sel.emptyShelf(page)).toBeVisible();

    // 换个页面身份从服务端问一次：浏览器自己那份不算数。
    // 接口形状是这一档现学的：`/api/sync/status` 只回 `{ok:true}`（存活探针），
    // 带 exists 的是 `/api/sync/check-user/:username` —— 主套里那只桩是按我读代码的
    // 假设写的，桩层永远量不出"服务端回的根本不是这个形状"。
    const status = await api<{ exists: boolean }>(page, `/api/sync/check-user/${encodeURIComponent(USER)}`);
    expect(status.exists, "界面说创建成功，服务端却说没这个人").toBe(true);
  });

  test("R-B2 上传的书走真接口落了真库，刷新之后还在", async ({ page, baseURL }) => {
    await signIn(page, baseURL!, USER);
    await importFiles(page, [txtFile(`${BOOK}.txt`, realNovel())]);
    await expect(shelfCard(page, BOOK)).toBeVisible({ timeout: 20_000 });

    // 服务端侧：这本得真落进了**这个用户**的 join。
    // 不能只问"目录里有没有这本"——`GET /api/novels` 不带 username 时回的是全库目录
    // （`server/routes/novels.js:12-21`），谁的都一样，那等于什么都没判。带 username 才
    // 多一个服务端算出来的 `joined`。
    const list = await api<{ title: string; joined: boolean; chapterCount: number }[]>(
      page,
      `/api/novels?username=${encodeURIComponent(USER)}`,
    );
    const row = list.find((n) => n.title === BOOK);
    expect(row, "书架上有、服务端目录里没有").toBeTruthy();
    expect(row!.joined, "服务端没把这本记在这个用户名下").toBe(true);
    expect(row!.chapterCount, "三章的书服务端只记了别的人数").toBe(3);

    await page.reload();
    await expect(shelfCard(page, BOOK)).toBeVisible({ timeout: 20_000 });
  });

  test("R-B3 读到第三章的进度，换一个标签页从服务端拿回来", async ({ page, context, baseURL }) => {
    await signIn(page, baseURL!, USER);
    await openBook(page, BOOK);
    await navChapter(page, 2).click();
    // 进度是节流 + 静默窗写的，等它落库再走
    await page.waitForTimeout(2500);

    const second = await context.newPage();
    await second.goto(baseURL!);
    await expect(shelfCard(second, BOOK)).toBeVisible({ timeout: 20_000 });
    // 读 `main` 的文本，不在 `shelfCard(...)` 下面找：那只定位器返回的是**标题元素本身**
    // （`shelf.ts:87-89`），进度文案是它的兄弟节点，套在里面永远找不到。
    // 这条钉的是"同一浏览器的另一个标签页看得见刚写下的进度"（进度本身走本地库 + 广播，
    // 服务端那一趟归下面的 `/api/novels` 与 R-C 组判）。
    await expect
      .poll(async () => (await second.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 300), {
        timeout: 20_000,
        message: "另一个标签页应当看到第三章的进度",
      })
      .toContain("已读至第 3 章");
    await second.close();
    await backToShelf(page);
  });

  test("R-B4 另一个标签页删书，本页的卡片自己消失（真广播 + 真服务端，无桩）", async ({ page, context, baseURL }) => {
    await signIn(page, baseURL!, USER);
    await expect(shelfCard(page, BOOK)).toBeVisible({ timeout: 20_000 });
    const other = await context.newPage();
    await other.goto(baseURL!);
    await expect(shelfCard(other, BOOK)).toBeVisible();
    other.on("dialog", (d) => d.accept());
    await other.getByTitle("删除此书").click();
    await expect(shelfCard(page, BOOK)).toHaveCount(0, { timeout: 20_000 });
    await expect(shelfCard(other, BOOK)).toHaveCount(0, { timeout: 20_000 });
    // 复活窗：真服务端会推 data-changed，别让它把卡片再变回来
    await page.waitForTimeout(1500);
    await expect(shelfCard(page, BOOK)).toHaveCount(0);
    await other.close();
  });

  test("R-B5 整轮跑完，开发目录的 server/data 一项都没被碰过", async () => {
    const before = JSON.parse(readFileSync(DEV_DATA_BASELINE, "utf8")) as ReturnType<typeof devDataFingerprint>;
    const changed = devDataFingerprint().filter((f) => {
      const b = before.find((x) => x.file === f.file);
      return !b || b.size !== f.size || b.mtimeMs !== f.mtimeMs;
    });
    expect(changed, "这一档写到了开发项目的真库/证书/口令上：红线").toEqual([]);
  });
});
