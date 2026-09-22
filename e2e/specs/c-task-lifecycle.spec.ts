import { test, expect, type Page } from "@playwright/test";
import { stubBackend, idleTtsStatus, type Backend } from "../fixtures/backend";
import { chatRequests, vendorBaseUrl, vendorTable } from "../fixtures/vendor";
import { MAP_PLACES, mapFixture } from "../fixtures/map";
import { openApp, seedSession } from "../pages/app";
import { addProvider, leaveSettings, openSettings, openSummaryPanel } from "../pages/settings";
import { panel } from "../pages/panel";
import { backToShelf, importFiles, miniNovel, navChapter, openBook, shelfCard, txtFile } from "../pages/shelf";

/**
 * C 组延伸 L1～L10：AI 任务的生命周期归任务队列，不归面板组件
 *
 * 这批判据钉的是 2026-09-22 那次改造的两端：
 *   ① 折叠 AI 面板曾经等于掐死六个 agent 的在飞任务（一格一格量出来的，
 *      见 docs 里的探针记录），现在六个都不许死，而且结果要在重开面板后认得回来；
 *   ② 同一本书的活儿必须串行（前一个没跑完不许并发第二发，避免双任务同时写同一本书），
 *      不同书必须能并行（否则读 3 本书就要排队 3 倍时间）。
 *
 * 判据一律写成"等过响应时间，结果应当回得来" —— 红 = 那个操作把任务终止了。
 * 假厂商固定慢 3.5 秒，用来留出"生成中"这段窗口做一次界面操作。
 */

const USER = "e2e-task-lifecycle";
const FAKE_KEY = "sk-e2e-lifecycle-fake-0123456789";
const SUMMARY_TEXT = "城下的雪落了三天，守卒与船家都在等同一个没有来的人。";
const ANSWER = "守将没有出关：探马三报敌军尚在三十里外，帐中无人敢信。";
const SLOW_MS = 3500;
/** 折叠/切换之后要等的时长：响应时间 + 落库 + 一次重挂 */
const SETTLE_MS = SLOW_MS + 3500;

const GRAPH_FIXTURE = {
  nodes: [
    { id: "令狐冲", group: "华山", description: "大弟子" },
    { id: "岳不群", group: "华山", description: "掌门" },
    { id: "左冷禅", group: "嵩山", description: "盟主" },
  ],
  edges: [
    { source: "令狐冲", target: "岳不群", label: "师徒" },
    { source: "岳不群", target: "左冷禅", label: "同盟" },
  ],
};

async function ready(page: Page, table: Parameters<typeof vendorTable>[0], tab?: string): Promise<Backend> {
  const backend = await stubBackend(page, { ...idleTtsStatus, ...vendorTable(table) });
  await seedSession(page, { username: USER, offline: true });
  await openApp(page);
  await openSettings(page);
  await addProvider(page, { name: "e2e 慢商", key: FAKE_KEY, baseUrl: vendorBaseUrl(page), model: "e2e-model" });
  await leaveSettings(page);
  await importFiles(page, [txtFile("折叠书.txt", miniNovel())]);
  await openBook(page, "折叠书");
  await openSummaryPanel(page);
  if (tab) await panel.tab(page, tab).click();
  return backend;
}

/** 确认厂商请求真的发出去了（不是点了没反应） */
async function inFlight(backend: Backend, what: string): Promise<void> {
  await expect
    .poll(() => chatRequests(backend).length, { timeout: 15_000, message: `${what}：15 秒内没看到厂商请求发出去` })
    .toBeGreaterThan(0);
}

/**
 * 回到书里之后确保面板在：只有看得到"展开"才点。
 * 看不到"展开"而看得到"收起" = 面板本来就还开着（返回书架/切书不卸载它），这本身就是读数。
 */
async function ensurePanelOpen(page: Page): Promise<void> {
  const expand = page.getByLabel("展开 AI 分析面板");
  if (await expand.isVisible().catch(() => false)) {
    await expand.click();
    await expect(page.getByLabel("收起 AI 分析面板")).toBeVisible({ timeout: 10_000 });
  } else {
    await expect(page.getByLabel("收起 AI 分析面板")).toBeVisible({ timeout: 10_000 });
  }
}

/** 折叠 → 等过响应时间 → 展开 → 看结果回没回来 */
async function collapseAndCheck(
  page: Page, backend: Backend, agent: string, marker: (p: Page) => ReturnType<Page["locator"]>,
  reveal?: (p: Page) => Promise<void>
): Promise<void> {
  await inFlight(backend, agent);
  await page.getByLabel("收起 AI 分析面板").click();
  await page.waitForTimeout(SETTLE_MS);
  await page.getByLabel("展开 AI 分析面板").click();
  await expect(page.locator('[data-sidebar="summary-panel"]')).toBeVisible({ timeout: 10_000 });
  if (reveal) await reveal(page);
  const back = await marker(page).first().isVisible().catch(() => false);
  const requests = chatRequests(backend).length;
  console.log(`[L 折叠] ${agent} → 厂商请求数=${requests} 结果回得来=${back ? "是" : "否"}`);
  expect(back, `${agent}：折叠面板之后结果没回来 —— 这个 agent 的在飞任务被终止了`).toBe(true);
  // 一次折叠只该花一次钱：重开面板不许把同一个任务再发一遍
  expect(requests, `${agent}：折叠再展开之后又发了一次厂商请求（重复花钱）`).toBe(1);
}

