import { test, expect, type Page } from "@playwright/test";
import { stubBackend, idleTtsStatus } from "../fixtures/backend";
import { seedSession, openApp, expectUnblocked } from "../pages/app";
import { chapterSection, importFiles, miniNovel, openBook, shelfCard, txtFile } from "../pages/shelf";

/**
 * H 组：PWA / Service Worker / 离线。跑的是 `dist/`（构建产物），不是 dev。
 *
 * 为什么这一组必须在构建产物上跑：dev 下 SW 根本不注册、Vite 直接发 COOP/COEP
 * （`vite.config.ts:133-139`），线那半逻辑（SW 注册、COI 注入、precache、离线兜底）
 * 一行都走不到。伺服那台是 `e2e/serve-dist.mjs`——刻意**不带**跨源隔离头，
 * 和 GitHub Pages 一样，于是 `crossOriginIsolated` 只可能来自 sw.js 里注入的那段
 * （`scripts/coi-sw.js`）。计划 §3.2 原本写的是 `vite preview`，实测不能用：
 * preview 继承了 `server.headers`（`vite/dist/node/chunks/node.js:33852`），
 * 头由服务器白送，把 SW 整段删掉 H1 照样绿。
 */

const USER = "h-pwa-user";

// 这一组只能串行跑：H3 的「换一版 SW」和 H5 的「SW 装得慢」都是**服务器进程级**的开关
// （SW 脚本的抓取不受页面级拦截管辖，开关只能做在服务器上，见 setServedSwRev 那段）。
// 并跑时实测过：H5 把 sw.js 拖慢 6 秒的那十几秒里，H3/H4 的上下文一起被拖进去 →
// 三条同红，红的却不是它们各自的判据。串行 5 条约 35 秒，换得到这份干净。
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  // 台架自证：`reuseExistingServer` 复用的是那台进程**启动时**做过的 freshness 检查，
  // 之后改了源码它不会再建（实测踩过：变异改完照跑，五条全绿，量的其实是旧 dist）。
  // 所以每条用例开跑前先问一句产物新不新，旧就直接红，不出假绿。
  const stale = await (await fetch(new URL("__e2e-dist-stale", baseURL ?? "").href)).text();
  if (stale !== "fresh") {
    throw new Error(`dist/ 比源码旧（${stale}）：先 npm run build，或把手工挂着的 e2e/serve-dist.mjs 停掉再跑`);
  }
  await stubBackend(page, idleTtsStatus);
  await seedSession(page, { username: USER });
  await openApp(page);
});

/**
 * 页内取值：这一组的页面会**自己刷新**（等 SW 接管的那 1.2 秒一次，点「更新」之后又一次），
 * 而 `expect.poll` 的谓词一抛错整条 poll 立刻红（实测：poll 到一半撞上导航就报
 * "Execution context was destroyed"，而不是继续等）。所以只把"撞上导航"这一类折成兜底值，
 * 其余错误照抛——不然就把真失败也一起吞了。
 */
async function read<T>(page: Page, fn: () => T | Promise<T>, whileNavigating: T): Promise<T> {
  try {
    return await page.evaluate(fn);
  } catch (e) {
    if (/destroyed|navigation|Target page, context or browser has been closed/i.test(String(e))) {
      return whileNavigating;
    }
    throw e;
  }
}

/** SW 接管到什么程度了：一次读回三个事实，红的时候报出来的就是它们，不是一句 Timeout */
function swState(page: Page): () => Promise<{ ctrl: boolean; coi: boolean; reloads: number }> {
  return () => read(page, swStateInPage, { ctrl: false, coi: false, reloads: -1 });
}

function swStateInPage(): { ctrl: boolean; coi: boolean; reloads: number } {
  return {
    ctrl: !!navigator.serviceWorker.controller,
    coi: window.crossOriginIsolated,
    reloads: Number(sessionStorage.getItem("coi-reload-count") ?? "0"),
  };
}

/**
 * 等到 SW 真的接管页面。
 *
 * 首屏那一次导航发生在 SW 接管之前，所以它一定不带 COI 头；`main.tsx:29-37` 靠
 * sessionStorage 计数最多自刷 3 次去等 SW。轮询的是产品自己那三个量，红的时候
 * 能分清是「SW 没注册上」（ctrl=false）还是「刷到 3 次还没隔离」（coi=false, reloads=3）。
 */
async function waitControlled(page: Page): Promise<void> {
  await expect
    .poll(swState(page), {
      timeout: 45_000,
      message: "SW 没接管，或者接管了但 COOP/COEP 没注入（这台服务器刻意不发这两个头）",
    })
    .toEqual({ ctrl: true, coi: true, reloads: expect.any(Number) });
}

