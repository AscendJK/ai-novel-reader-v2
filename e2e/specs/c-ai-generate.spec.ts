import { test, expect, type Locator, type Page } from "@playwright/test";
import { stubBackend, idleTtsStatus, type Backend, type StubTable } from "../fixtures/backend";
import { chatRequests, PROXY_CHAT_PATH, vendorBaseUrl, vendorTable, VENDOR_CHAT_PATH } from "../fixtures/vendor";
import { openApp, seedSession } from "../pages/app";
import { addProvider, leaveSettings, openSettings, openSummaryPanel } from "../pages/settings";
import { panel } from "../pages/panel";
import { importFiles, miniNovel, navChapter, openBook, txtFile } from "../pages/shelf";

/**
 * C 组：AI 生成链。厂商由 `fixtures/vendor.ts` 的假端点扮演（同源 `/api/e2e-llm/v1`），
 * 全程不出本机，也不起真后端。
 *
 * 这一组要拿到的是 jsdom 给不了的三件：真 `fetch` + 真 ReadableStream 的 SSE 帧拼接、
 * 真 IndexedDB 里的服务商配置驱动出来的真请求体（模型名、正文、stream 旗标）、
 * 以及"生成中 / 完成 / 失败"在 DOM 上的实际形状。各家厂商的字段兼容归
 * `src/api` 下的单测与服务端探针，这里不重复。
 *
 * 所有判据都过 `pages/panel.ts` 限定在桌面面板里：同一棵 SummaryPanel 被挂了两遍
 * （`ReadingPanel.tsx:124` 桌面 + `:147-159` 移动端整屏，后者为了"任务在跑不中断"常驻挂载，
 * 靠 `display:none` 藏着）。Playwright 的 strict mode 照样数它一份，不限定域就报 2 个命中。
 */

const USER = "e2e-ai-user";
/**
 * 必须纯 ASCII：这串会原样进 `Authorization: Bearer …`（`openai.ts:85-88`），而 HTTP 头
 * 只允许 ISO-8859-1——带中文时 fetch 直接抛 TypeError，症状却是面板上一句"总结生成失败"。
 * 第一版就在这里卡了一轮（D 组那只中文假 key 没事，因为它从不发出去）。
 */
const FAKE_KEY = "sk-e2e-c-fake-key-0123456789";

/** 种好会话 + 配好指向假厂商的服务商 + 导入并打开一本书；返回 backend 以便查请求面 */
async function readyWithBook(
  page: Page,
  table: StubTable,
  opts: { bookTitle?: string; offline?: boolean; session?: boolean } = {},
): Promise<Backend> {
  const { bookTitle = "AI 测试", offline = true, session = false } = opts;
  const backend = await stubBackend(page, { ...idleTtsStatus, ...table });
  // 离线态起步：chat() 在离线或没有 sync-token 时只走直连腿（openai.ts:209-215），
  // C1~C8 要的就是这一条腿；需要代理腿的 C9 传 offline:false + session:true。
  await seedSession(page, { username: USER, offline });
  if (session) await page.addInitScript(() => localStorage.setItem("sync-token", "e2e-session-token"));
  await openApp(page);
  await openSettings(page);
  await addProvider(page, { name: "e2e 假商", key: FAKE_KEY, baseUrl: vendorBaseUrl(page), model: "e2e-model" });
  await leaveSettings(page);
  await importFiles(page, [txtFile(`${bookTitle}.txt`, miniNovel())]);
  await openBook(page, bookTitle);
  await openSummaryPanel(page);
  return backend;
}

const SUMMARY_TEXT = "城下的雪落了三天，守卒与船家都在等同一个没有来的人。";

test("C1 本章摘要：请求带对模型与本章正文，SSE 分帧拼回完整结果，换章再回来不重复花钱", async ({ page }) => {
  const backend = await readyWithBook(page, vendorTable({ content: SUMMARY_TEXT, usage: { input: 900, output: 60 } }));

  await panel.button(page, "总结本章").click();
  await expect(panel.text(page, SUMMARY_TEXT)).toBeVisible({ timeout: 20_000 });

  const [sent] = chatRequests(backend);
  expect(sent, "厂商一次都没被打到，等于没测").toBeTruthy();
  expect(sent).toMatchObject({ model: "e2e-model", stream: true });
  // 发出去的必须是第一章的正文——这句话只在第一章，串章在这里就会红
  expect(JSON.stringify(sent.messages)).toContain("洛阳城下的雪");

  // 换到第二章再回来：结果必须还在，而且一个子都没再花（摘要落在 IndexedDB 的 summaries 表）
  await navChapter(page, 1).click();
  await expect(panel.text(page, "暂无总结，点击上方按钮生成")).toBeVisible();
  await navChapter(page, 0).click();
  await expect(panel.text(page, SUMMARY_TEXT)).toBeVisible();
  expect(backend.count("POST", VENDOR_CHAT_PATH), "回来看不到缓存=又打了一次厂商").toBe(1);
});

