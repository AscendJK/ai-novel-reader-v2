import { test, expect, type Locator, type Page } from "@playwright/test";
import { stubBackend, idleTtsStatus, type Backend, type StubTable } from "../fixtures/backend";
import { chatRequests, PROXY_CHAT_PATH, vendorBaseUrl, vendorTable, VENDOR_CHAT_PATH } from "../fixtures/vendor";
import { MAP_PLACES, mapFixture } from "../fixtures/map";
import { openApp, seedSession } from "../pages/app";
import { addProvider, leaveSettings, openSettings, openSummaryPanel } from "../pages/settings";
import { panel } from "../pages/panel";
import { importFiles, longNovel, miniNovel, navChapter, openBook, txtFile } from "../pages/shelf";

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
  opts: {
    bookTitle?: string; offline?: boolean; session?: boolean; chapters?: number;
    /** 服务商表单里的两个预算字段；不填就走产品默认（模型表 → 未匹配模型 128k/4096） */
    provider?: { contextWindow?: number; maxTokens?: number };
  } = {},
): Promise<Backend> {
  const { bookTitle = "AI 测试", offline = true, session = false, chapters = 0, provider = {} } = opts;
  const backend = await stubBackend(page, { ...idleTtsStatus, ...table });
  // 离线态起步：chat() 在离线或没有 sync-token 时只走直连腿（openai.ts:209-215），
  // C1~C8 要的就是这一条腿；需要代理腿的 C9 传 offline:false + session:true。
  await seedSession(page, { username: USER, offline });
  if (session) await page.addInitScript(() => localStorage.setItem("sync-token", "e2e-session-token"));
  await openApp(page);
  await openSettings(page);
  await addProvider(page, { name: "e2e 假商", key: FAKE_KEY, baseUrl: vendorBaseUrl(page), model: "e2e-model", ...provider });
  await leaveSettings(page);
  // 三章样本够判"发的是这一章还是那一章"，但判不了"范围"——按章号取内容的那类判据
  // 需要章数明显多于范围，否则"少取一章"和"取错一章"分不开
  await importFiles(page, [txtFile(`${bookTitle}.txt`, chapters > 3 ? longNovel(chapters) : miniNovel())]);
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
  // 厂商自己拒了 key，这时候提"会话失效"就是甩锅给后端。变异：把 `openai.ts` 的解析挪回
  // 换腿判断里（`try { return await parseResponse(...) }`）→ 这条红在 162 行：文案变成
  // "会话已失效"，代理也被多打了一次。**别**照旧注释去删"认证错误不走代理"那道守卫——
  // 它早就不在那儿了，解析阶段的错现在结构上就进不了换腿分支。
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

test("C10 图谱兜底链：模型没回关系时补出来的连线要说出来、画成虚线", async ({ page }) => {
  test.setTimeout(60_000);
  // `graph-agent.ts` 在模型一条关系都没回（或全部引用不存在的人）时，会按人物顺序补一条链。
  // 补链本身是刻意保留的（不然界面一张空网），但它与真关系在图上长得一模一样，
  // 而界面上那行「N 条关系」根本分不清是哪一种（R-E7 真厂商那档就是这么被逼着改判据的）。
  await readyWithBook(page, vendorTable({ content: { nodes: GRAPH_FIXTURE.nodes, edges: [] } }));

  await panel.tab(page, "全书分析").click();
  await panel.button(page, "生成人物关系图谱").click();
  await expect(panel.text(page, "3 个角色 · 2 条关系")).toBeVisible({ timeout: 20_000 });
  await expect(panel.text(page, /2 条是界面自己补的连线，不是模型分析出来的关系/)).toBeVisible();

  await panel.button(page, /人物关系分析图/).click();
  const svg = panel.root(page).locator("svg.w-full.h-full").first();
  // 补出来的两条都画成虚线；一条都没虚线化就是"提示写了、图上还在冒充"
  await expect(svg.locator('line[stroke-dasharray="4 3"]')).toHaveCount(2);
});

test("C10b 模型真回了关系时不许出现兜底提示（把诚实的图谱污成有假线）", async ({ page }) => {
  test.setTimeout(60_000);
  await readyWithBook(page, vendorTable({ content: GRAPH_FIXTURE }));

  await panel.tab(page, "全书分析").click();
  await panel.button(page, "生成人物关系图谱").click();
  await expect(panel.text(page, "3 个角色 · 2 条关系")).toBeVisible({ timeout: 20_000 });
  await expect(panel.text(page, /不是模型分析出来的关系/)).toHaveCount(0);
  await panel.button(page, /人物关系分析图/).click();
  await expect(panel.root(page).locator('svg.w-full.h-full line[stroke-dasharray="4 3"]')).toHaveCount(0);
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

/* ── C11~C15：五条只有真厂商量过的路径，在假厂商层各钉一条能天天跑的 ──────────── */

/**
 * 这五条的形状各自抓一种"界面看不出来的错"：
 * 范围总结喂错章、追问丢掉上一问、批量漏章或重烧、两个文字产物不落地。
 * 真厂商那一档（`specs-real/r-vendor-batch.spec.ts` R-E8~R-E12）量的是"真模型回的
 * 东西能不能走完这条链"，而那两处判据在没有真模型时**从没被证过有牙**——所以这里
 * 补上同源版本，逐条做过变异（改坏产品必须红）。
 */

test("C11 范围总结：选了第 2-4 章就只喂这三章，第 1 章和第 5、6 章一个字都不许出去", async ({ page }) => {
  test.setTimeout(60_000);
  const RANGE_TEXT = "这三章反复说的是等待：鼓声、笛声、渡口。";
  const backend = await readyWithBook(
    page,
    vendorTable({ content: RANGE_TEXT, usage: { input: 1500, output: 70 } }),
    { bookTitle: "范围书", chapters: 6 },
  );
  // 每章第一句带自己的章号（`shelf.ts` 的 `渡口N这一站的第一句`），是唯一的"这章进没进去"标记；
  // 书里另外那句共有话每章都一样，拿它判范围等于没判
  await panel.tab(page, "问答").click();
  await expect(panel.root(page).locator("#range-from")).toBeVisible();
  await panel.root(page).locator("#range-from").fill("2");
  await panel.root(page).locator("#range-to").fill("4");
  await panel.button(page, /^生成$/).click();
  await expect(panel.text(page, RANGE_TEXT)).toBeVisible({ timeout: 20_000 });

  const wire = JSON.stringify(chatRequests(backend).at(-1)?.messages ?? []);
  for (const n of [2, 3, 4]) expect(wire, `第${n}章没喂进去`).toContain(`渡口${n}这一站的第一句`);
  for (const n of [1, 5, 6]) expect(wire, `第${n}章不在所选范围里，却出现在请求里`).not.toContain(`渡口${n}这一站的第一句`);
});

/**
 * C16：范围总结装不下时，"少带了几章"不许只留在 console。
 *
 * 抬输出预留换来的是什么，这条判据把它演成现场：窗口 4096、用户在设置里把输出上限填成
 * 3000，可用输入就只剩 `4096 − 3000 − 204`（5% 安全余量按窗口算，这里 204）≈ 892 字，
 * 而 `longNovel` 每章约 120 字——请求第 2-10 章共 9 章，只塞得下前面几章。
 * 旧实现在这里是双重说谎：prompt 的结束章取自丢弃**之前**的切片（告诉模型"第 10 章的
 * 原文在这"，其实没有），界面上一句提示都没有。
 */
test("C16 范围总结装不下时：prompt 只点名真送出去的章，界面说清少带了几章", async ({ page }) => {
  test.setTimeout(60_000);
  const OUT = "这一段反复说的是等待。";
  const REQUESTED = 9; // 第 2-10 章
  const backend = await readyWithBook(
    page,
    vendorTable({ content: OUT, usage: { input: 800, output: 40 } }),
    { bookTitle: "长范围书", chapters: 12, provider: { contextWindow: 4096, maxTokens: 3000 } },
  );

  await panel.tab(page, "问答").click();
  await panel.root(page).locator("#range-from").fill("2");
  await panel.root(page).locator("#range-to").fill("10");
  await panel.button(page, /^生成$/).click();
  await expect(panel.text(page, OUT)).toBeVisible({ timeout: 20_000 });

  const wire = JSON.stringify(chatRequests(backend).at(-1)?.messages ?? []);
  const sent = Number(wire.match(/实际提供原文 (\d+) 章/)?.[1] ?? 0);
  // 前提要先成立：这一档确实丢了章。没丢就是预算算错（或窗口没填小），后面那些断言会全空判
  expect(sent, "可用输入只够几章，却没丢章——预算没生效，这条判据就是空判").toBeGreaterThan(1);
  expect(sent).toBeLessThan(REQUESTED);
  const lastSent = 1 + sent; // 从第 2 章起连续送入
  expect(wire).toContain(`渡口${lastSent}这一站的第一句`);
  // 起止章必须落在真送出去的那两章上。变异：把 `actualTo` 改回取 `rangeChapters` 末位 →
  // 这句红：prompt 会写"到 第10章 渡口10"，而第 10 章的正文根本不在请求里。
  expect(wire).toContain(`章节范围：第2章 渡口2 到 第${lastSent}章 渡口${lastSent}`);
  expect(wire, "prompt 声称的结束章不许是一章没送出去的").not.toContain(`渡口${lastSent + 1}这一站的第一句`);

  // 界面上要说得清少带了几章（数字与请求面同源，不是写死的一句"内容较长"）
  await expect(panel.text(page, new RegExp(`另有 ${REQUESTED - sent} 章原文因上下文预算没送出去`)))
    .toBeVisible();
});

test("C12 问答追问：第二发的 messages 里要带上第一问和第一答", async ({ page }) => {
  test.setTimeout(60_000);
  const Q1 = "渡口那条船是谁的？";
  const A1 = "船家是同一个船家，每天把篷布掀开又盖上。";
  const Q2 = "它等了多久？";
  const A2 = "半月：正文里写的是“等了半月”。";
  let call = 0;
  const backend = await readyWithBook(page, vendorTable(() => {
    call += 1;
    return { content: call === 1 ? A1 : A2, usage: { input: 800, output: 40 } };
  }));

  // 填与点必须成对：发出去之后输入框被清空、发送键随之 disabled（`QATab.tsx:111`），
  // 分两步写的话第二次点在禁用按钮上，红成"点不动"而不是判据想说的东西
  const ask = async (q: string) => {
    await panel.tab(page, "问答").click();
    await panel.root(page).locator("#qa-input").fill(q);
    await panel.button(page, "发送").click();
  };
  await ask(Q1);
  await expect(panel.text(page, A1)).toBeVisible({ timeout: 20_000 });
  await ask(Q2);
  await expect(panel.text(page, A2)).toBeVisible({ timeout: 20_000 });

  const chats = chatRequests(backend);
  expect(chats.length, "两问至少要两发请求").toBeGreaterThanOrEqual(2);
  const second = JSON.stringify(chats.at(-1)?.messages ?? []);
  expect(second, "第二问的 prompt 里没有第一问的原文：追问历史没带上去").toContain(Q1);
  expect(second, "带了上一问却没带上一答：模型等于看见半截对话").toContain(A1);
});

test("C13 逐章批量总结：三章各发一次且各有各的正文；已有总结再点批量一发都不许多", async ({ page }) => {
  test.setTimeout(120_000);
  // 按请求里出现的章节标记回不同的话：三章若共用一段（或只跑了第一章），下面那三条断言会分开红
  const byChapter: [string, string][] = [
    ["洛阳城下的雪", "第一章讲的是雪与城门。"],
    ["虎牢关的鼓声", "第二章讲的是鼓声与不敢信的探马。"],
    ["黑木崖上有人吹笛", "第三章讲的是笛声与等不来的下崖人。"],
  ];
  let calls = 0;
  const backend = await readyWithBook(page, vendorTable((body) => {
    calls += 1;
    const text = JSON.stringify((body?.messages ?? []) as unknown[]);
    const hit = byChapter.find(([mark]) => text.includes(mark));
    return { content: hit ? hit[1] : `第${calls}发没有对上任何一章的正文`, usage: { input: 600, output: 30 } };
  }));

  await panel.button(page, "批量").click();
  await panel.button(page, "跳过已有总结").click();
  // 这里**不**断言「停止」出现过：假厂商是秒回的，整批可能在这一句之前就完了（M3 变异就是这么
  // 红在错的那句上，看着像判据咬住了、其实咬的是竞态）。"生成中要看得见停止"归 C8 用 delayMs 钉。
  // 三章 = 三发，一发不多一发不少（真厂商那档只能钉"至少每章一发"，这里能钉死）
  await expect
    .poll(() => backend.count("POST", VENDOR_CHAT_PATH), { timeout: 30_000, message: "三章等不到三发请求" })
    .toBe(3);
  await expect(panel.button(page, "批量")).toBeVisible({ timeout: 30_000 });

  for (const [i, [, text]] of byChapter.entries()) {
    await navChapter(page, i).click();
    await expect(panel.text(page, text)).toBeVisible({ timeout: 20_000 });
  }

  // 反向：全部章节都已有总结时，「跳过已有总结」必须真的跳过——重烧的钱用户看不见
  const before = backend.count("POST", VENDOR_CHAT_PATH);
  await panel.button(page, "批量").click();
  await panel.button(page, "跳过已有总结").click();
  await page.waitForTimeout(4_000);
  expect(backend.count("POST", VENDOR_CHAT_PATH) - before, `已有总结的书再点批量还是打了 ${backend.count("POST", VENDOR_CHAT_PATH) - before} 发`).toBe(0);
});

test("C14 全书人物关系（文字分析）：模型回的分析落在折叠区里，不是只有按钮变了", async ({ page }) => {
  test.setTimeout(60_000);
  const CHAR_TEXT = "令狐冲与岳不群：师徒名分在场，人心已散；左冷禅是并肩的另一股劲。";
  await readyWithBook(page, vendorTable({ content: CHAR_TEXT, usage: { input: 2200, output: 120 } }));

  await panel.tab(page, "全书分析").click();
  await panel.button(page, "生成人物关系分析").click();
  const head = panel.button(page, /^全书人物关系$/);
  await expect(head).toBeVisible({ timeout: 20_000 });
  await head.click();
  await expect(panel.text(page, CHAR_TEXT)).toBeVisible();
});

test("C15 剧情时间线：模型回的时间线落在折叠区里", async ({ page }) => {
  test.setTimeout(60_000);
  const TL_TEXT = "雪落三日 → 鼓声一夜 → 崖上笛声，三步都在等同一个人。";
  await readyWithBook(page, vendorTable({ content: TL_TEXT, usage: { input: 2200, output: 120 } }));

  await panel.tab(page, "全书分析").click();
  await panel.button(page, "生成剧情时间线").click();
  const head = panel.button(page, /^剧情时间线$/);
  await expect(head).toBeVisible({ timeout: 20_000 });
  await head.click();
  await expect(panel.text(page, TL_TEXT)).toBeVisible();
});