/** 横幅会盖住书架下沿（fixed bottom-4 z-200），点卡片之前先收掉。 */
async function dismissBanner(page: Page): Promise<void> {
  for (const name of ["忽略", "知道了"]) {
    const btn = page.getByRole("button", { name, exact: true });
    if (await btn.isVisible().catch(() => false)) await btn.click();
  }
}

/** 页内那条探针：只有接管页面的 SW 能答上话，答不上就是「没有这一版 SW」。 */
function swProbe(page: Page): () => Promise<string> {
  return () =>
    read(
      page,
      async () => {
        const res = await fetch("__e2e_sw_rev");
        return res.ok ? res.text() : `no-sw-answer:${res.status}`;
      },
      "navigating",
    );
}

/**
 * 让服务器下一份 sw.js 换一个字节内容（"" = 换回原始那一份）。
 *
 * 实测过不能靠 `page.route`/`context.route` 换 SW 脚本：桩会命中，可 Chromium 装进
 * 注册的不是桩回去的那一份（`route` 命中 1 次、装好的 SW 里 `self.__E2E_REV` 仍是
 * undefined）。SW 脚本的抓取不归页面级拦截管，所以开关只能做在服务器上。
 */
async function setServedSwRev(rev: string): Promise<void> {
  await switchServer("rev", rev);
}

/** 让 `sw.js` 晚 N 毫秒到手（"" = 不拖）：模拟慢手机上 SW 装得慢。 */
async function setServedSwDelay(ms: string): Promise<void> {
  await switchServer("delay", ms);
}

async function switchServer(which: "rev" | "delay", value: string): Promise<void> {
  const base = test.info().project.use.baseURL ?? "";
  const res = await fetch(new URL(`__e2e-sw-${which}`, base).href, { method: "POST", body: value });
  if (!res.ok) throw new Error(`设置 SW ${which} 失败: ${res.status}`);
}

test("H1 构建产物首屏：SW 注册并接管，跨源隔离靠 SW 注入，自刷不超过 3 次", async ({ page }) => {
  await waitControlled(page);

  const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope ?? "");
  expect(new URL(scope).pathname, "SW 的 scope 应当盖住部署 base，注册错了就管不到整站").toBe(
    "/ai-novel-reader-v2/",
  );

  // 自刷次数直接读产品自己那个计数器：>3 就是「刷到上限还是没隔离」，
  // 用户看到的是页面反复闪，而 SharedArrayBuffer 始终拿不到。
  const { reloads } = await swState(page)();
  expect(reloads, `为了拿到 crossOriginIsolated 自刷了 ${reloads} 次`).toBeLessThanOrEqual(3);
  expect(reloads, "这台服务器不发 COOP/COEP，隔离只能来自 SW，所以至少要自刷一次").toBeGreaterThan(0);
});

test("H2 导入之后断网重开：书架还在、正文还读得到，离线首屏仍然隔离", async ({ page, context }) => {
  await waitControlled(page);
  await dismissBanner(page);

  await importFiles(page, [txtFile("离线测试.txt", miniNovel())]);
  await expect(shelfCard(page, "离线测试")).toBeVisible();
  await openBook(page, "离线测试");
  await expect(chapterSection(page, 1)).toContainText("虎牢关的鼓声一夜未停");

  // 桩全撤掉再断网：留着桩的话 /api 照样回 200，「断网」就只是把静态资源断了，
  // 而这一条要验的正是「同步/后端整条路都不通时还能不能读书」。
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

  await page.reload();
  await expect(shelfCard(page, "离线测试")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("3 章")).toBeVisible();

  await openBook(page, "离线测试");
  await expect(chapterSection(page, 0)).toContainText("洛阳城下的雪落了三天");
  await expect(chapterSection(page, 1)).toContainText("虎牢关的鼓声一夜未停");
  await expect(chapterSection(page, 2)).toContainText("黑木崖上有人吹笛");

  // 离线那一版首屏必须还是隔离的：`coi-sw.js` 的 fromPrecache + 重新包头就是为这一条写的。
  // 只验"页面打得开"不够——回到缓存副本时不补 COI 头，页面能打开但 SharedArrayBuffer
  // 没了，症状是「断网之后浏览器朗读起不动模型」，看上去像 TTS 坏了。
  await expect
    .poll(async () => (await swState(page)()).coi, {
      timeout: 15_000,
      message: "离线重开的首屏丢了 COI 头",
    })
    .toBe(true);
});

