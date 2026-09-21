import { test, expect, type Page, type Request } from "@playwright/test";
import { stubBackend, idleTtsStatus, type Backend, type Reply, type StubTable } from "../fixtures/backend";
import { openApp } from "../pages/app";
import { openSettings } from "../pages/settings";
import { importFiles, miniNovel, openBook, shelfCard, txtFile } from "../pages/shelf";

/**
 * F 组：RAG 建库与 TTS 资源。这一组管的是"服务器答了之后，界面到底变成了什么"——
 * 服务端自己的判定（白名单、SSE 步骤、下载守卫）由 `probe:rag` / `probe:boot` 看着，
 * 这里只补浏览器层独有的那一半：进度状态机、索引真的落进浏览器本地库、没资源时按钮
 * 是不是还在。
 *
 * RAG 那两条用 `page.clock` 拨时间：建库轮询写死 3 秒一次（`build-index.ts:270`），书架
 * 状态轮询 5 秒一次（`BookSelect.tsx:227`），真实计时跑一条要睡十几秒；而这条判据红的
 * 原因应当是"状态没推进"，不是"这台机器慢"。TTS 那三条反过来，不装假时钟，理由见 F1 上
 * 面那段。
 *
 * 每条用例书架上都只有**一本**书：卡片没有可定位的身份属性（`NovelCard.tsx:55` 起没有
 * data-novel-id），而"进度文案全局唯一"比拿 xpath 找祖先容器稳（同 B7 的取舍）。
 *
 * F 组只写了 5 条，缺的那条是**明说不做**：计划里的 F3 要验"浏览器端 ONNX 模型下不来时
 * 的降级"。E2E 这层做不了——`ensureModelReady`（`model-loader.ts:252`）拉的是真权重
 * （约 26MB，transformers.js 直接从 HF 取）：桩掉 `/api/rag/model-proxy/**` 只能证明
 * "下载请求发出去了"，那 D 组已经盯过；不桩就得在 CI 里下真模型。顺手核了一眼原假设
 * "界面根本没有降级提示"，它不成立：`useSearch.ts:94` 会把抛出来的异常原文写进
 * `searchError`，`SearchTab.tsx:108-112` 就印在那儿。剩下真正的缺口是"那句原文够不够
 *  actionable"（`未找到相关内容` 只在**没抛异常**且无结果时出现，`SearchTab.tsx:139-147`），
 * 那是文案判断，归单测与设置页，不占浏览器用例的数。
 */

const USER = "e2e-rag-user";
const ENGINE = "Xenova/bge-small-zh-v1.5";

/** 登录面 + TTS 空闲态的最小桩；`extra` 里放各条用例自己的剧本。 */
function baseTable(extra: StubTable = {}): StubTable {
  return {
    ...idleTtsStatus,
    "POST /api/sync/register": { body: { isNew: false, clientId: "e2e-client", token: "e2e-token", activeCount: 1, data: null } },
    "GET /api/sync/check-user/e2e-rag-user": { status: 404, headers: { "Access-Control-Allow-Origin": "*" } },
    "GET /api/novels": { body: [] },
    "POST /api/sync/push": { body: { ok: true, watermark: "e2e-wm", skipped: { badPayload: 0, total: 0, ids: [] } } },
    "POST /api/sync/heartbeat": { body: { activeCount: 1 } },
    "POST /api/sync/disconnect": { body: { ok: true } },
    "GET /api/rag/statuses/all": { body: {} },
    ...extra,
  };
}

/**
 * 开页前置：在线状态 + 选定引擎 + "模型已经在浏览器缓存里"（+ 可选：朗读引擎）。
 *
 * 模型那条不能用一只 localStorage 糊过去（我第一版就是这么错的）：产品开机时会拿
 * `Cache Storage:transformers-cache` 的**实际文件数**去核对那条标记，对不上就把标记删掉
 * （`model-loader.ts:394-410` 的 `verifyDownloadedModels`，它守的是"标记说下过、文件其实
 * 被浏览器清了"这个真问题）。所以照它认的东西种：往那只 cache 里放一条 URL 含
 * `/<modelKey>/` 的响应，再写标记。这样 `ensureModelReady` 直接返回 true，用例不必去
 * 真下 26MB 权重——F 组要量的是状态机与界面，不是权重。
 */
