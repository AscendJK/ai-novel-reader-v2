/**
 * R-C：真后端上的 RAG 全链路。
 *
 * 这一组存在的理由只有一句：**今天没有任何一层真下过那只模型。**
 *  - 主套 F1/F2 把 `/api/rag/model-proxy/**` 桩掉了（`f-rag-tts.spec.ts:52-58` 明写着
 *    "F 组要量的是状态机与界面，不是权重"），并且往 `transformers-cache` 里种了一条假响应
 *    专门骗过 `verifyDownloadedModels`；
 *  - `probe:rag` 看的是服务端自己的契约，管不到"浏览器拿同一只模型编码出来的向量，
 *    能不能在服务端建的索引里搜回这段话"。
 * 所以 R-C3 是这一档最有独占价值的一条：一次真问答要穿过"服务端建库 → 索引下发到浏览器 →
 * 查询回服务端编码 → 点积排序"这一整圈，任何一环换了模型或换了维度都搜不回来。
 * 两侧白名单不同步（R-29 那一类）在桩层是演不出来的：桩会照着前端想的样子回向量。
 *
 * 一条本轮现学的形状：**在线时查询编码走服务端 `POST /api/rag/encode`**
 * （`embedding-retriever.ts:276-293`），浏览器 Worker 编码是它失败之后的回退（`:295-300`），
 * 所以"浏览器有没有把权重下进 Cache Storage"在有服务器的场合**不是**检索成立的前提。
 * 我前两版都把它当成了前提：一版断言缓存有货（红在 0 条），一版让 TF-IDF 静默降级蒙了过去。
 *
 * 判据口径：
 *  - 服务端侧的"真下载"用**落盘字节**量（`<DATA_DIR>/models-cache` 里出现 ≥20MB 的 .onnx），
 *    不靠日志、不靠"请求发出去了"；
 *  - 检索侧的"真回来了"用一个**与目标句零词面重叠**的问句问，命中里必须出现全书唯一的
 *    哨兵数字（三百七十二）——不然 TF-IDF 回退（`SummaryPanel.tsx:309` 那句"当前使用
 *    TF-IDF 回退检索"）也能靠关键词糊过去。
 */
import { test, expect, type Page } from "@playwright/test";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { sel } from "../pages/app";
import { panel } from "../pages/panel";
import { openSummaryPanel } from "../pages/settings";
import { importFiles, longNovel, openBook, shelfCard, txtFile } from "../pages/shelf";
import { DATA_DIR, ORIGIN, RUN, api, realNovel, signIn } from "./fixtures";

const USER = `r组真读者-${RUN}`;
const OTHER = `r组隔壁-${RUN}`;
const BOOK = `RAG真书-${RUN}`;
const LONG = `RAG长书-${RUN}`;
const ENGINE = "Xenova/bge-small-zh-v1.5";
/** bge-small-zh-v1.5 的向量维度；服务端与浏览器任一侧换了模型，这个数或检索结果就会不对 */
const DIM = 512;
/** 全书只有第二章出现过这个数字，检索结果里有它就等于"回到了那一章" */
const UNIQUE_FACT = "三百七十二";
/** 与目标句**没有任何共同词**的问法（台阶≠石阶、维护≠扫），把 TF-IDF 回退排除在外 */
const QUERY = "山门里谁在照料那段台阶，多久弄一回";

const MODEL_DIR = path.join(DATA_DIR, "models-cache", "Xenova");

function biggestOnnx(): { file: string; bytes: number } {
  let best = { file: "", bytes: 0 };
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".onnx")) {
        const b = statSync(p).size;
        if (b > best.bytes) best = { file: `${p.slice(DATA_DIR.length)} (${(b / 1048576).toFixed(1)} MB)`, bytes: b };
      }
    }
  };
  if (existsSync(MODEL_DIR)) walk(MODEL_DIR);
  return best;
}

/** 书架上这本书在服务端的那一行（拿 id；顺带钉"记在这个用户名下"） */
async function bookRow(page: Page, title: string) {
  const list = await api<{ id: string; title: string; joined: boolean }[]>(
    page,
    `/api/novels?username=${encodeURIComponent(USER)}`,
  );
  const row = list.find((n) => n.title === title);
  expect(row, `服务端目录里没有「${title}」`).toBeTruthy();
  // 不带 username 时这只接口回的是全库目录（`novels.js:12-21`），"目录里有这本"
  // 谁都能满足；只有 joined 才说明是**这个用户**的
  expect(row!.joined, `服务端没把「${title}」记在 ${USER} 名下`).toBe(true);
  return row!;
}