const GLOBAL_TEXT = "三条线索都指向等待：雪里的渡口、关上的鼓声、崖上的笛声。";

test("C2 全书总览：发出去的是全书样本，不是当前那一章", async ({ page }) => {
  test.setTimeout(60_000); // 展开那一步的判据给 20 秒，整条天花板要跟着抬
  const backend = await readyWithBook(page, vendorTable({ content: GLOBAL_TEXT, usage: { input: 4000, output: 300 } }));

  await panel.tab(page, "全书分析").click();
  await panel.button(page, "生成全书总览").click();
  // 生成完 SubItem 会从"生成按钮"换成折叠列表，正文默认收起——不点开就断言等于断一个不在 DOM 里的东西
  await expect(panel.button(page, /^全书总览$/)).toBeVisible({ timeout: 20_000 });
  await panel.button(page, /^全书总览$/).click();
  await expect(panel.text(page, GLOBAL_TEXT)).toBeVisible();

  const sent = chatRequests(backend).at(-1);
  const wire = JSON.stringify(sent?.messages ?? []);
  // 三章的首句互不相同，全带上才说明"全书"这条路径没退化成单章
  expect(wire).toContain("洛阳城下的雪");
  expect(wire).toContain("虎牢关的鼓声");
  expect(wire).toContain("黑木崖上有人吹笛");
});

test("C8 生成中点「停止」：按钮回位、不留转圈、不把取消报成失败", async ({ page }) => {
  const backend = await readyWithBook(page, vendorTable({ content: "被掐掉之前不该出现的正文。", delayMs: 4000 }));

  await panel.button(page, "总结本章").click();
  const stop = panel.button(page, "停止");
  await expect(stop).toBeVisible();
  await stop.click();

  await expect(panel.text(page, "AI 正在执行")).toHaveCount(0);
  await expect(stop).toHaveCount(0);
  await expect(panel.button(page, "总结本章")).toBeEnabled();
  await expect(panel.text(page, "暂无总结，点击上方按钮生成")).toBeVisible();
  // 取消不是失败：既不该弹红条（红条自带"关闭"按钮，按它判比按文案判结实——文案改一个字
  // 也不该放过），也不该把"总结生成失败: aborted"当正文写进库
  await expect(panel.button(page, "关闭")).toHaveCount(0);
  await expect(panel.text(page, /生成失败/)).toHaveCount(0);
  expect(backend.count("POST", VENDOR_CHAT_PATH)).toBe(1);
});

const PROXY_TEXT = "直连不通时由代理腿带回来的总结。";

/**
 * 在线态要让同步那几条心跳/推送有东西接：心跳连挂三次会翻成"自动离线"
 * （`sync-client.ts`），而离线态下 `chat()` 根本不试代理腿。
 */
const onlineSync: StubTable = {
  "POST /api/sync/register": { body: { isNew: false, clientId: "e2e-client", token: "e2e-token", activeCount: 1, data: null } },
  "POST /api/sync/heartbeat": { body: { ok: true } },
  "POST /api/sync/push": { body: { ok: true, serverTime: 1 } },
  "POST /api/sync/disconnect": { body: { ok: true } },
  "GET /api/novels": { body: [] },
};

test("C9 直连不通自动走代理；厂商 401 与后端 401 各说各的", async ({ page }) => {
  test.setTimeout(90_000);
  let direct = 0;
  let proxy = 0;
  const backend = await readyWithBook(page, {
    ...onlineSync,
    ...vendorTable({}, {
      direct: () => {
        direct += 1;
        // 第 1 次：厂商打不通（CORS/断网）；第 2 次：key 不对；第 3 次：又打不通，好让代理腿出场
        return direct === 2 ? { status: 401 } : { abort: true };
      },
      proxy: () => {
        proxy += 1;
        if (proxy === 1) return { content: PROXY_TEXT, usage: { input: 900, output: 60 } };
        // 后端在说自己不认识这个会话——x-proxy-auth 是它专门加的标记（proxy.js 本地鉴权失败时带）
        return { status: 401, headers: { "x-proxy-auth": "required" } };
      },
    }),
  }, { offline: false, session: true });

  const chat = panel.button(page, "总结本章");
  await chat.click();
  await expect(panel.text(page, PROXY_TEXT)).toBeVisible({ timeout: 20_000 });
  expect(direct, "第一腿该是直连").toBe(1);
  expect(proxy, "直连挂了就该换代理腿").toBe(1);
  // 代理腿的包壳里必须带上厂商地址与那条 key，否则后端根本没法转发
  expect(JSON.stringify(backend.seen().filter((s) => s.path === PROXY_CHAT_PATH))).toContain("e2e-llm");

  await chat.click();
  await expect(panel.text(page, /认证失败/)).toBeVisible({ timeout: 20_000 });
  // 厂商自己拒了 key，这时候提"会话失效"就是甩锅给后端（M6 变异：摘掉 openai.ts 里
  // "认证错误不走代理"那道判断，代理会被再打一次，文案也换成本地会话失效）
  await expect(panel.text(page, /会话已失效/)).toHaveCount(0);
  expect(proxy, "厂商说 key 不对，再走一遍代理也不会对").toBe(1);

  // 第三轮：直连又挂了，代理回 401 且带 x-proxy-auth——这是后端在说自己不认这个会话。
  // 它和厂商 401 共用 `[认证失败]` 这个前缀（sessionLost 走的也是 auth 码），真正区分两者
  // 的是那句话说的是"会话失效、不是 API Key 的问题"，所以这里判的是句子而不是前缀。
  await panel.button(page, "关闭").click();
  await chat.click();
  await expect(panel.text(page, /会话已失效/)).toBeVisible({ timeout: 20_000 });
});