async function openOnline(page: Page, opts: { engine?: string; ttsEngine?: string; modelCached?: boolean } = {}): Promise<void> {
  const { engine = ENGINE, ttsEngine, modelCached = true } = opts;
  await page.addInitScript(
    async ({ username, ragEngine, tts, withModel }) => {
      localStorage.setItem("sync-username", username);
      localStorage.setItem("sync-token", "e2e-token");
      localStorage.setItem("novel-reader-rag-engine", ragEngine);
      if (!withModel) return;
      localStorage.setItem("novel-reader-downloaded-models", JSON.stringify([ragEngine]));
      // 键名与形状照 `tts-store.ts:108/167-172`：`loadSettings` 逐字段读，缺的一律回默认值，
      // 所以这里只写 engine 一项就够（不写就是默认的 webspeech）
      if (tts) localStorage.setItem("novel-reader-tts-settings", JSON.stringify({ engine: tts }));
      const cache = await caches.open("transformers-cache");
      await cache.put(
        new Request(`/api/rag/model-proxy/${ragEngine}/resolve/main/config.json`),
        new Response("{}", { headers: { "content-length": "2" } }),
      );
    },
    { username: USER, ragEngine: engine, tts: ttsEngine, withModel: modelCached },
  );
  await openApp(page);
  // 拿书架自己的锚点判"进来了"：白屏也能让"遮罩不存在"成立（§4.5 第 2 条）
  await expect(page.getByRole("button", { name: "从文件夹导入" })).toBeVisible({ timeout: 20_000 });
}

/** RAG 索引二进制的形状：12 字节小端头（chunksJson 长度 / 维度 / 条数）+ JSON + 向量。 */
function ragIndexBinary(chunks: string[], dim: number): Buffer {
  const json = Buffer.from(JSON.stringify(chunks), "utf8");
  const header = Buffer.alloc(12);
  header.writeUInt32LE(json.length, 0);
  header.writeUInt32LE(dim, 4);
  header.writeUInt32LE(chunks.length, 8);
  return Buffer.concat([header, json, Buffer.alloc(chunks.length * dim * 4)]);
}

/**
 * 把 `/api/rag/**` 下的 GET 动作按路径尾段分派（status / index）。
 *
 * 为什么要自己分派：novelId 是导入时才生成的，桩表写不出全路径，只能用前缀键
 * （`"GET /api/rag/**"`，见 `backend.ts:51-58`）。没接住的动作**明确 404**，不许悄悄
 * 回 200 空对象——那会让"下载过索引"这类判据假绿。
 */
function ragRouter(handlers: Record<string, () => Reply>) {
  return (req: Request): Reply => {
    const path = new URL(req.url()).pathname;
    const action = path.split("/").pop() ?? "";
    return handlers[action]?.() ?? { status: 404, body: { error: `F 组桩没接住的动作：GET ${path}` } };
  };
}

async function importOne(page: Page, title: string): Promise<void> {
  await importFiles(page, [txtFile(`${title}.txt`, miniNovel())]);
  await expect(shelfCard(page, title)).toBeVisible({ timeout: 20_000 });
}