test("H3 检测到新版本：横幅出现，点「更新」之后接管页面的换成新 SW", async ({ page }) => {
  await waitControlled(page);
  const probe = swProbe(page);
  // 基线：原始那份 sw.js 里没有探针，这条 fetch 只能落到网络上去拿 404
  expect(await probe(), "基线不该带探针").toMatch(/^no-sw-answer/);

  await setServedSwRev("rev-b");
  try {
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());

    await expect(page.getByText("有新版本可用")).toBeVisible({ timeout: 20_000 });
    const apply = page.getByRole("button", { name: "更新", exact: true });
    await expectUnblocked(apply);
    await apply.click();

    // 点完必须真的换人：只有新装那一版 SW 答得上这条 fetch。
    // 横幅自己消失、页面自己刷新都不算数——那些只证明"点了个按钮"，
    // 而 updateSW(true) 漏发 SKIP_WAITING 时页面照样刷新，用户却永远停在旧版。
    await expect
      .poll(probe, { timeout: 30_000, message: "点了「更新」，接管页面的还是旧 SW" })
      .toBe("rev-b");
    await expect(page.getByText("有新版本可用")).toHaveCount(0);
  } finally {
    await setServedSwRev("");
  }
});

test("H4 TTS worker 不进 precache：产物里的 sherpa-tts 走网络，别的资源照常缓存", async ({ page }) => {
  await waitControlled(page);

  // precache 装完才有键；那条缓存的名字带 origin，所以按前缀找
  let urls: string[] = [];
  await expect
    .poll(
      async () => {
        urls = await page.evaluate(async () => {
          const name = (await caches.keys()).find((k) => k.startsWith("workbox-precache"));
          if (!name) return [] as string[];
          const keys = await (await caches.open(name)).keys();
          return keys.map((req) => new URL(req.url).pathname);
        });
        return urls.length;
      },
      { timeout: 30_000, message: "workbox precache 缓存是空的：SW 没装好" },
    )
    .toBeGreaterThan(0);

  expect(
    urls.filter((u) => u.includes("/sherpa-tts/")),
    "sherpa-tts 被 precache 拦了：precache 用 Cache Storage 的响应加载 worker，COEP: credentialless 下没有 CORP 头会被拒（vite.config.ts:55-62）",
  ).toEqual([]);
  // 反向判据：枚举不是空的——assets 那批必须进 precache，否则这条等于什么都没测
  expect(
    urls.filter((u) => u.startsWith("/ai-novel-reader-v2/assets/")).length,
    `precache 里没有 assets：globPatterns 或构建坏了（实际 ${urls.length} 条）`,
  ).toBeGreaterThan(0);

  const status = await page.evaluate(async () => (await fetch("sherpa-tts/sherpa-onnx-tts.worker.js")).status);
  expect(status, "worker 文件本身得还在产物里：它不该被 precache，但要能走网络拿到").toBe(200);
});

test("H5 SW 装得慢也只做一次刷新：刷新预算不许在'接管之前'就烧掉", async ({ browser }) => {
  // 产品的形状是：`ensureCrossOriginIsolated()` 挂在 `serviceWorker.ready` 之后
  // （`main.tsx:51-56`），所以那 3 次预算是从"SW 就绪"才开始烧的——实测把 sw.js
  // 拖慢 6 秒，仍然只刷 1 次、8.1 秒就隔离到位。
  //
  // 这条判据钉的是那个**先后关系**：谁要是把刷新挪到开机就发（脱离 ready），慢接管
  // 就会把 3 次预算烧光，然后永久停在非隔离态——浏览器朗读起不动模型，症状像 TTS 坏。
  // 实测那一刀（DOMContentLoaded 里也调一次）：H5 红在"再也拿不到隔离"，H3/H4 跟着红
  // （它们也等隔离），H1 反倒还绿——它只判"≤3 次"，预算被烧光这件事它看不见。
  // 所以"刷新只能花在等接管之后"这一半，只有 H5 钉得住。
  const base = test.info().project.use.baseURL ?? "";
  await setServedSwDelay("6000");
  try {
    // 每次导航都要重新过这条桩：刷新会把上一次装的丢掉
    const context = await browser.newContext({ baseURL: base });
    const page = await context.newPage();
    await stubBackend(page, idleTtsStatus);
    await seedSession(page, { username: USER });
    await page.goto(base);

    await expect
      .poll(swState(page), { timeout: 45_000, message: "SW 装得慢就再也拿不到隔离" })
      .toEqual({ ctrl: true, coi: true, reloads: expect.any(Number) });
    const { reloads } = await swState(page)();
    expect(reloads, `接管本来就是一次性的，刷了 ${reloads} 次说明刷新没等接管`).toBeLessThanOrEqual(1);
    await context.close();
  } finally {
    await setServedSwDelay("");
  }
});