/** 直接问建库进度（非 200 也原样回，交给判据自己说清） */
async function progress(page: Page, novelId: string): Promise<{ status?: string; current?: number; total?: number; chunkCount?: number; dim?: number }> {
  const token = await page.evaluate(() => localStorage.getItem("sync-token"));
  const r = await page.request.get(
    `${ORIGIN}/api/rag/${novelId}/status?engine=${encodeURIComponent(ENGINE)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return r.status() === 200 ? ((await r.json()) as never) : { status: `http-${r.status()}` };
}

/**
 * 库里那一行（终态的 `dim` / `buildTime` 只能从这儿拿）。
 *
 * `/status` 与 `/statuses` **都**在刚建完的那一阵里回**内存态**（`rag-builder.js:155-166`
 * 与 `:173-184` 两道 `if (mem)` 都排在 DB 查询前面，内存条目要过几秒才被 prune），
 * 而内存条目里没有 dim。我第一版直接断言 dim，红在 `undefined`——
 * 同一个接口在两个时刻形状不同，只有真后端跑得出来。所以这里等到它换回 DB 那一版为止。
 */
async function dbRow(page: Page, novelId: string): Promise<{ status?: string; chunkCount?: number; dim?: number }> {
  const token = await page.evaluate(() => localStorage.getItem("sync-token"));
  const r = await page.request.get(
    `${ORIGIN}/api/rag/statuses?ids=${novelId}&engine=${encodeURIComponent(ENGINE)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const all = (await r.json()) as Record<string, { status?: string; chunkCount?: number; dim?: number }>;
  return all[novelId] ?? {};
}

async function dimFromDB(page: Page, novelId: string): Promise<number | undefined> {
  return (await dbRow(page, novelId)).dim;
}

/**
 * 等 `/api/rag/model-proxy` 的限流窗过去（`rag.js:337` 的 `rateLimit(10)`，按 IP、一分钟）。
 *
 * 为什么这一档必须等：浏览器一开机就为预取打这只接口两次，于是一串用例跑下来，
 * 用户（这里就是 R-C1）那一次真取模型会撞上 429 —— 而修复前那次的表现是"点了构建
 * 什么也没发生"（判据见主套 F7）。这一档不桩任何接口，所以只能等真闸门开。
 * 探的是 `config.json`（几百字节），不会替判据把 22.9MB 的权重提前下下来。
 */
async function waitForProxyHeadroom(page: Page): Promise<void> {
  const probe = `${ORIGIN}/api/rag/model-proxy/${ENGINE}/resolve/main/config.json`;
  await expect
    .poll(
      async () => {
        const r = await page.request.get(probe);
        return r.status();
      },
      { timeout: 150_000, intervals: [5_000], message: "model-proxy 一直接着 429，限流窗没过去" },
    )
    .toBe(200);
}

test.describe.serial("真后端：模型真下载、索引真建、问一句真搜得回来", () => {
  test("R-C1 点「构建」→ 服务端真去镜像拉 bge 权重落盘，索引建成且维度对得上", async ({ page, baseURL }) => {
    test.setTimeout(12 * 60_000);
    // 先把这只引擎的服务端缓存清掉，不然"真下载"这条判据只是复用了上一轮的缓存。
    // 清的是**一次性目录**里的模型缓存（包外、可再生），不是开发目录的 server/data。
    //
    // 实测这一趟是谁拉的：点「构建」之前客户端先过 `ensureModelReady`，它打
    // `/api/rag/model-proxy/…/model_quantized.onnx`，由**服务端进程**去
    // `https://hf-mirror.com/` 取回并写进 `models-cache`（22.9 MB），再转给浏览器；
    // 之后 worker 建库时直接命中同一只缓存（`[rag] done: … 3 chunks 512d 4044ms`）。
    // 所以这条判据钉的是"权重由服务端落到服务端目录里"，不钉发起方——两个发起方共用一只缓存。
    const before = biggestOnnx();
    rmSync(MODEL_DIR, { recursive: true, force: true });

    await signIn(page, baseURL!, USER);
    await importFiles(page, [txtFile(`${BOOK}.txt`, realNovel())]);
    await expect(shelfCard(page, BOOK)).toBeVisible({ timeout: 30_000 });

    await waitForProxyHeadroom(page);
    await page.getByRole("button", { name: "构建", exact: true }).click();
    // 只钉**持久态**：那颗弹窗标题（「正在构建检索索引」/「索引构建完成」）在这一层是
    // 抢得到的瞬时物——三章书在服务端 375ms 就建完了（实测日志
    // `[rag] done: … 3 chunks 512d 375ms`），弹窗开合都在一次轮询（3 秒）的间隙里。
    // 中间态由主套 F1 用假时钟钉（`f-rag-tts.spec.ts:133`），这一条改钉卡片徽章：
    // 它由服务端状态驱动，且建完就一直留着。
    await expect(page.getByText(/BGE (就绪|已缓存|已加载)/).first()).toBeVisible({ timeout: 90_000 });

    const after = biggestOnnx();
    expect(after.bytes, `首建之后服务端缓存里没有 .onnx（跑之前有 ${before.bytes} 字节）`).toBeGreaterThan(20 * 1048576);
    expect(after.file, "落盘的权重不是用户选的那只引擎").toContain("bge-small-zh-v1.5");

    const row = await bookRow(page, BOOK);
    const p = await progress(page, row.id);
    expect(p.status, `建库终态不是 ready：${JSON.stringify(p)}`).toBe("ready");
    const db = await dbRow(page, row.id);
    expect(db.chunkCount, "三章的书该有三个片段").toBe(3);
    // 等内存条目被 prune、接口换回库里那一行，才量得到维度
    await expect
      .poll(() => dimFromDB(page, row.id), { timeout: 90_000, message: "服务端一直没报出向量维度" })
      .toBe(DIM);
  });

  test("R-C2 建库进度按服务端报的 current/total 往前推，不是一句写死的「构建中」", async ({ page, baseURL }) => {
    test.setTimeout(8 * 60_000);
    await signIn(page, baseURL!, USER);
    // 40 章：三章的书在热缓存下几秒就完事，"推进"这个过程根本采不到样（采不到就等于
    // 判据没跑）。章数多到足够让编码阶段跨过几次采样，current 才是可观测的。
    await importFiles(page, [txtFile(`${LONG}.txt`, longNovel(40))]);
    await expect(shelfCard(page, LONG)).toBeVisible({ timeout: 60_000 });
    const row = await bookRow(page, LONG);

    const samples: { status?: string; current?: number; total?: number }[] = [];
    await waitForProxyHeadroom(page);
    await page.getByRole("button", { name: "构建", exact: true }).click();
    for (let i = 0; i < 240; i++) {
      const s = await progress(page, row.id);
      samples.push(s);
      if (s.status === "ready" || s.status === "error") break;
      await page.waitForTimeout(250);
    }

    // 进行中的形态按 `rag-builder.js` 实际写出来的那几种：queued / building /
    // downloading（拉模型）/ encoding（逐章编码，current 只在这段动）。
    // "loading" 是我原先猜的，代码里没有——写进判据之前对了一遍 set(...) 的那几行。
    const ACTIVE = ["queued", "building", "downloading", "encoding"];
    const seen = samples.filter((s) => s.status && ACTIVE.includes(s.status));
    expect(seen.length, `一次也没采到"进行中"的中间态（采到 ${samples.length} 次：${JSON.stringify(samples.slice(0, 4))}）`).toBeGreaterThan(0);
    const currents = [...new Set(seen.map((s) => s.current ?? 0))].sort((a, b) => a - b);
    expect(currents.length, `进度数字从头到尾没动过：${JSON.stringify(currents)}`).toBeGreaterThan(1);
    expect(currents, "进度只能单调前进").toEqual([...currents].sort((a, b) => a - b));

    const last = samples[samples.length - 1];
    expect(last.status, "终态不是 ready").toBe("ready");
    // 界面这一侧：卡片徽章要跟着服务器的终态变，且不再是那颗「构建」按钮
    await expect(page.getByText(/BGE (就绪|已缓存|已加载)/).first()).toBeVisible({ timeout: 60_000 });
  });

  test("R-C3 问一句与目标句零词面重叠的话：服务端建的索引 + 服务端编码的查询，第一条就是那一章", async ({ page, baseURL }) => {
    test.setTimeout(8 * 60_000);
    await signIn(page, baseURL!, USER);
    await expect(shelfCard(page, BOOK)).toBeVisible({ timeout: 30_000 });
    // 先等索引真的进了**浏览器**本地库（书架会自动预取），否则下面那次搜索会走
    // `useSearch.ts:69-74` 那条静默降级：`buildIndex(..., { cacheOnly: true })` 一抛错
    // 就把引擎换成 tfidf。我第一版就栽在这儿——TF-IDF 按单字打分也能把第二章排到最前，
    // 于是"搜回哨兵句"这条判据被一条谁都没打算测的路满足了（最后是"缓存里 0 条权重"
    // 那句话把它揭出来的）。
    await expect(page.getByText(/BGE (已缓存|已加载)/).first()).toBeVisible({ timeout: 90_000 });
    await openBook(page, BOOK);

    // 面板默认是收着的（`ReadingPanel.tsx:99` 那枚「展开 AI 分析面板」），不先展开
    // 面板里任何定位器都等不到——它会一声不响地耗掉 actionTimeout 的 60 秒
    await openSummaryPanel(page);
    await panel.tab(page, "搜索").click();
    // 必须限定在桌面面板里：`SummaryPanel` 挂了桌面与移动两份（`panel.ts:5-11` 的来由），
    // 那个 `id="rag-search-input"` 在 DOM 里出现两次
    await panel.root(page).locator("#rag-search-input").fill(QUERY);
    // 先挂上响应监听再敲回车：`embedding-retriever.ts:276-293` 的次序是**服务端编码优先**
    // （`POST /api/rag/encode`），只有它失败才回退浏览器 Worker（`:295-300`）。
    // 所以在线这一腿根本不会去下 26MB 权重——我上一版断言 `transformers-cache` 有货，
    // 量的是一条设计上不会跑的路（红在"缓存里 0 条"就是这个）。
    const encoded = page.waitForResponse(
      (r) => r.url().includes("/api/rag/encode") && r.request().method() === "POST",
      { timeout: 3 * 60_000 },
    );
    await page.keyboard.press("Enter");
    const enc = await encoded;
    expect(enc.status(), "查询编码没走服务端 /api/rag/encode —— 这一次不是向量检索").toBe(200);

    // 命中本身：哨兵句必须排在**第一条**（只判"结果里有"会被 TF-IDF 的单字打分蒙过去，
    // 上一版就是这么假绿的）
    const firstResult = panel.root(page).locator("p.whitespace-pre-wrap").first();
    await expect(firstResult, "第一条结果不是那句哨兵句").toContainText(UNIQUE_FACT, { timeout: 3 * 60_000 });
    await expect(panel.text(page, "未找到相关内容")).toHaveCount(0);
    // 面板那行「引擎:」跟着结果走（`SearchTab.tsx:88-100`）：降级成内置打分时写的是
    // "TF-IDF（内置）"（`src/rag/engines.ts:14-16`）
    await expect(panel.text(page, "TF-IDF（内置）")).toHaveCount(0);
    await expect(panel.text(page, /BGE Small/).first()).toBeVisible();
    // 浏览器端编码那一腿只在断网时走，归 R-F（真后端离线复跑）
  });

  test("R-C4 换一个用户：书架上不该长出别人的书（过滤靠服务端算的 joined，界面只留 join 过的）", async ({ page, baseURL }) => {
    await signIn(page, baseURL!, OTHER);
    await expect(sel.emptyShelf(page)).toBeVisible({ timeout: 30_000 });

    // 我第一版写的是"隔壁用户的 `/api/novels` 里没有 A 的书"，跑出来是**反的**，
    // 而且不是产品错：`server/routes/novels.js:12-21` 不带 `username` 时走 `db.listNovels()`，
    // 回的是**全库目录**；带 `username` 时走 `listNovelsWithUserStatus`，同样是全库，
    // 只是每行多一个服务端算出来的 `joined`（`server/database.js:330-345`）。
    // 这本书对谁可见由 join 决定，不是由列表决定。所以判据只能问 joined，
    // 再问"界面按它过滤得对不对"——后半句恰恰只有浏览器层看得见。
    const rows = await api<{ title: string; joined: boolean }[]>(
      page,
      `/api/novels?username=${encodeURIComponent(OTHER)}`,
    );
    const book = rows.find((r) => r.title === BOOK);
    expect(book, `目录里应当有「${BOOK}」这一行（全库目录），没有就说明接口形状又变了`).toBeTruthy();
    expect(book!.joined, "服务端把别人上传的书标成了我 join 过").toBe(false);
    const mine = rows.filter((r) => r.joined).map((r) => r.title);
    expect(mine, `新用户不该 join 过任何书，服务端报了：${mine.join("、")}`).toEqual([]);
  });
});