/** 拨假时钟直到条件成立（照 E 组 `advanceUntil`：每步给真实微任务一次落地的机会）。 */
async function runUntil(page: Page, cond: () => boolean, stepMs = 3_000, maxSteps = 20): Promise<boolean> {
  for (let i = 0; i < maxSteps; i++) {
    if (cond()) return true;
    await page.clock.runFor(stepMs);
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

const pathsOf = (backend: Backend, method: string, suffix: string) =>
  backend.seen().filter((r) => r.method === method && r.path.endsWith(suffix));

/**
 * 假时钟只装在 RAG 那两条（F1/F2）里，不在 `beforeEach` 里全局装。
 *
 * TTS 那三条要等真东西：Toast 5 秒自动收（`toast-store.ts:34-37`）、朗读失败自动重试
 * 每 2 秒一次（`useAudioPlayer.ts:317`）、播放栏跟着 AudioContext 的真实时间走。
 * 装上去之后这些都得手动拨钟才有进展，而"拨多少下才算该重试完了"是把判据换成猜时间。
 */
test("F1 建库进度按服务器状态推进，完成后索引真的落进浏览器本地库", async ({ page }) => {
  test.setTimeout(120_000);
  await page.clock.install();
  let poll = 0;
  const script = [
    { status: "building", current: 1, total: 3 },
    { status: "building", current: 3, total: 3 },
    { status: "ready" },
  ];
  const backend = await stubBackend(
    page,
    baseTable({
      "POST /api/rag/**": { body: { status: "building", queuePosition: 0, engine: ENGINE } },
      "GET /api/rag/**": ragRouter({
        status: () => ({ body: script[Math.min(poll++, script.length - 1)] }),
        index: () => ({
          body: ragIndexBinary(["洛阳城下的雪落了三天", "虎牢关的鼓声一夜未停"], 8),
          contentType: "application/octet-stream",
        }),
      }),
    }),
  );
  await openOnline(page);
  await importOne(page, "建库测试");

  await page.getByRole("button", { name: "构建" }).click();

  // 1) 点下去先看到"构建中"：弹窗标题与卡片徽章两处都得跟着变
  await expect(page.getByRole("heading", { name: "正在构建检索索引" })).toBeVisible();
  await expect(page.getByText("BGE 构建中...")).toBeVisible();

  // 2) 进度跟着服务器给的 current/total 走，而不是写死一句"构建中"
  for (const [step, line] of [[1, "正在编码 (1/3)"], [2, "正在编码 (3/3)"]] as const) {
    const advanced = await runUntil(page, () => poll >= step);
    expect(advanced, `3 秒一次的建库轮询应当被假时钟拨出来（第 ${step} 次）`).toBe(true);
    await expect(page.getByText(line)).toBeVisible();
    if (step === 1) await expect(page.getByText("1 / 3 · 33%")).toBeVisible();
  }

  // 3) ready 之后索引必须真的落到浏览器本地库，卡片才会说"已缓存"
  //    （变异量出来的边界：把 `doBuild` ready 分支里那次 `downloadAndCacheIndex` 摘掉，
  //    这条**照样绿**——书架自己的自动预取（`BookSelect.tsx:254`）会补上这一趟。
  //    所以 F1 钉住的是"用户点完构建之后索引最终在本地库里"，不钉是哪一条路下的；
  //    只钉 `doBuild` 内部那一趟得另开一条，而它已经被单测覆盖。）
  await expect(page.getByRole("heading", { name: "索引构建完成" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("BGE 已缓存")).toBeVisible({ timeout: 20_000 });
  expect(pathsOf(backend, "GET", "/index"), "ready 之后应当下载一次索引").toHaveLength(1);
});

test("F2 服务端拒掉这只引擎：界面要说清是哪只、可选是哪几只，不许静默换默认模型重建", async ({ page }) => {
  test.setTimeout(120_000);
  await page.clock.install();
  // 用的是白名单里真实存在的 GTE：浏览器侧要过 `ensureModelReady` 那道模型门（它按
  // modelKey 认缓存），而"两侧白名单不同步 / 老客户端配新服务端"本来就是 R-29 的真实形状。
  const refused = "Xenova/gte-small";
  const backend = await stubBackend(
    page,
    baseTable({
      "POST /api/rag/**": {
        status: 400,
        body: { error: "不支持的嵌入引擎", engine: refused, allowed: [ENGINE, "Xenova/multilingual-e5-small"] },
      },
      "GET /api/rag/**": ragRouter({ status: () => ({ body: { status: "none" } }) }),
    }),
  );
  await openOnline(page, { engine: refused });
  await importOne(page, "被拒的引擎");

  await page.getByRole("button", { name: "构建" }).click();
  await expect(page.getByRole("heading", { name: "索引构建失败" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("不支持的嵌入引擎")).toBeVisible();
  // 正面：报错里得点出被拒的是哪只引擎、能换的是哪几只。分开两条各断一句：
  // 只写"构建失败"等于让人猜，只报错误原因不报清单等于让人去设置页翻。
  await expect(page.getByText(/不支持的嵌入引擎：Xenova\/gte-small/)).toBeVisible();
  await expect(page.getByText(/可选：Xenova\/bge-small-zh-v1\.5、Xenova\/multilingual-e5-small/)).toBeVisible();

  // 反向：绝不能"看起来成功了"
  await expect(page.getByRole("heading", { name: "索引构建完成" })).toHaveCount(0);
  expect(pathsOf(backend, "GET", "/index"), "失败之后不许去下载索引").toHaveLength(0);
  const builds = pathsOf(backend, "POST", "/build");
  expect(builds.map((r) => r.body), "只该按用户选的那只引擎请求一次").toEqual([`{"engine":"${refused}"}`]);
});

/**
 * F7：嵌入模型下不来时点「构建」，界面必须说清"为什么没动"。
 *
 * 形状是真后端那一档量出来的（`e2e/specs-real` 的 R-C1）：`/api/rag/model-proxy` 上挂着
 * `rateLimit(10)`（`rag.js:337`），而浏览器开机就会为预取打它两次，于是几分钟之内多点几
 * 本书、或者家里几台设备同时开着，用户真点「构建」时那趟取模型会拿到 **429**。
 * `ensureModelReady` 于是返回 false，而 `BookSelect.tsx:285-288` 的处理是
 * `console.warn(...) 然后 return` —— 界面上什么都没有：不转圈、不报错、徽章还停在"未构建"，
 * 按钮还留在焦点上。用户能得到的唯一反馈就是"再点一次，还是没反应"。
 * 修复口径：把这条失败交给既有的失败分支（`failBuild`），让卡片显示"BGE 失败"和原因。
 */
test("F7 模型下不来时点「构建」：界面要给出原因，不许一动不动", async ({ page }) => {
  test.setTimeout(120_000);
  const backend = await stubBackend(
    page,
    baseTable({
      // 真后端上就是这只接口先撞上 10 次/分钟的闸门
      "GET /api/rag/model-proxy/**": { status: 429, body: { error: "请求过于频繁" } },
      "GET /api/rag/**": ragRouter({ status: () => ({ body: { status: "none" } }) }),
    }),
  );
  // `modelCached: false` 是关键：不种"模型已经下过"的标记，也不往 Cache Storage 里放假响应，
  // 于是 `ensureModelReady` 真会去打那只 429 的桩
  await openOnline(page, { modelCached: false });
  await importOne(page, "下不来模型");

  await page.getByRole("button", { name: "构建", exact: true }).click();

  await expect(page.getByText("BGE 失败")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/模型/).first()).toBeVisible({ timeout: 10_000 });
  // 反向：不许悄悄算成功——徽章不能停在中间态，也不许自己"就绪"
  await expect(page.getByText(/BGE (构建中|就绪|已缓存)/)).toHaveCount(0);
  expect(backend.count("POST", "/api/rag/tts/prepare"), "这条用例不该碰 TTS 资源").toBe(0);
});

/** 44 字节头的单声道 PCM WAV：够把"服务器给了音频"这条事实演真，不含任何真实语音。 */
function wav(samples: number[], sampleRate = 24000): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2));
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // 单声道（`server-engine.ts:47` 只认这个）
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/**
 * `/api/rag/tts/status` 的响应形状照 `server-engine.ts:24-29`。`ready` 由用例侧的开关
 * 决定——真实后端就是这只接口的语义：模型没下完报未就绪，`prepare` 走完之后报就绪。
 * 写死成常量会让"客户端有没有回来重查"这条判据失去对象。
 */
function ttsStatus(ready: () => boolean): StubTable {
  return {
    "GET /api/rag/tts/status": () => ({
      body: {
        serverInference: { supported: true, ready: ready(), reason: ready() ? "" : "模型未下载" },
        wasmReady: true,
        modelReady: true,
        vocoderReady: true,
      },
    }),
  };
}

/**
 * SSE 帧。注意 `route.fulfill` 不能分块，整个 body 在浏览器侧是一次 `read()` 到齐的，
 * 所以中间那些 step 的**文案**在 E2E 里观测不到（React 把它们批量吃掉，`serverPreparing`
 * 落回 false 时那一行已经卸载）。这条不是偷懒：F4 判的是"就绪"这个终态凭什么成立，
 * 而 step/error 两条分支的解析由 F4b 与 `probe:rag` 分头看着。
 */
const SSE = (frames: object[]) => ({
  contentType: "text/event-stream",
  body: frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""),
});

test("F4 启用服务端推理：界面进入「已就绪」只能跟着服务器的状态，不能自己宣布", async ({ page }) => {
  test.setTimeout(120_000);
  // 开关在 `prepare` 被请求时才扳：照真实后端的因果（模型下完 → status 才报就绪）。
  // 桩在请求到达时就扳，比"流读完"早几毫秒，而客户端要等 done 帧才重查（见 F4b：
  // 没有 done 时它就不查，那几毫秒的提前伤不到判据）。
  let prepared = false;
  const backend = await stubBackend(
    page,
    baseTable({
      ...ttsStatus(() => prepared),
      "GET /api/rag/tts/prepare": () => {
        prepared = true;
        return SSE([
          { type: "step", step: "开始", detail: "检查 TTS 资源..." },
          { type: "step", step: "模型: 开始下载", detail: "尝试 GitHub（海外源）" },
          { type: "step", step: "语音模型", detail: "就绪 ✓" },
          { type: "done" },
        ]);
      },
    }),
  );
  await openOnline(page, { ttsEngine: "server" });
  await openSettings(page);

  // 起点：服务器说"可用但没下模型"，界面就必须停在这句话上，并把启用入口摆出来
  await expect(page.getByText("服务端推理可用，但模型尚未下载到服务器")).toBeVisible({ timeout: 20_000 });
  const enable = page.getByRole("button", { name: "启用服务端推理（下载模型）" });
  await expect(enable).toBeVisible();

  await enable.click();

  // 终态走的是服务器第二次报来的 ready，而不是 `done` 帧自带的绿色勾（`TTSSettings.tsx:531`
  // 那一支读的是 `serverStatus.ready`）。删掉 `enableServerInference` 末尾那次
  // `refreshServerStatus()`，这条就会红在"点完按钮界面还停在未下载"。
  await expect(page.getByText("服务端推理已就绪（模型已下载到服务器")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("但模型尚未下载到服务器")).toHaveCount(0);
  await expect(enable).toHaveCount(0);
  expect(pathsOf(backend, "GET", "/api/rag/tts/prepare"), "启用必须真去问服务器一次").toHaveLength(1);
  expect(backend.count("GET", "/api/rag/tts/status"), "完成后要重查一次服务器状态").toBeGreaterThanOrEqual(2);
  await expect(page.getByText("启用失败")).toHaveCount(0);
});

test("F4b 半截流：SSE 没给出 done 就不许当成功宣布就绪", async ({ page }) => {
  test.setTimeout(120_000);
  const backend = await stubBackend(
    page,
    baseTable({
      // 服务器始终报未就绪：客户端若把"流读完了"当成"下完了"，这里就是它露馅的地方
      ...ttsStatus(() => false),
      // 服务器把话说了一半就断了（进程被杀 / 反代掐线）：有 step、没有 done
      "GET /api/rag/tts/prepare": SSE([
        { type: "step", step: "模型: 开始下载", detail: "尝试 GitHub（海外源）" },
      ]),
    }),
  );
  await openOnline(page, { ttsEngine: "server" });
  await openSettings(page);
  await page.getByRole("button", { name: "启用服务端推理（下载模型）" }).click();

  await expect(page.getByText("启用失败：服务器未返回完成状态")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("服务端推理已就绪")).toHaveCount(0);
  // 入口得留着：失败之后用户应当还能再点一次，而不是面对一片空白
  await expect(page.getByRole("button", { name: "启用服务端推理（下载模型）" })).toBeVisible();
  expect(pathsOf(backend, "GET", "/api/rag/tts/prepare")).toHaveLength(1);
});

test("F5 服务器拒了这次合成：拒的那句原话必须到用户眼前，不许让他对着一分钟空转", async ({ page }) => {
  test.setTimeout(120_000);
  const reason = "服务器未安装 Python 或 sherpa-onnx（pip install sherpa-onnx）";
  const backend = await stubBackend(
    page,
    baseTable({
      ...ttsStatus(() => true),
      "POST /api/rag/tts/synthesize": { status: 503, body: { error: reason } },
      "POST /api/rag/tts/cancel": { body: { ok: true } },
    }),
  );
  await openOnline(page, { ttsEngine: "server" });
  await importOne(page, "朗读测试");
  await openBook(page, "朗读测试");
  await page.getByTitle("语音朗读").click();

  // 服务器给的原文（连 `pip install sherpa-onnx` 这个可操作的下一步）得出现在界面上，
  // 而且**不能让用户等满 60 秒**才看到。这两件事是同一条判据：修复前实测——
  // 两段预生成各自 503 之后，`prepareBuffers` 只盯 `prepareReady`，于是界面钉在
  // "正在预生成 0/2 段"整 60 秒（无进展兜底），60.3s 才转成"朗读出错"，
  // 自动重试 3 次跑完、Toast 带着原话在 66.3s 才出现，5 秒后自己收掉。
  // 现在给 20 秒：够跑完重试链（3 次 × 2 秒）的余量，而 60 秒那条老路必定超。
  const reasonHere = page.getByText(/pip install sherpa-onnx/).first();
  await expect(reasonHere).toBeVisible({ timeout: 20_000 });
  // 但"出现过"不算数：Toast 5 秒就自己收（`toast-store.ts:34-37`），用户回头只看得到
  // 播放栏那四个字。等过 Toast 的寿命再判一次，还在的只能是常驻在栏子里的那一处。
  await page.waitForTimeout(6_500);
  await expect(reasonHere).toBeVisible();
  // 反向判据：出错之后不能变成死角——播放栏还在，且带着"重试"这个出口
  await expect(page.getByTitle("重试", { exact: true })).toBeVisible();
  // 2 段预生成 + 现场生成 1 次 + 自动重试 3 次
  expect(backend.count("POST", "/api/rag/tts/synthesize"), "每段都只按重试预算生成，不许无限重试").toBe(6);
});

test("F6 停止朗读：播放栏收掉、顶栏按钮回来，并且真的通知服务器作废排队", async ({ page }) => {
  test.setTimeout(120_000);
  const backend = await stubBackend(
    page,
    baseTable({
      ...ttsStatus(() => true),
      // 每段 1.5 秒 + 6 秒长音：真实服务器上"一段推理要跑两三秒"是常态，用户就是会在
      // 预生成还没结束时按停止。不拖这一秒，停止就落在播放中段上，判的就不是那条路。
      "POST /api/rag/tts/synthesize": async () => {
        await new Promise((r) => setTimeout(r, 1_500));
        return {
          body: wav(Array.from({ length: 24000 * 6 }, (_, i) => Math.sin(i / 40)), 24000),
          contentType: "audio/wav",
        };
      },
      "POST /api/rag/tts/cancel": { body: { ok: true } },
    }),
  );
  await openOnline(page, { ttsEngine: "server" });
  await importOne(page, "朗读测试");
  await openBook(page, "朗读测试");

  await page.getByTitle("语音朗读").click();
  // 播放栏的锚点：`title="上一章"` 全局只出现在这一栏里（`AudioPlayer.tsx:158`）
  const bar = page.getByTitle("上一章", { exact: true });
  await expect(bar).toBeVisible({ timeout: 20_000 });
  const stop = page.getByTitle(/停止/).first();

  // 开口时就会先 cancel 一次作废上一批（`tts-manager` 的开场清理），所以判"增量"
  const before = backend.count("POST", "/api/rag/tts/cancel");
  await stop.click();

  // 先睡 3 秒再判"栏子没了"，而不是点完立刻判：预生成阶段点停止，收尾那一轮 100ms
  // 轮询醒来时可能把 UI 又拨回"生成中"（修复前实测就是这样，且再没人清得掉）。
  // `toHaveCount(0)` 是"看到一次成立就通过"，抢在那一两百毫秒之前跑完就变成一条抓不到
  // 东西的绿——所以这里要的是"消失之后还待着"。
  await page.waitForTimeout(3_000);
  await expect(bar).toHaveCount(0);
  await expect(page.getByTitle("语音朗读")).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => backend.count("POST", "/api/rag/tts/cancel") > before, { timeout: 10_000, message: "停止朗读必须让服务器释放队列位置" })
    .toBe(true);
});