/** 全书分析 tab 里点开某个子项（图谱/地图的计数行只在展开区里，见 C4 的同款走法） */
async function openBookTabAndExpand(page: Page, subItem: RegExp): Promise<void> {
  await panel.tab(page, "全书分析").click();
  const header = panel.button(page, subItem);
  await expect(header).toBeVisible({ timeout: 20_000 });
  await header.click();
}

test("L1 本章总结：生成中折叠面板，结果要回来", async ({ page }) => {
  test.setTimeout(90_000);
  const backend = await ready(page, { content: SUMMARY_TEXT, delayMs: SLOW_MS });
  await panel.button(page, "总结本章").click();
  await collapseAndCheck(page, backend, "本章总结", (p) => panel.text(p, SUMMARY_TEXT));
});

test("L2 全书总览：生成中折叠面板，结果要回来", async ({ page }) => {
  test.setTimeout(90_000);
  const backend = await ready(page, { content: SUMMARY_TEXT, delayMs: SLOW_MS }, "全书分析");
  await panel.button(page, "生成全书总览").click();
  // 判据只认"生成完才会出现的那颗按钮"（文案恰好是「全书总览」，见 C2）；
  // 用 /全书总览/ 松匹配会连"生成全书总览"那颗静态按钮一起命中 → 假绿
  await collapseAndCheck(page, backend, "全书总览", (p) => p.getByRole("button", { name: "全书总览", exact: true }),
    async (p) => { await panel.tab(p, "全书分析").click(); });
});

test("L3 人物关系图谱：生成中折叠面板，结果要回来", async ({ page }) => {
  test.setTimeout(90_000);
  const backend = await ready(page, { content: GRAPH_FIXTURE, delayMs: SLOW_MS }, "全书分析");
  await panel.button(page, "生成人物关系图谱").click();
  await collapseAndCheck(page, backend, "图谱", (p) => panel.text(p, "3 个角色 · 2 条关系"),
    async (p) => { await panel.tab(p, "全书分析").click(); });
});

test("L4 小说地图：生成中折叠面板，结果要回来", async ({ page }) => {
  test.setTimeout(90_000);
  const backend = await ready(page, { content: mapFixture(MAP_PLACES), delayMs: SLOW_MS }, "全书分析");
  await panel.button(page, "生成小说地图").click();
  // 判据只认生成完之后展开区里的计数行（C4 用的就是这句）；"生成小说地图"那颗按钮含"小说地图"，松匹配必假绿
  await collapseAndCheck(page, backend, "地图", (p) => panel.text(p, "3 个层级 · 4 个地点"),
    async (p) => { await openBookTabAndExpand(p, /小说地图/); });
});

test("L5 问答：提问中折叠面板，回答要回来", async ({ page }) => {
  test.setTimeout(90_000);
  const backend = await ready(page, { content: ANSWER, delayMs: SLOW_MS }, "问答");
  await panel.root(page).locator("#qa-input").fill("虎牢关发生了什么？");
  await panel.button(page, "发送").click();
  await collapseAndCheck(page, backend, "问答", (p) => panel.text(p, ANSWER),
    async (p) => { await panel.tab(p, "问答").click(); });
});

test("L6 批量总结：跑到一半折叠面板，剩下的章节要继续跑", async ({ page }) => {
  test.setTimeout(150_000);
  const backend = await ready(page, { content: SUMMARY_TEXT, delayMs: SLOW_MS });
  // 批量入口是「批量」那颗，点了要先过一遍确认框（跳过已有 / 全部重新生成）
  await panel.button(page, "批量").click();
  await panel.button(page, "跳过已有总结").click();
  await inFlight(backend, "批量总结");
  const firstRound = chatRequests(backend).length;
  await page.getByLabel("收起 AI 分析面板").click();
  // 三章的书：整批要发三次请求。折叠期间不许停下来
  await expect
    .poll(() => chatRequests(backend).length, { timeout: 3 * SLOW_MS + 15_000, message: "折叠之后批量不再往下跑了" })
    .toBeGreaterThanOrEqual(3);
  await page.getByLabel("展开 AI 分析面板").click();
  await expect(page.locator('[data-sidebar="summary-panel"]')).toBeVisible({ timeout: 10_000 });
  // 面板的「本章分析」一次只摊开当前这一章，所以三章要逐章点着验，
  // 拿计数当判据会把"只落了一章"读成"少了两个"
  for (const i of [0, 1, 2]) {
    await navChapter(page, i).click();
    await expect(panel.text(page, SUMMARY_TEXT), `第 ${i + 1} 章的总结没落库`).toBeVisible({ timeout: 10_000 });
  }
  console.log(`[L 折叠] 批量总结 → 折叠前请求数=${firstRound} 折叠后累计=${chatRequests(backend).length}`);
});