/* ── 图谱与地图：模型回的是 JSON，界面要把它变成数得清的东西 ───────────────── */

const GRAPH_FIXTURE = {
  nodes: [
    { id: "令狐冲", group: "华山", description: "大弟子" },
    { id: "岳不群", group: "华山", description: "掌门" },
    { id: "左冷禅", group: "嵩山", description: "盟主" },
  ],
  // 第三条边指向一个不存在的人：模型编造节点是常态，这种边必须被过滤掉，
  // 否则图上会多出一条没有端点的线（graph-agent.ts 的 validateGraphData）
  edges: [
    { source: "令狐冲", target: "岳不群", label: "师徒" },
    { source: "岳不群", target: "左冷禅", label: "同盟" },
    { source: "令狐冲", target: "风清扬", label: "剑宗幻觉" },
  ],
};

test("C3 人物关系图谱：几人几条边就显示几，边不许指向不存在的人", async ({ page }) => {
  test.setTimeout(60_000);
  const backend = await readyWithBook(page, vendorTable({ content: GRAPH_FIXTURE }));

  await panel.tab(page, "全书分析").click();
  await panel.button(page, "生成人物关系图谱").click();
  // 幻觉边被过滤：还剩两条
  await expect(panel.text(page, "3 个角色 · 2 条关系")).toBeVisible({ timeout: 20_000 });
  // 和地图一样：生成完是折叠的一行，要点开才渲染 SVG
  await panel.button(page, /人物关系分析图/).click();

  // 三个名字都要真的落到图上；少一个就是"数对了但没画"。面板里 lucide 图标也是 svg，
  // 所以只能按图谱那张的类名取（CharacterGraph.tsx:301 的 `w-full h-full`）。
  const drawn = await panel.root(page).locator("svg.w-full.h-full").first()
    .evaluate((el) => [...el.querySelectorAll("text")].map((t) => t.textContent || ""));
  for (const name of ["令狐冲", "岳不群", "左冷禅"]) expect(drawn).toContain(name);
  expect(backend.count("POST", VENDOR_CHAT_PATH)).toBe(1);
});

const mapPlace = (id: string, name: string, level: number, parentId: string, x: number, y: number) => ({
  id, name, level, parentId, x, y, type: "城池", description: `${name}的说明`, importance: 5, affiliation: "",
});

/**
 * 一个顶级 + 一个二级 + 两个三级。
 *
 * 顶级地点在图上不画圆点（`NovelMapSection.tsx:76` 与 `renderMap` 一致），所以"父级是
 * 顶级地点"的那条连线也不画——数连线时必须按这个口径来，否则判据会对不上：
 * 这份数据画出来的父子虚线是 洛阳→东郡 与 虎牢→东郡 两条。
 */
const MAP_PLACES = [
  mapPlace("p1", "中州", 1, "", 500, 500),
  mapPlace("p2", "东郡", 2, "p1", 700, 400),
  // 洛阳的 x 故意写成数字字符串：模型常这么输出，`toCoord` 要归一成数字（map-agent.ts:16），
  // 归一不了就整图判失败——这条形状让 C4 对"坐标必须有限数"那道守卫真的有判别力
  mapPlace("p3", "洛阳", 3, "p2", "760" as unknown as number, 460),
  mapPlace("p4", "虎牢", 3, "p2", 780, 560),
];

const mapFixture = (places: ReturnType<typeof mapPlace>[]) => ({
  layers: [
    { level: 1, name: "天下", description: "" },
    { level: 2, name: "郡", description: "" },
    { level: 3, name: "城", description: "" },
  ],
  places,
  regions: [],
  forces: [],
});

