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
import { createRequire } from "node:module";
import { join } from "node:path";
import { sel } from "../pages/app";
import { txtFile, importFiles, shelfCard, openBook, backToShelf, navChapter } from "../pages/shelf";
import { DEV_DATA_BASELINE, devDataFingerprint } from "./preflight";
import { DATA_DIR, ORIGIN, RUN, api, realNovel, signIn, waitIsolated } from "./fixtures";

const USER = `r组真账号-${RUN}`;
const BOOK = `真后端测试书-${RUN}`;

/** `better-sqlite3` 没带 @types，这一档只用到三个方法，手写最小形状 */
interface BenchDb {
  prepare(sql: string): { run(...args: unknown[]): unknown };
  close(): void;
}

/**
 * 往**台架自己那份一次性库**（`ANR_REAL_DATA_DIR/novels.db`）里塞 `user_settings` 行。
 *
 * 为什么要手改库：上行那一侧服务端本来就拒收 API 配置（`server/sync-handler.js:190`），
 * 从界面上填钥匙再同步是塞不进库里的——"服务器库里真躺着一把别人塞进来的钥匙"这个前提
 * 只有直接写库能造出来。写的对象是包外的一次性目录，开发目录的 `server/data/` 一个字不碰
 * （R-B5 那条红线继续盯着它）。服务端是 WAL（`server/database.js:15`），第二只连接的
 * 已提交事务对它下一次读可见；`timeout` 是给 checkpoint 让路的，撞上了等，不重试写。
 */
function seedBenchSettings(username: string, rows: [string, unknown][]): void {
  if (!DATA_DIR) throw new Error("ANR_REAL_DATA_DIR 没给：这一档不许在开发目录上跑");
  const Database = createRequire(import.meta.url)("better-sqlite3") as new (
    file: string,
    opts?: Record<string, unknown>
  ) => BenchDb;
  const db = new Database(join(DATA_DIR, "novels.db"), { timeout: 10_000 });
  try {
    const put = db.prepare("INSERT OR REPLACE INTO user_settings (username, key, value) VALUES (?, ?, ?)");
    for (const [key, value] of rows) put.run(username, key, JSON.stringify(value));
  } finally {
    db.close();
  }
}

/**
 * 读浏览器共享库里的全部 settings 行。不走 Dexie——那是应用自己的模块，页面上没挂到 window，
 * 而这一档要判的正是"落到这台机器存储里的东西"，直接开 IndexedDB 才是终态。
 */
function readSharedSettings(page: Page): Promise<{ key: string; value: unknown }[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opened = indexedDB.open("ai-novel-reader-shared");
      opened.onupgradeneeded = () => reject(new Error("共享库不存在：应用没在这台机器上建过库"));
      opened.onsuccess = () => resolve(opened.result);
      opened.onerror = () => reject(opened.error);
    });
    try {
      return await new Promise<{ key: string; value: unknown }[]>((resolve, reject) => {
        const all = db.transaction("settings", "readonly").objectStore("settings").getAll();
        all.onsuccess = () => resolve(all.result as { key: string; value: unknown }[]);
        all.onerror = () => reject(all.error);
      });
    } finally {
      db.close();
    }
  });
}

/**
 * 等下一轮同步真的走完一次 push（响应里就带着服务端的 settings）。
 * 不拿界面那枚离线/在线按钮去抢：切离线之后"切换回在线"藏在要点开的弹层里，
 * 多两处可坏的地方；客户端本来就每 30 秒一轮 `doSync`（`sync-client.ts:210`），
 * 90 秒的预算够跑到第二轮。等完再顺手打一行耗时，红的时候看得出是哪一段慢。
 */
async function awaitPush(page: Page): Promise<number> {
  const from = Date.now();
  await page.waitForResponse((r) => r.url().endsWith("/api/sync/push") && r.status() === 200, {
    timeout: 90_000,
  });
  return Date.now() - from;
}

/**
 * 页内自采样「已丢弃」回执，覆盖整段下行。
 *
 * **为什么不能到点了再查一次**：回执是一只会自己消失的 toast。上一轮就栽在这里——诊断行读到
 * `getByText=1`（回执正在屏上），紧接着的 `toHaveCount(0)` 却绿了，后面 12 次 250ms 采样全为 0。
 * 一次性的断言盯不住一只会自己消失的东西，那条判据是空的。
 *
 * 所以改成：写库之前就把表开起来，页内每 120ms 认一次，命中一次就永久记住，三条读数判完再收表。
 * 两头都要盖住：起点在 push 之前是"不许跟它抢那几毫秒"，尾巴塞一截是实测要的——
 * 回执的 React 提交落在见证键写进共享库**之后**，前两秒内就收表会读成 false（见判据体）。
 * 认的是 `textContent` 而不是 `innerText`：后者每轮强制一次排版，而这扇窗要张 30 多秒。
 */