test("L7 返回书架再开同一本书：在飞任务不许死", async ({ page }) => {
  test.setTimeout(90_000);
  const backend = await ready(page, { content: SUMMARY_TEXT, delayMs: SLOW_MS });
  await panel.button(page, "总结本章").click();
  await inFlight(backend, "返回书架");
  await backToShelf(page);
  await expect(shelfCard(page, "折叠书")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(SETTLE_MS);
  await openBook(page, "折叠书");
  await ensurePanelOpen(page);
  await expect(panel.text(page, SUMMARY_TEXT)).toBeVisible({ timeout: 10_000 });
});

test("L8 切到另一本书再切回来：两边的活儿各归各", async ({ page }) => {
  test.setTimeout(120_000);
  const backend = await ready(page, { content: SUMMARY_TEXT, delayMs: SLOW_MS });
  await panel.button(page, "总结本章").click();
  await inFlight(backend, "切书");
  await backToShelf(page);
  await importFiles(page, [txtFile("另一本.txt", miniNovel())]);
  await openBook(page, "另一本");
  await page.waitForTimeout(SETTLE_MS);
  await backToShelf(page);
  await openBook(page, "折叠书");
  // 切回来要认得回来看的结果，而不是"任务被切书切掉了"
  await expect(panel.text(page, SUMMARY_TEXT)).toBeVisible({ timeout: 10_000 });
});

test("L9 同一本书：前一个没跑完，后一发按不住", async ({ page }) => {
  test.setTimeout(90_000);
  const backend = await ready(page, { content: SUMMARY_TEXT, delayMs: SLOW_MS });
  await panel.button(page, "总结本章").click();
  await inFlight(backend, "同书串行");
  // 面板上每一个 AI 动作在这本书跑完之前都不该能按 —— 这是"同书串行"在界面上的样子
  await expect(panel.button(page, "批量")).toBeDisabled();
  await expect(panel.tab(page, "全书分析")).toBeVisible();
  await panel.tab(page, "全书分析").click();
  await expect(panel.button(page, "生成全书总览")).toBeDisabled();
  // 跑完之后再按就得开得了
  await page.waitForTimeout(SETTLE_MS);
  await expect(panel.button(page, "生成全书总览")).toBeEnabled({ timeout: 10_000 });
  await panel.button(page, "生成全书总览").click();
  await expect.poll(() => chatRequests(backend).length).toBeGreaterThanOrEqual(2);
});

test("L10 不同书：一本在飞时另一本照样能开跑", async ({ page }) => {
  test.setTimeout(150_000);
  // 甲书那一发要真的还在飞着才叫并行：切书 + 导入这一串走下来好几秒，
  // 响应只要 3.5 秒的话两发根本不会重叠，判据就退化成"第二本也能跑"（第一版就是这么假绿过去的）
  const SLOW_A = 9000;
  const backend = await ready(page, { content: SUMMARY_TEXT, delayMs: SLOW_A });
  await panel.button(page, "总结本章").click();
  await inFlight(backend, "异书并行·甲");

  await backToShelf(page);
  await importFiles(page, [txtFile("乙书.txt", miniNovel())]);
  await openBook(page, "乙书");
  await ensurePanelOpen(page);
  // 此刻甲书那发还在飞：乙书的面板必须已经换到"这本书手上没活儿"，
  // 否则就是运行态没按书分开（一整屏按钮被别的书钉住）
  await expect(panel.text(page, /AI 正在执行/), "甲书的任务被算到乙书头上了").toHaveCount(0);
  await expect(panel.button(page, "总结本章")).toBeEnabled({ timeout: 10_000 });
  await panel.button(page, "总结本章").click();
  await expect.poll(() => chatRequests(backend).length, { timeout: 15_000 }).toBe(2);
  console.log(`[L 并行] 两发同时在飞时厂商请求数=${chatRequests(backend).length}，甲书响应时间 ${SLOW_A}ms`);

  await page.waitForTimeout(SLOW_A + 3500);
  await expect(panel.text(page, SUMMARY_TEXT), "乙书自己的总结没落库").toBeVisible({ timeout: 10_000 });
  await backToShelf(page);
  await openBook(page, "折叠书");
  await ensurePanelOpen(page);
  await expect(panel.text(page, SUMMARY_TEXT), "乙书开跑把甲书的任务挤掉了").toBeVisible({ timeout: 10_000 });
});