/**
 * 生成并展开"小说地图"，返回预览容器里那张注入的 SVG。
 *
 * 展开这一步不能省：生成完 `NovelMapSection` 会退成一行折叠标题（`BookTab.tsx:184`），
 * 预览图与"上级没找到"那行提示都在展开区里。面板里 lucide 图标也是 `svg`，
 * 注入的那张是唯一带 viewBox 的，按它筛。
 */
async function generateMapAndOpen(page: Page): Promise<Locator> {
  await panel.tab(page, "全书分析").click();
  await panel.button(page, "生成小说地图").click();
  const header = panel.button(page, /小说地图/);
  await expect(header).toBeVisible({ timeout: 20_000 });
  await header.click();
  const preview = panel.root(page).locator("div.h-48.overflow-hidden");
  // 注入的那张图没有 class 属性，浮层里的 lucide 图标有——用这个区分（面板里 svg 共 11 张）
  const svg = preview.locator("svg[viewBox]:not([class])");
  await expect(svg).toHaveCount(1, { timeout: 20_000 });
  return svg;
}

test("C4 小说地图：四条父子关系画出两条线，坐标里没有 NaN", async ({ page }) => {
  test.setTimeout(60_000);
  await readyWithBook(page, vendorTable({ content: mapFixture(MAP_PLACES) }));

  const svg = await generateMapAndOpen(page);
  await expect(panel.text(page, "3 个层级 · 4 个地点")).toBeVisible();
  // 父子连线是虚线（renderMap.ts:242），分隔线与图例不是，按属性区分
  await expect(svg.locator('line[stroke-dasharray="4,2"]')).toHaveCount(2);
  // 批次 F 的判据在真渲染下复核：坐标不是有限数时这里会拼出 x2="NaN"，父子线静默消失
  const attrs = await svg.evaluate((el) => [...el.querySelectorAll("line")].map((l) => [...l.attributes].map((a) => a.value).join(" ")).join("|"));
  expect(attrs).toContain("4,2");
  expect(attrs).not.toMatch(/NaN|Infinity|undefined/);
});

test("C5 地图上级幻觉：点名「上级没找到」的地点，降级成顶级而不是整图失败", async ({ page }) => {
  test.setTimeout(60_000);
  await readyWithBook(page, vendorTable({ content: mapFixture(MAP_PLACES.map((x) => (x.id === "p4" ? { ...x, parentId: "ghost" } : x))) }));

  const svg = await generateMapAndOpen(page);
  await expect(panel.text(page, /1 个地点的上级没找到，已按顶级地点放置：虎牢/)).toBeVisible();
  // 降级之后它是顶级地点：不画圆点也不画线，剩下的父子线只有 洛阳→东郡 一条
  await expect(svg.locator('line[stroke-dasharray="4,2"]')).toHaveCount(1);
});

test("C6 地图自引用：地点自称自己的上级时按幻觉处理，不画出自环线", async ({ page }) => {
  test.setTimeout(60_000);
  await readyWithBook(page, vendorTable({ content: mapFixture(MAP_PLACES.map((x) => (x.id === "p4" ? { ...x, parentId: "p4" } : x))) }));

  const svg = await generateMapAndOpen(page);
  // 批次 L 之前：自引用的地点会显示成"上级：虎牢 / 下级：虎牢"。现在它走和坏 id 同一条
  // 降级路径（map-agent.ts 的 normalizePlaceParents），提示行点名、线也不再画。
  await expect(panel.text(page, /上级没找到，已按顶级地点放置：虎牢/)).toBeVisible();
  await expect(panel.text(page, /上级区域：虎牢/)).toHaveCount(0);
  await expect(svg.locator('line[stroke-dasharray="4,2"]')).toHaveCount(1);
});


test("C7 问答：问题连同检索到的原文一起发出去，答案落在气泡里", async ({ page }) => {
  test.setTimeout(60_000);
  const ANSWER = "守将没有出关：探马三报敌军尚在三十里外，帐中无人敢信。";
  const backend = await readyWithBook(page, vendorTable({ content: ANSWER, usage: { input: 1200, output: 80 } }));

  await panel.tab(page, "问答").click();
  await panel.root(page).locator("#qa-input").fill("虎牢关发生了什么？");
  await panel.button(page, "发送").click();
  await expect(panel.text(page, ANSWER)).toBeVisible({ timeout: 20_000 });

  const sent = chatRequests(backend).at(-1);
  const wire = JSON.stringify(sent?.messages ?? []);
  expect(wire).toContain("虎牢关发生了什么？");
  // 这句只存在于第二章正文里：它出现在请求里，才说明"检索到的上下文"真的发出去了，
  // 而不是让模型凭问题本身空答
  expect(wire).toContain("守将把盔缨系了两遍又松开");
  expect(backend.count("POST", VENDOR_CHAT_PATH)).toBe(1);
});