async function openReceiptWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __b7?: { hit: boolean; rounds: number; timer: number } };
    if (w.__b7) clearInterval(w.__b7.timer);
    w.__b7 = { hit: false, rounds: 0, timer: 0 };
    w.__b7.timer = window.setInterval(() => {
      const s = w.__b7!;
      s.rounds++;
      if (document.body.textContent?.includes("条 API 配置已丢弃")) s.hit = true;
    }, 120);
  });
}

/** 收表：停表并把命中与轮数一起带回来（轮数用来证明这扇窗真的张着，不是开了个空表） */
async function readReceiptWindow(page: Page): Promise<{ hit: boolean; rounds: number }> {
  return page.evaluate(() => {
    const w = window as unknown as { __b7?: { hit: boolean; rounds: number; timer: number } };
    if (w.__b7) clearInterval(w.__b7.timer);
    return { hit: w.__b7?.hit ?? false, rounds: w.__b7?.rounds ?? 0 };
  });
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

  test("R-B7 服务器库里真躺着一把 API 钥匙时，它不许落到这台机器的共享库里", async ({ page, baseURL }) => {
    /**
     * 这一条判的是**服务端读侧那道闸门**（`server/database.js:538-547`）在真后端 + 真库 +
     * 真浏览器存储这条链上真的站着：库里那一行是台架手写的（上行拒收，界面上塞不进去），
     * 客户端每次 push 的响应里服务端都会回一份 settings（`gatherSyncData` 对 settings
     * 不看 since），所以只要它漏一条，钥匙就会顺着 `applyServerData` 落进共享库。
     *
     * 三条读数的分工要说清：
     * - **见证键落地**：同一次下行里那条普通配置进了库——这条不成立就说明根本没发生过下行，
     *   后面两条绿也是空转。
     * - **钥匙不进共享库**：整张 settings 表序列化之后不许含那把 canary。
     * - **屏上没有「已丢弃」回执**：客户端那道闸门（`src/sync/sync-bridge.ts:210`）真收到东西
     *   才会当面报数。它在真后端这一档**正常情况下永远不响**——响了就说明服务端那条闸门坏了、
     *   是客户端在替它兜（这条形状是用台架变异验的：把 `database.js:545` 那行过滤摘掉之后，
     *   第三条翻红、第二条仍绿，两闸各自的岗位这才各自有证据）。
     *   这一条只能页内自采样（见 `openReceiptWindow`）：上一轮拿一次性断言去盯，回执明明在屏上
     *   （同一毫秒里 `getByText=1`），`toHaveCount(0)` 却还是绿的——那只 toast 活不过一次往返。
     */
    const holder = `r组钥匙-${RUN}`;
    const CANARY = `EK-${RUN}-这把钥匙不该出现在浏览器里`;
    const WITNESS = `e2e-witness-${RUN}`;
    await signIn(page, baseURL!, holder);
    // 窗从下行之前就张开：谁也不知道 toast 会落在响应回来后的第几毫秒，
    // 而这一条要的判据是"整段下行里一次都没弹过"，不是"我查的那一刻没弹"。
    await openReceiptWindow(page);

    seedBenchSettings(holder, [
      [`api-providers:${holder}`, { providers: [{ id: "bench", name: "台架塞进来的", engine: "openai", baseUrl: "http://127.0.0.1:9/v1", apiKey: CANARY, models: [] }] }],
      [WITNESS, { landed: true }],
    ]);

    const waited = await awaitPush(page);
    console.log(`[R-B7] 等这一次 push 走了 ${(waited / 1000).toFixed(1)} 秒（客户端每 30 秒一轮）`);

    await expect
      .poll(async () => (await readSharedSettings(page)).some((r) => r.key.startsWith(WITNESS)), {
        timeout: 20_000,
        message: "同一次下行里的普通配置都没落地：这一趟根本没走过 settings 那条路，后面两条判据是空的",
      })
      .toBe(true);

    const rows = await readSharedSettings(page);
    console.log(`[R-B7] 共享库 ${rows.length} 行，键：${rows.map((r) => r.key).join(",")}`);
    expect(
      rows.some((r) => r.key.startsWith("api-providers") || r.key.startsWith("api-active-provider")),
      `浏览器共享库里出现了 API 配置键（共 ${rows.length} 行）`
    ).toBe(false);
    expect(JSON.stringify(rows), "服务器下发的内容里带着那把 canary").not.toContain(CANARY);

    // 第三条收那扇窗（理由见 `openReceiptWindow`）。尾巴塞这一截是**实测要求的**：+32.6s 那句
    // "已丢弃"报出来的同一瞬间，见证键就已经能在共享库里查到——toast 的 React 提交落在落库之后。
    // 上一版判完前两条立刻收表，247 轮采样全空，把一条真会弹的回执读成了 false。
    await page.waitForTimeout(1_500);
    const receipt = await readReceiptWindow(page);
    console.log(`[R-B7] 回执窗采样 ${receipt.rounds} 轮，命中=${receipt.hit}`);
    expect(receipt.rounds, "页内采样没跑起来：第三条是空判据").toBeGreaterThan(50);
    expect(receipt.hit, "屏上出现过「已丢弃」回执——服务端那道闸门漏了，是客户端在替它兜").toBe(false);
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
