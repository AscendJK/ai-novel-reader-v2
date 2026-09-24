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
    /** 自带的书名文本（判"截断"那类要一章特别长、另几章照常短，现成样本都凑不出这个形状） */
    novelText?: string;
  } = {},
): Promise<Backend> {
  const { bookTitle = "AI 测试", offline = true, session = false, chapters = 0, provider = {}, novelText } = opts;
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
  await importFiles(page, [txtFile(`${bookTitle}.txt`, novelText ?? (chapters > 3 ? longNovel(chapters) : miniNovel()))]);
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

test("C17 问答历史装不下时：少带的轮次要上屏，prompt 也要对模型明说", async ({ page }) => {
  test.setTimeout(90_000);
  // 窗口 4096 / 输出上限 3000 → 可用输入 892，历史上限 = 30% ≈ 267 tokens。
  // 第一答故意写长（400 字），一轮就吃掉整个历史额度，第三问必然要丢轮次。
  const LONG_A1 = "船家把篷布掀开又盖上，说这条船等了半月，".repeat(20);
  const Q1 = "渡口那条船是谁的？";
  const Q2 = "它等了多久？";
  const Q3 = "那船后来开走了吗？";
  let call = 0;
  const backend = await readyWithBook(
    page,
    vendorTable(() => {
      call += 1;
      return { content: call === 1 ? LONG_A1 : `第${call}答。`, usage: { input: 800, output: 40 } };
    }),
    { provider: { contextWindow: 4096, maxTokens: 3000 } },
  );

  const ask = async (q: string) => {
    await panel.tab(page, "问答").click();
    await panel.root(page).locator("#qa-input").fill(q);
    await panel.button(page, "发送").click();
  };
  await ask(Q1);
  await expect(panel.text(page, LONG_A1.slice(0, 24))).toBeVisible({ timeout: 20_000 });
  await ask(Q2);
  await expect(panel.text(page, "第2答。")).toBeVisible({ timeout: 20_000 });
  await ask(Q3);
  await expect(panel.text(page, "第3答。")).toBeVisible({ timeout: 20_000 });

  const chats = chatRequests(backend);
  expect(chats.length).toBeGreaterThanOrEqual(3);
  const last = chats.at(-1)!.messages as { role: string; content: string }[];
  const kept = last.filter((m) => m.role !== "system").length - 1; // 去掉本次提问本身
  const historyLen = 4; // Q1 + A1 + Q2 + A2
  const dropped = historyLen - kept;
  // 前提先成立：这一档真的丢了轮次，否则下面每一条都是空判
  expect(dropped, "历史没被裁——预算没生效，这条判据就是空判").toBeGreaterThan(0);
  expect(JSON.stringify(last), "被裁掉的轮次不许还留在请求里").not.toContain(Q1);

  // 对模型要明说：不说它就会把没送上的内容猜着往下编
  expect(last.find((m) => m.role === "system")!.content).toContain(`更早的 ${dropped} 条对话`);
  // 对用户也要明说，数字与请求面同源
  // 变异：删掉 QATab 那三行提示 → 这一句红；把返回值写成 droppedTurns: 0 → 两句都红
  await expect(panel.text(page, new RegExp(`更早 ${dropped} 条对话超出上下文预算`))).toBeVisible();
});

/**
 * C18：章节摘要被截断时，"只送进去前半章"这件事要留在卡片上，而且要留得住
 *
 * agent 早就算出 `truncated / usedFallback`，`saveChapterSummary` 却整个丢掉 → `MiniCard`
 * 那两行提示对章节摘要是死代码（全书总结反而一直在传）。窗口 4096 + 输出上限 3000 时
 * 可用输入只剩 892，一章 1500 字必然截断。第二条判据（短章不许冒提示）是防反向缺陷：
 * 把提示写成常驻，等于把"降级"这件事又变回没有信息。
 */
test("C18 章节摘要截断：提示跟着结果落库，换章回来还在；短章不许冒出提示", async ({ page }) => {
  test.setTimeout(90_000);
  const sentence = "石阶被水泡过了三道，缆桩上系着的麻绳换了两回，等船的人始终没有来，只有船家每天把篷布掀开又盖上，天黑了才回屋。";
  const longChapter = `第一章 长渡\n渡口这一站。${sentence.repeat(24)}`; // ≈1560 字
  // 短章必须长过 `MIN_STANDALONE_CHAPTER_CHARS`（chapter-detector.ts:110，50 字），
  // 否则解析阶段就被并进上一章，第二章根本不存在——那会让下面那半截判据变成空判。
  const shortChapter = "第二章 短岗\n崖上的鼓声停了半日，看火的人换了一班，谁都没提昨夜那道影子。守卒说那是回营的号，可号声之后再也没有人上山。";
  const ANSWER = "这一章说的是等待。";
  const NOTE = "本分析使用了精简模式";
  const backend = await readyWithBook(
    page,
    vendorTable({ content: ANSWER, usage: { input: 900, output: 60 } }),
    {
      bookTitle: "截断书",
      provider: { contextWindow: 4096, maxTokens: 3000 },
      novelText: `${longChapter}\n\n${shortChapter}`,
    },
  );

  await panel.button(page, "总结本章").click();
  await expect(panel.text(page, ANSWER)).toBeVisible({ timeout: 20_000 });

  // 前提先立住：这一档真的截断了（发出的正文带不满 24 遍重复），否则后面的判据全是空判
  const wire = JSON.stringify(chatRequests(backend).at(-1)?.messages ?? []);
  expect(wire).toContain("渡口这一站");
  expect((wire.match(/等船的人始终没有来/g) ?? []).length).toBeLessThan(24);
  await expect(panel.text(page, NOTE)).toBeVisible();

  // 换到第二章：短章全章送得下，不许有提示，也不许继承第一章的那一条
  // （`navChapter` 的锚点来自 `CHAPTER_TITLES`，本书标题是自己拼的，所以这里按名字定位）
  const navTo = (title: string) =>
    page.locator('[data-sidebar="chapter-nav"]').getByRole("button", { name: new RegExp(title) });
  await navTo("第二章 短岗").click();
  await expect(panel.text(page, "暂无总结，点击上方按钮生成")).toBeVisible();
  await panel.button(page, "总结本章").click();
  await expect(panel.text(page, NOTE)).toHaveCount(0);
  // 第二章也真打了一次厂商（结果同款文案，靠计数而不是靠文字区分两章）
  expect(backend.count("POST", VENDOR_CHAT_PATH)).toBe(2);

  // 回到第一章：提示必须还在，而且一个子都没再花 —— 这才算"落库了"而不是"内存里还热着"
  await navTo("第一章 长渡").click();
  await expect(panel.text(page, ANSWER)).toBeVisible();
  await expect(panel.text(page, NOTE)).toBeVisible();
  expect(backend.count("POST", VENDOR_CHAT_PATH), "回来看不到缓存=又打了一次厂商").toBe(2);
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

/* ── C19~C21：`QATab` 那一屏的出口（收藏落点 / 新会话 / 回车） ────────────────── */
/**
 * 问答这一屏之前只被判过"发出去的是什么"（C7/C11/C12/C16/C17），没被判过**拿到答案之后
 * 那三个出口**：两枚收藏按钮各自把笔记落到哪儿、「新会话」清的是哪一半、回车键按下去算不算发送。
 * 这三件事坏起来的形状都是"看着成功了，落点错了"——界面上一个错都不报。
 */

test("C19 收藏 AI 回答：「本章」和「全书」落的不是同一个地方", async ({ page }) => {
  test.setTimeout(90_000);
  const A1 = "船家说这条船等了半月，谁也没提昨夜那道影子。";
  const A2 = "号声之后再也没有人上山，守卒说那是回营的号。";
  let call = 0;
  await readyWithBook(page, vendorTable(() => {
    call += 1;
    return { content: call === 1 ? A1 : A2, usage: { input: 800, output: 40 } };
  }));

  const ask = async (q: string, answer: string) => {
    await panel.tab(page, "问答").click();
    await panel.root(page).locator("#qa-input").fill(q);
    await panel.button(page, "发送").click();
    await expect(panel.text(page, answer)).toBeVisible({ timeout: 20_000 });
  };
  // 消息列表是"最新在上"，所以每问完一答立刻点第一枚就是刚那一答（两问之后会有两枚同名按钮）
  await ask("那条船等了多久？", A1);
  await panel.button(page, "收藏到全书").first().click();
  await ask("后来有人上山吗？", A2);
  await panel.button(page, "收藏到本章").first().click();

  await panel.tab(page, "笔记").click();
  await panel.button(page, "全书笔记").click();
  await expect(panel.text(page, A1)).toBeVisible();
  await expect(panel.text(page, A2)).toHaveCount(0);
  await panel.button(page, "本章笔记").click();
  await expect(panel.text(page, A2)).toBeVisible();
  await expect(panel.text(page, A1)).toHaveCount(0);
});

test("C20「新会话」清的是整段历史：气泡清空，且下一问不再带上一次的答案", async ({ page }) => {
  test.setTimeout(90_000);
  const Q1 = "渡口那条船是谁的？";
  const A1 = "船家是同一个船家，每天把篷布掀开又盖上。";
  const Q2 = "黑木崖上谁在吹笛？";
  let call = 0;
  const backend = await readyWithBook(page, vendorTable(() => {
    call += 1;
    return { content: call === 1 ? A1 : "崖上那个人没有名字，正文里只写他会吹笛。", usage: { input: 800, output: 40 } };
  }));

  // 没有对话时这枚按钮不该占位（点了也没东西可清）。必须先切到「问答」那一格再看它——
  // 面板默认停在别的 tab，整块内容根本不挂载，那时 count 0 是白拿的（N2 变异就是这么红在后面的）
  await panel.tab(page, "问答").click();
  await expect(panel.button(page, "新会话")).toHaveCount(0);
  const ask = async (q: string) => {
    await panel.tab(page, "问答").click();
    await panel.root(page).locator("#qa-input").fill(q);
    await panel.button(page, "发送").click();
  };
  await ask(Q1);
  await expect(panel.text(page, A1)).toBeVisible({ timeout: 20_000 });

  await panel.button(page, "新会话").click();
  await expect(panel.text(page, A1)).toHaveCount(0);
  await expect(panel.text(page, Q1)).toHaveCount(0);
  await expect(panel.button(page, "新会话"), "清完没历史了，按钮就该收掉").toHaveCount(0);

  await ask(Q2);
  await expect(panel.text(page, "崖上那个人没有名字")).toBeVisible({ timeout: 20_000 });
  const wire = JSON.stringify(chatRequests(backend).at(-1)?.messages ?? []);
  expect(wire, "说好了新会话，却又把上一答喂给模型").not.toContain(A1);
  expect(wire).toContain(Q2);
});

test("C21 输入框里回车＝发送，Shift+回车＝只换行（半截问题不许发出去）", async ({ page }) => {
  test.setTimeout(60_000);
  const ANSWER = "鼓声停了半日，看火的人换了一班。";
  const backend = await readyWithBook(page, vendorTable({ content: ANSWER, usage: { input: 800, output: 40 } }));

  await panel.tab(page, "问答").click();
  const input = panel.root(page).locator("#qa-input");

  await input.fill("虎牢关的鼓声响了几夜？");
  await input.press("Shift+Enter");
  // 换行本身是 textarea 的默认行为（产品只拦普通回车），这里判的是"没发出去、字还在"
  await expect(input, "Shift+回车不该把问题发出去，字还得留着继续写").toHaveValue(/虎牢关的鼓声响了几夜？/);
  expect(backend.count("POST", VENDOR_CHAT_PATH), "Shift+回车把半截问题发出去了").toBe(0);

  await input.press("Enter");
  await expect(panel.text(page, ANSWER)).toBeVisible({ timeout: 20_000 });
  expect(backend.count("POST", VENDOR_CHAT_PATH)).toBe(1);
});

/**
 * C27：同一拍里连按两下回车，只许发一发。
 *
 * 两次按键必须**挤在同一个同步块里派发**：`input.press()` 每次自带一帧以上间隔，
 * 那点间隔足够 React 重渲染一次，闸就算读的是 state 也照样挡住——那测的其实是
 * "浏览器有多慢"。产品里这道闸读的是 ref（`useQA.ts` 的 `qaSubmitRef`），所以同拍
 * 两下只出门一发；把闸换回读 state 那一格，这条当场红。
 *
 * 数请求排在"答案上屏"之后是故意的：两发若真发出去是并行同速的，第一发的答案
 * 落地时第二发早就记上了，这时候数才不会漏。
 */
test("C27 连按两下回车只发一发：同拍的双击不许白烧一次厂商", async ({ page }) => {
  test.setTimeout(60_000);
  const ANSWER = "鼓声停了半日，看火的人换了一班。";
  const backend = await readyWithBook(page, vendorTable({ content: ANSWER, usage: { input: 800, output: 40 } }));
  const fired = () => backend.count("POST", VENDOR_CHAT_PATH);

  await panel.tab(page, "问答").click();
  const input = panel.root(page).locator("#qa-input");
  await input.fill("虎牢关的鼓声响了几夜？");

  await input.evaluate((el) => {
    for (let i = 0; i < 2; i++) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }
  });

  await expect(panel.text(page, ANSWER).first(), "两发答案刷两遍").toBeVisible({ timeout: 20_000 });
  expect(fired(), "同一拍两下回车发出两发，用户白烧一次钱").toBe(1);
});

/* ── C22~C25：`NotesTab` 那一屏的四条出口（写 / 改 / 移 / 删） ─────────────────── */
/**
 * 笔记这一屏之前只在 C19 被判过"AI 回答收藏落到哪儿"，用户自己写的那四条出口一条都没被穿过。
 * 它们坏起来的形状是同一个：**界面上看着成了，库里那条其实没动**——下次重开面板才露出来，
 * 而那时候谁也想不到是上一次点的。所以每条都断"这一屏之外"的那一半：换章之后、翻页之后、
 * 重看那一条之后。
 *
 * 挂在 C 组只因为 `readyWithBook` 已经把"开一本书 + 展开面板 + 选好第一章"铺好了；
 * 这四条本身一个子都不该花，所以每条都顺手数了一遍厂商请求数。
 */

/**
 * 一条笔记那张卡片。**按序号认条，不按正文认**：笔记列表是"最新在上"，而改正文那一条
 * 判据正好会把用来认据的那段文字换掉——用 hasText 定位的卡片会在点下「保存」的瞬间自己失效。
 */
function noteCard(page: Page, index: number): Locator {
  // 这三枚 class 只有笔记卡片凑齐（`NotesTab.tsx:92`）：问答的范围卡没 overflow-hidden，
  // MiniCard（`shared/MiniCard.tsx:59`）有 overflow-hidden 但没 min-w-0
  return panel.root(page).locator("div.shadow-none.overflow-hidden.min-w-0").nth(index);
}

/** 卡片右上角那枚没有文字的删除按钮（图标 = lucide `trash-2`，类名由图标名直接拼出来） */
function deleteButton(card: Locator): Locator {
  return card.locator("button:has(svg.lucide-trash-2)");
}

/**
 * 在「本章笔记」这一页写一条并保存；返回时输入框该是空的。
 * 认这条笔记存没存上只认卡片，不认 `getByText`：受控 textarea 的 value 会以子文本节点的形式
 * 留在 DOM 里（MUT-N2 实测：清空那行一去掉，`getByText` 当场数到 2 个命中），而"输入框还留着字"
 * 本身就是这条用例要判的事，不能拿它当认据。
 */
async function writeNote(page: Page, text: string): Promise<void> {
  await panel.tab(page, "笔记").click();
  await panel.root(page).locator("#note-input").fill(text);
  await panel.button(page, "保存笔记").click();
  await expect(noteCard(page, 0)).toContainText(text);
}

test("C22 手写笔记存的是当前章：换章看不见、翻回来还在，纯空格那一下按不下去", async ({ page }) => {
  test.setTimeout(60_000);
  const N1 = "这一条只属于第一章：城下的雪落了三天。";
  const backend = await readyWithBook(page, vendorTable({ content: "不该被打到", usage: { input: 1, output: 1 } }));
  await panel.tab(page, "笔记").click();

  const box = panel.root(page).locator("#note-input");
  await box.fill("    ");
  await expect(panel.button(page, "保存笔记"), "一个字都没有的笔记不许上架").toBeDisabled();

  await box.fill(N1);
  await panel.button(page, "保存笔记").click();
  await expect(noteCard(page, 0)).toContainText(N1);
  await expect(box, "存完还留着字，下一条会连着写成两遍").toHaveValue("");
  expect(backend.count("POST", VENDOR_CHAT_PATH), "写笔记不该花一个子").toBe(0);

  // 全书那一页不该有待它（写的是本章，落点就该是本章）
  await panel.button(page, "全书笔记").click();
  await expect(panel.text(page, "暂无全书笔记")).toBeVisible();
  await expect(panel.text(page, N1)).toHaveCount(0);
  await panel.button(page, "本章笔记").click();

  // 换到第二章：本章那一页必须换一屏，不是"跟着人走"
  await navChapter(page, 1).click();
  await expect(panel.text(page, "暂无本章笔记")).toBeVisible();
  await expect(panel.text(page, N1)).toHaveCount(0);
  await navChapter(page, 0).click();
  await expect(panel.text(page, N1)).toBeVisible();
});

test("C23 改笔记：保存只动被点那一条，取消一个字都不动", async ({ page }) => {
  test.setTimeout(60_000);
  const A = "渡口那条船，缆绳换过两次。";
  const B = "崖上的笛声只在第三夜出现过。";
  const B2 = "崖上的笛声只在第二夜出现过。";
  await readyWithBook(page, vendorTable({ content: "不该被打到", usage: { input: 1, output: 1 } }));
  await writeNote(page, A);
  await writeNote(page, B);
  // 最新在上：B 是第 0 张，A 是第 1 张
  const cardB = noteCard(page, 0);
  const cardA = noteCard(page, 1);
  await expect(cardB).toContainText(B);

  // 先走「取消」：输入框里改了字，点取消之后卡片还得是原文
  await cardB.getByRole("button", { name: "编辑" }).click();
  await cardB.locator("textarea").fill("随手打错的一半");
  await cardB.getByRole("button", { name: "取消" }).click();
  await expect(cardB).toContainText(B);
  await expect(panel.text(page, "随手打错的一半")).toHaveCount(0);

  // 再走「保存」：只改 B 那一条，A 一个字不许跟着动
  await cardB.getByRole("button", { name: "编辑" }).click();
  await cardB.locator("textarea").fill(B2);
  await cardB.getByRole("button", { name: "保存" }).click();
  await expect(cardB).toContainText(B2);
  await expect(panel.text(page, B)).toHaveCount(0);
  await expect(cardA).toContainText(A);
});

test("C24「移入全书」：本章那一页要让位，全书那一页要接手，标签还得说真话", async ({ page }) => {
  test.setTimeout(60_000);
  const N = "这条本来写在第三章，后来归到全书。";
  await readyWithBook(page, vendorTable({ content: "不该被打到", usage: { input: 1, output: 1 } }));
  await writeNote(page, N);
  await expect(noteCard(page, 0)).toContainText(N);

  await noteCard(page, 0).getByRole("button", { name: "移入全书" }).click();
  await expect(panel.text(page, "暂无本章笔记")).toBeVisible();
  await expect(panel.text(page, N)).toHaveCount(0);

  await panel.button(page, "全书笔记").click();
  await expect(panel.text(page, N)).toBeVisible();
  // 标签要说清这条是从章节移来的——留着"用户笔记"就等于把来路抹掉了
  await expect(panel.text(page, "从章节移入")).toBeVisible();
});

test("C25 删除：确认框上说不删就不许多删一条，说删才删得掉", async ({ page }) => {
  test.setTimeout(60_000);
  const A = "先写的那一条：鼓声。";
  const B = "后写的那一条：号声。";
  await readyWithBook(page, vendorTable({ content: "不该被打到", usage: { input: 1, output: 1 } }));
  await writeNote(page, A);
  await writeNote(page, B);

  const asked: string[] = [];
  let accept = false;
  page.on("dialog", async (dialog) => {
    asked.push(dialog.message());
    await (accept ? dialog.accept() : dialog.dismiss());
  });

  // 拒一次：这条笔记一个字都不能少
  await deleteButton(noteCard(page, 0)).click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toContain("确定删除");
  await expect(noteCard(page, 0)).toContainText(B);
  await expect(noteCard(page, 1)).toContainText(A);

  // 点一次：删的必须是被点那一条，另一条不许陪着没
  accept = true;
  await deleteButton(noteCard(page, 0)).click();
  await expect.poll(() => asked.length).toBe(2);
  await expect(panel.text(page, B)).toHaveCount(0);
  await expect(panel.text(page, A)).toBeVisible();
});

/* ── C26：`ChapterTab` 那个批量确认框的另两条出口（取消 / 全部重新生成） ───────── */
/**
 * 批量入口的确认框有三条出口，之前只被判过一条：C13 与 L6 都点「跳过已有总结」。
 * 剩下两条坏起来的形状都是**直接花钱**的：「取消」没关闸就等于点一下白烧一整本，
 * 「全部重新生成」被串成"也跳过"就等于用户按了重烧、拿到的却还是旧结果。
 */
test("C26 批量确认框：「取消」一发都不许多，「全部重新生成」要把已有总结那章也重烧", async ({ page }) => {
  test.setTimeout(120_000);
  const backend = await readyWithBook(page, vendorTable({ content: SUMMARY_TEXT, usage: { input: 600, output: 30 } }));
  const fired = () => backend.count("POST", VENDOR_CHAT_PATH);

  // 先让第一章有一条真总结落库（后面"跳过 vs 重烧"的分岔全靠它存在）
  await panel.button(page, "总结本章").click();
  await expect(panel.text(page, SUMMARY_TEXT)).toBeVisible({ timeout: 20_000 });
  expect(fired(), "起步就该只烧这一发").toBe(1);

  // 出口一：取消——框要关回去，而且一发都不许多
  await panel.button(page, "批量").click();
  await expect(panel.text(page, "批量总结设置")).toBeVisible();
  await panel.button(page, "取消").click();
  await expect(panel.text(page, "批量总结设置")).toHaveCount(0);
  await expect(panel.button(page, "批量")).toBeVisible();
  expect(fired(), "点了取消还发请求").toBe(1);

  // 出口二：全部重新生成——三章都要重烧一遍（跳过已有那条路径是 3-1=2 发，分得开）
  await panel.button(page, "批量").click();
  await panel.button(page, "全部重新生成").click();
  await expect.poll(fired, { timeout: 60_000, message: "三章等不到重烧的三发" }).toBe(4);
  await expect(panel.button(page, "批量")).toBeVisible({ timeout: 30_000 });
});
