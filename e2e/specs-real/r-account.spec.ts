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
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { sel } from "../pages/app";
import { CHAPTER_TITLES, txtFile, importFiles, shelfCard, openBook, backToShelf, navChapter } from "../pages/shelf";
import { DEV_DATA_BASELINE, devDataFingerprint } from "./preflight";

const ORIGIN = process.env.ANR_REAL_ORIGIN ?? "http://127.0.0.1:5399";
/**
 * 每次跑用一对新名字，而不是清库重开：
 *  - R-B1 判的是"点界面**创建**的用户真进了服务端的库"。名字要是上一轮就存在，
 *    `handleLogin` 走 join 分支也能过，那条判据就悄悄降级成了"服务端认得这个人"；
 *  - 上一轮中途挂掉留下的半成品书会让 `shelfCard` 撞上两只同名卡片，
 *    报出来是"strict mode violation"，看着像产品缺陷其实是台架脏。
 * 一次性目录整个会在收尾删掉，所以这里只累积、不回收。
 */
const RUN = process.env.ANR_REAL_RUN ?? String(Date.now()).slice(-6);
const USER = `r组真账号-${RUN}`;
const BOOK = `真后端测试书-${RUN}`;
/** RAG 检索要在正文里认出它；每章正文都得长过 50 字，否则被 chapter-detector 并进上一章 */
const SENTINEL = "青龙寺的石阶一共三百七十二级，守碑的老僧每天用帚扫三遍，扫到第三年把石缝扫出了一道浅槽。";

/**
 * 章节标题必须用 `shelf.ts` 里那三只：`navChapter`/`chapterSection` 的定位锚点与它同源。
 * 自己另起一批（我一开始写的"第三章 归程"）不会报"找不到"，只会**一声不响地等到超时**——
 * 这一档每条的天花板是 15 分钟，一次拼错就烧掉一刻钟。
 */
function realNovel(): string {
  return [
    `${CHAPTER_TITLES[0]}\n洛阳城下的雪落了三天，街面上没有一个卖炭的人。守城的兵卒围着火盆打盹，铁甲上结了一层薄霜，谁也不肯先开口说话。`,
    `${CHAPTER_TITLES[1]}\n${SENTINEL}山下渡口那条船等了半月，船家说从没人见崖上有人下来过，只有笛声每天按时响一次。`,
    `${CHAPTER_TITLES[2]}\n虎牢关的鼓声一夜未停，守将把盔缨系了两遍又松开。探马第三次回报说敌军尚在三十里外，帐中无人敢信，也没人敢不信。`,
  ].join("\n\n");
}

/**
 * 直接问服务端（带真 token），不用界面那套 fetch。
 *
 * token 走 `Authorization: Bearer`（`server/middleware/auth.js:13-19`），值由 `sync-client`
 * 存在 `localStorage["sync-token"]`。读它是为了"绕开界面问服务端"，不是重新造一份会话——
 * 造出来的就是另一个用户，判据就废了。
 */
async function api<T>(page: Page, url: string): Promise<T> {
  const token = await page.evaluate(() => localStorage.getItem("sync-token"));
  const r = await page.request.get(`${ORIGIN}${url}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  expect(r.status(), `GET ${url} 不该是 ${r.status()}`).toBe(200);
  return (await r.json()) as T;
}

/**
 * 等"这一版真被 SW 接管且拿到跨源隔离"。
 *
 * COI 只在**已被 SW 控制的页面发生的那次导航**上生效，所以首访拿不到，产品会自己刷一次
 * （`main.tsx` 的 `ensureCrossOriginIsolated`）。轮询谓词必须容得下页面自刷——
 * `evaluate` 撞上导航会抛，那正是我们要等的过程，不是失败。
 */
async function waitIsolated(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return await page.evaluate(async () => {
            const reg = await navigator.serviceWorker.ready;
            return { ctrl: !!reg.active, coi: window.crossOriginIsolated };
          });
        } catch {
          return { ctrl: false, coi: false };
        }
      },
      { timeout: 60_000, message: "SW 没接管，或接管之后仍拿不到隔离" },
    )
    .toEqual({ ctrl: true, coi: true });
}

/**
 * 每条用例自己登录一次。
 *
 * 为什么不能靠上一条用例的登录态：Playwright 的 `page`/`context` 是**每条用例新建**的，
 * localStorage 与 IndexedDB 都是干净的 —— 表现是 R-B2 拿到一个没登录的界面（登录遮罩还挂着，
 * 底下书架是空的），而 `setInputFiles` 不受遮罩阻挡，于是导入"看起来发了"、卡片却永远不来。
 * 换 context 不是坏事：这一档本来就要看"空浏览器从真服务端能拉回什么"。
 *
 * 先等隔离再填表：首启那一刷落在开机后约 1.8 秒，等它过去再动手，登录这步才是确定的。
 * 对话框一律 accept —— `handleLogin` 里那两只 confirm（踢掉其他设备 / 覆盖本地数据）默认被
 * Playwright 当成"取消"，症状是点了进入什么也没发生。
 */
async function signIn(page: Page, baseURL: string): Promise<void> {
  page.on("dialog", (d) => d.accept());
  await page.goto(baseURL);
  await waitIsolated(page);
  if (!(await sel.loginGate(page).isVisible().catch(() => false))) return;
  await page.selectOption("#user-select", "__new__");
  await page.fill("#new-username", USER);
  await page.getByTestId("login-submit").click();
  await expect(sel.loginGate(page)).toHaveCount(0, { timeout: 30_000 });
}

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
    await signIn(page, baseURL!);
    await expect(sel.emptyShelf(page)).toBeVisible();

    // 换个页面身份从服务端问一次：浏览器自己那份不算数。
    // 接口形状是这一档现学的：`/api/sync/status` 只回 `{ok:true}`（存活探针），
    // 带 exists 的是 `/api/sync/check-user/:username` —— 主套里那只桩是按我读代码的
    // 假设写的，桩层永远量不出"服务端回的根本不是这个形状"。
    const status = await api<{ exists: boolean }>(page, `/api/sync/check-user/${encodeURIComponent(USER)}`);
    expect(status.exists, "界面说创建成功，服务端却说没这个人").toBe(true);
  });

  test("R-B2 上传的书走真接口落了真库，刷新之后还在", async ({ page, baseURL }) => {
    await signIn(page, baseURL!);
    await importFiles(page, [txtFile(`${BOOK}.txt`, realNovel())]);
    await expect(shelfCard(page, BOOK)).toBeVisible({ timeout: 20_000 });

    // 服务端侧：这本得在真服务端的目录里（主套里这条是桩的自证）
    const list = await api<{ title: string }[]>(page, "/api/novels");
    expect(list.map((n) => n.title), "书架上有、服务端目录里没有").toContain(BOOK);

    await page.reload();
    await expect(shelfCard(page, BOOK)).toBeVisible({ timeout: 20_000 });
  });

  test("R-B3 读到第三章的进度，换一个标签页从服务端拿回来", async ({ page, context, baseURL }) => {
    await signIn(page, baseURL!);
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
    await signIn(page, baseURL!);
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
