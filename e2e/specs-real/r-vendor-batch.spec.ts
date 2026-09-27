/**
 * R-E5..E12：产品里每一条 AI 路径都打在真厂商上各跑一次。
 *
 * E5～E7 是最贵的三条（全书总览 / 地图 / 人物关系图谱）；E8～E12 补齐此前从没在真厂商上
 * 走过的五条：人物关系文字分析、剧情时间线、范围总结、自定义问答、逐章批量总结。
 * 它们过去只在同源假厂商（`e2e/fixtures/vendor.ts`）上跑过形状，而假厂商的回包是照着
 * 我们自己写的剧本给的——"真模型会不会回空正文、产品会不会把自己写的占位话当成结果"
 * 这两件事一次都没被量过。
 *
 * 这三类是产品里最贵的三条路径：一次点击要把全书目录或长样本发出去，地图与图谱还要
 * 模型回一份结构化的 JSON。今天它们只在同源假厂商（`e2e/fixtures/vendor.ts`）上跑过形状——
 * 假厂商的回包是照着我们自己写的剧本给的，所以"真模型面对 40 章目录会不会截断、
 * 会不会不吐合法 JSON、会不会把上下文吃爆"这三件事一次都没被量过。
 *
 * 输入用台架自造的合成长书（`longNovel(40)`），不是制作人的真书稿——判据要的是
 * "长 prompt + 结构化回包"这条路径真走通，不需要拿真内容冒险。
 *
 * 判据口径钉"结构性的事实"，不盯模型的措辞：
 *  - 全书总览：钉**发出去的 prompt**——① 目录覆盖到首/中/尾三段的章号；② 正文来源两条路
 *    （章节样本 / 语义检索段落）走哪条都行，但**顶着哪条的标签就得真有哪条的内容**。第一版钉的是
 *    "回来的正文里要原样出现某一句章内话"——那是拿生成式输出当断言对象，它换个说法就红，红了也不是
 *    产品的错（实测就是这么红的）；第二版钉死"必须有样本块"，又红了一次：这本 40 章的书签了检索，
 *    样本整段被预检索替代是设计行为（`summarizer.ts:172`）。样本自身的覆盖交给单元层
 *    （`summarizer-global.test.ts`），那一层量得到；
 *  - 地图：SVG 真渲染且有地点，父级幻觉只许走可见降级；
 *  - 图谱：界面上的关系数**不许超过厂商自己回的那份**。"节点与边都 >0"看着像判据，其实
 *    `graph-agent.ts:103-105` 在模型不回关系时会自己补一条 nodes[i]→nodes[i+1] 的「关联」链，
 *    于是那条几乎恒真——判据必须去看回包，否则钉住的是产品兜底而不是模型行为。
 */
import { test, expect, type Page } from "@playwright/test";
import { panel } from "../pages/panel";
import { openSummaryPanel, addProvider, openSettings, leaveSettings } from "../pages/settings";
import { importFiles, longNovel, navChapter, openBook, shelfCard, txtFile } from "../pages/shelf";
import { RUN, realNovel, signIn, vendorReach } from "./fixtures";
import { loadVendors, tryVendorKey, vendorTag, wireText, type VendorSpec } from "./vendors";

/**
 * 这一组跑哪一家厂商。
 *
 * 三个形状要分清：
 *  - `ANR_VENDOR_ID=<id>` 指定一家 → 就它（**空串算没指定**：启动脚本里 `export ANR_VENDOR_ID=`
 *    这种写法很常见，把它当成"指定了一家不存在的"会让整组莫名其妙不进）；
 *    指定了清单里没有的 id 直接抛（打错一个字就会
 *    "整组没跑而报告看着像跑过"，这一档每条都花钱，不能留这种格子）；
 *  - 没指定 → 清单里第一家 keyFile 有货的；
 *  - 一家都没 key（或压根没给清单）→ `v:null` + 一句点名缺什么的跳过原因。
 *
 * 写死厂商一是这一组最初的形状，代价是"只有 sensenova 一把 key"的时候这一组整组静默跳过——
 * 全书总览/地图/图谱这三条最贵的路径于是永远只被一家厂商量过。key 值仍然只在 `keyFile` 里活着。
 */
function pickVendor(): { v: VendorSpec | null; key: string; missing: string } {
  const all = loadVendors();
  const withKeys = all.map((v) => ({ v, ...tryVendorKey(v) }));
  const want = (process.env.ANR_VENDOR_ID ?? "").trim();
  if (want !== "") {
    const hit = withKeys.find((e) => e.v.id === want);
    if (!hit) {
      throw new Error(`ANR_VENDOR_ID="${want}" 不在厂商清单里；可选：${all.map((e) => e.id).join(" / ") || "（清单是空的）"}`);
    }
    return { v: hit.key !== "" ? hit.v : null, key: hit.key, missing: hit.missing ?? "" };
  }
  const ready = withKeys.find((e) => e.key !== "");
  if (ready) return { v: ready.v, key: ready.key, missing: "" };
  return {
    v: null,
    key: "",
    missing: all.length === 0
      ? "没设 ANR_VENDOR_MANIFEST，或清单里一条都没有"
      : `清单里没有任何一家配了 key：${withKeys.map((e) => `${e.v.id}（${e.missing}）`).join("；")}`,
  };
}

const PICKED = pickVendor();
const VENDOR = PICKED.v;
const key = PICKED.key;
const BASE = VENDOR?.base ?? "";
const MODEL = VENDOR?.model ?? "（没选到厂商）";
const USER = `r组批量-${RUN}`;
const BOOK = `批量长书-${RUN}`;
/**
 * 给厂商配的输出上限（`ANR_VENDOR_MAX_OUTPUT` 可覆盖）。
 *
 * 留空时产品按模型表默认 4096，而 sensenova 的 `deepseek-flash` 是推理模型：实测
 * `completion_tokens=4096 / reasoning_tokens=4096 / 正文 0 字`，地图整张图什么都拿不到。
 * 那是"预算不够"，不是"产品坏了"——按设置页那行说明给它的量配上，判据才在量产品。
 */
const MAX_OUTPUT = Number(process.env.ANR_VENDOR_MAX_OUTPUT ?? 8192);

/** 把一发厂商回包摊成纯文本（形状由 `format` 决定，见 `vendors.ts` 的 `wireText` 为什么必须 SSE 感知） */
function vendorText(body: string, contentType: string): string {
  if (!VENDOR) throw new Error("没选到厂商却想解回包");
  return wireText(VENDOR, body, contentType);
}

// 不用 `.serial`：三条各自有 `beforeEach`（各自一份 context），串起来只会让第一条红了
// 把后面两条一起吞掉（实测报 `did not run`），变异验收时看不全
test.describe(`真后端：批量生成三条打在真厂商上（${VENDOR ? vendorTag(VENDOR) : "没选到厂商"}）`, () => {
  test.skip(VENDOR === null || key === "", PICKED.missing);

  // 与 r-vendor.spec.ts 同一套分类：厂商"不在"（连不出去/5xx）跳过并写明原因，
  // 4xx 照红——key 失效与"发出去的整本书没回内容"都是这一条要报的。
  test.beforeAll(async () => {
    // 走到这里 describe 级的 skip 已经把"没选到厂商"挡掉了；真到这儿就是 skip 逻辑坏了
    if (!VENDOR) throw new Error(`没选到厂商却进了预探：${PICKED.missing}`);
    const r = await vendorReach(VENDOR, key);
    if (r.reachable) return;
    console.log(`[R-E 批量] 预探：${r.why} → ${r.skip ? "跳过这一组" : "不跳过，让判据红"}`);
    test.skip(r.skip, `预探：${r.why}`);
  });

  /** 每个用例一份，在 `beforeEach` 导航之前装好（见 `watchWire` 为什么要进页面里读） */
  let V: Replies;

  /** 三条都要同一份前置：配好厂商 + 一本 40 章长书 + 面板展开到「全书分析」 */
  test.beforeEach(async ({ page, baseURL }) => {
    test.setTimeout(12 * 60_000);
    // 下面那行 `u.href.startsWith(BASE)` 在没选到厂商时会等于"拦掉一切请求"，所以先挡住
    if (!VENDOR) throw new Error(`没选到厂商却进了前置：${PICKED.missing}`);
    // 抓包必须在**任何导航之前**装好（init script 只作用于之后的页面加载），所以放在 signIn 前面
    V = await watchWire(page);
    /**
     * 别把那条注定失败的直连真发到厂商。
     *
     * sensenova 不响应 `OPTIONS`，浏览器直连必然拿不到响应——可请求是真的发出去了，
     * 于是每一发逻辑调用在厂商那边记成两发，而它的配额是按分钟算的（实测 429
     * `RateLimitExceeded.EndpointTPMExceeded`）。这一层只在这组里拦：R-E1/E2/E4 那组
     * 判的正是"浏览器真的试过直连"，那边不能拦。
     */
    await page.route((u) => u.href.startsWith(BASE), (route) => route.abort());
    await signIn(page, baseURL!, USER);
    await openSettings(page);
    await addProvider(page, {
      name: `R-E 批量-${RUN}`, key, baseUrl: BASE, model: MODEL, maxTokens: MAX_OUTPUT, format: VENDOR.format,
    });
    const trigger = page.locator("#active-provider");
    if (!(await trigger.innerText()).includes(`R-E 批量-${RUN}`)) {
      await trigger.click();
      await page.getByRole("option").filter({ hasText: `R-E 批量-${RUN}` }).click();
    }
    await leaveSettings(page);
    await importFiles(page, [txtFile(`${BOOK}.txt`, longNovel(40))]);
    await expect(shelfCard(page, BOOK)).toBeVisible({ timeout: 30_000 });
    await openBook(page, BOOK);
    await openSummaryPanel(page);
    await panel.tab(page, "全书分析").click();
    // 用例之间的冷却：八条连着打同一只 key，配额窗口还没滑过去就会整组红在 429 上
    const cooldown = Number(process.env.ANR_VENDOR_COOLDOWN_MS ?? 45_000);
    if (cooldown > 0) {
      console.log(`[R-E 批量] 冷却 ${cooldown / 1000} 秒再打厂商（配额按分钟算）`);
      await page.waitForTimeout(cooldown);
    }
  });

  /**
   * 一次点击之后的两条通用底线：不许静默无事发生、配额没放行不许算产品坏了。
   *
   * 配额这件事只看**线上回的那份**，不看面板上还有没有那行红字：一次 429 之后界面会把
   * 「频率过高」一直挂着（`callVendor` 退避重发的下一发已经成功了），拿面板文案判配额
   * 会把已经跑通的 R-E7/R-E8 整条跳掉——实测跳过 2 条就是这么来的。
   */
  async function expectNoFailure(page: Page, v: Replies) {
    const lastRaw = v.raw[v.raw.length - 1] ?? "";
    if (THROTTLED.test(lastRaw)) {
      test.skip(true, `厂商配额没放行（最后一发回的是：${lastRaw.slice(0, 160)}）：这一档测不了，与产品无关`);
    }
    await expect(panel.text(page, /生成失败|总结生成失败|无法生成|解析失败|上下文不足/)).toHaveCount(0);
  }

  test("R-E5 全书总览：发出去的是全书信息，回来的是一段真分析", async ({ page }) => {
    // 判据钉在**发出去的 prompt** 上，不是钉在模型的自由文本上：
    // "总览里必须原样出现某一句"是拿生成式模型当断言对象，它换个说法就红，红了也不是产品的错
    // （第一版就栽在这里）。
    //
    // 只钉"发出去的是全书目录"这一条，第二版又红了一次：它要求 prompt 里必有
    // `【第N章…】开头:` 样本块，而这本 40 章的书签了语义检索（`preRetrieve` 真拿到正文段落，
    // `summarizer.ts:172` 于是拿预检索替代样本），产品是对的、判据是错的。现在按**标签↔内容同源**
    // 来钉：两条内容来源哪条都行，但顶着哪条的标签就得真有哪条的内容。
    // 样本分支的首/中/尾覆盖已由 `summarizer-global.test.ts` 在单元层钉死（那层量得到）。
    const prompts: string[] = [];
    page.on("request", (r) => {
      if (!r.url().startsWith(BASE) && !r.url().includes("/api/proxy/")) return;
      try {
        const body = r.postDataJSON() as Record<string, unknown> | null;
        const msgs = (body?.messages ?? (body?.body as { messages?: unknown } | undefined)?.messages) as
          | { role?: string; content?: string }[]
          | undefined;
        prompts.push((msgs ?? []).filter((m) => m.role === "user").map((m) => m.content ?? "").join("\n") || JSON.stringify(body ?? {}));
      } catch {
        prompts.push(r.postData() ?? "");
      }
    });
    const v = collectReplies();

    await callVendor(page, v, () => panel.button(page, "生成全书总览").click(), "全书总览");
    await expect(panel.button(page, /^全书总览$/)).toBeVisible({ timeout: 5 * 60_000 });
    await expectNoFailure(page, v);
    await panel.button(page, /^全书总览$/).click();

    const blob = prompts.join("\n\n=== 一封请求 ===\n\n");
    // 按标签把 prompt 切成一节一节：两条判据各看各的那一节，不拿全文糊在一起。
    // 第一版就是拿整份 prompt 数章号，"目录被截成只剩开头"这件事要靠检索段落里没混进
    // 章号才看得出来——而它确实会混进来，那样 ① 就是条假判据。
    const sectionAfter = (label: string) => {
      const at = blob.indexOf(label);
      if (at < 0) return null;
      // 只剥标签自己的尾巴（`：**` 或 `（节选）：**`），剩下的才是正文。两处都是踩出来的：
      // 用 `\s*` 会一路吞过空行滑进下一节「**分析要求：**」（变异把正文整段清空时，长度判据
      // 就是这么被喂绿的）；而 `（节选）?` 的全角括号不是分组，`?` 只管到最后一个字，得写 `(?:…)?`。
      const rest = blob.slice(at + label.length).replace(/^[ \t]*(?:（节选）)?：\*\*[ \t]*/, "");
      return rest.split(/\n\n\*\*|\n\n请基于/)[0].trim();
    };

    // ① 目录那一节（`chapterList`）自己必须覆盖到首/中/尾——上千章的书会在这一步被悄悄截成开头
    const tocSection = sectionAfter("**完整章节目录：**") ?? sectionAfter("章节目录：") ?? "";
    const inToc = new Set([...tocSection.matchAll(/第(\d+)章 渡口\1/g)].map((m) => Number(m[1])));
    expect(
      [...inToc].some((n) => n <= 5) && [...inToc].some((n) => n >= 15 && n <= 25) && [...inToc].some((n) => n >= 36),
      `目录那一节没覆盖到首/中/尾三段（认出的章号：${[...inToc].sort((a, b) => a - b).join(",")}）`,
    ).toBe(true);

    // ② 正文来源：两条路径只能有一条，且标签说的是什么就得真是什么
    const sampleLabel = "**内容样本（开头几章+中间+结尾的片段）：**";
    const sampleSection = sectionAfter(sampleLabel);
    const retrievedSection = sectionAfter("**语义检索相关段落");
    if (sampleSection !== null) {
      expect(retrievedSection, "标签同时写了「内容样本」和「语义检索相关段落」，两条来源只能有一条").toBeNull();
      const blocks = [...sampleSection.matchAll(/【第(\d+)章 渡口\1】开头:\n([^\n]*)/g)];
      expect(blocks.length, "顶着「内容样本」的标签，块数却是 0——模型只会看见目录").toBeGreaterThanOrEqual(2);
      for (const b of blocks) expect(b[2].length, `第${b[1]}章的样本块只有标题没有正文`).toBeGreaterThan(50);
    } else {
      expect(retrievedSection, `prompt 里既没有内容样本也没有检索段落：模型只见目录没见过正文（纯目录幻觉）\n${blob.slice(0, 400)}`).not.toBeNull();
      expect(retrievedSection!.length, "语义检索段落不足 100 字，不该被当成全书正文来源").toBeGreaterThanOrEqual(100);
      // 检索回来的得真是这本书的正文（`longNovel` 的句子），不是又一段目录
      expect(retrievedSection, "「语义检索相关段落」里没有本书正文的句子（缆桩/麻绳/篷布），像是把目录当成了检索结果").toMatch(/缆桩|麻绳|篷布/);
    }

    const body = await panel.root(page).innerText();
    expect(body.length, "面板没有可读的分析正文").toBeGreaterThan(200);
    console.log(
      `[R-E5] 全书总览：厂商 ${prompts.length} 发，目录 ${inToc.size} 个章号，正文来源=${sampleSection !== null ? `内容样本 ${(sampleSection.match(/【第\d+章 渡口\d+】开头/g) ?? []).length} 块` : `语义检索 ${retrievedSection!.length} 字`}，面板正文 ${body.length} 字`,
    );
  });

  test("R-E6 小说地图：40 章目录换来一张真图，父级幻觉只许可见降级", async ({ page }) => {
    const v = collectReplies();
    await callVendor(page, v, () => panel.button(page, "生成小说地图").click(), "小说地图");
    // 锚死整名：`/小说地图/` 会同时认上「生成小说地图」那枚按钮（`NovelMapSection.tsx:337/352`），
    // 于是"折叠头出现了"变成一句空话，而下面那次 `header.click()` 实际又发起了一整发真请求
    const header = panel.button(page, /^小说地图$/);
    await expect(header).toBeVisible({ timeout: 5 * 60_000 });
    // 「小说地图」这枚折叠头在**生成过程中是 disabled 的**（实测直接点会卡在 actionTimeout 的
    // 60 秒上，报出来像"按钮点不动"的产品缺陷，其实是模型还在写），所以先等它放开
    await expect(header).toBeEnabled({ timeout: 5 * 60_000 });
    await expectNoFailure(page, v);
    await header.click();

    // 数量读界面自己写的那行（`NovelMapSection.tsx:397` 的「N 个层级 · M 个地点 · K 个势力」），
    // 不去数 svg 元素：面板里 lucide 图标也是 `<svg><path>`，第一版拿 `svg circle, svg text`
    // 计数读出过"152 个地点"这种荒唐数字——图标全算进去了。
    const caption = panel.text(page, /\d+ 个层级 · \d+ 个地点 · \d+ 个势力/).first();
    await expect(caption).toBeVisible({ timeout: 30_000 });
    const [, layers, places, forces] = (await caption.innerText()).match(/(\d+) 个层级 · (\d+) 个地点 · (\d+) 个势力/) ?? [];
    expect(Number(places), `地图只给出 ${places} 个地点：40 章的书不可能只有这一点地理`).toBeGreaterThanOrEqual(3);
    expect(Number(layers), `地图只有 ${layers} 个层级`).toBeGreaterThanOrEqual(1);
    // 势力**不断言**：`longNovel` 那本合成长书里根本没有阵营，模型回 0 个势力才是对的
    // （第一版钉了 ≥1，红在"0 个势力"上——那是 fixture 的事实，不是产品的缺陷）
    // 真渲染出来的图：地点是圆点（`renderMap.ts:287`），至少要有一枚
    await expect(panel.root(page).locator("svg circle").first()).toBeVisible();

    const body = await panel.root(page).innerText();
    // 幻觉允许，但必须说出来：`parentMissing` 走的是可见降级那一条（批次 I 的口径）
    if (/上级没找到/.test(body)) {
      console.log(`[R-E6] 模型编的上级有对不上的，界面按可见降级处理：${body.match(/\d+ 个地点的上级没找到[^\n]*/)?.[0] ?? ""}`);
    }
    expect(body, "地图整图失败（连一句降级提示都没有）").not.toMatch(/整图失败|生成失败/);
    console.log(`[R-E6] 地图：${layers} 个层级 / ${places} 个地点 / ${forces} 个势力，面板正文 ${body.length} 字`);
  });

  test("R-E7 人物关系图谱：模型真回关系，界面也不许把兜底链冒充成模型的关系", async ({ page }) => {
    // 厂商回包也收下来：`graph-agent.ts:103-105` 在"模型一条关系都没回（或全部引用无效节点）"时
    // 会自动补一条 nodes[i]→nodes[i+1] 的「关联」链。所以界面上"关系 ≥1"**几乎恒真**，
    // 单看它等于什么都没钉住——这条判据必须同时看模型自己回了多少条。
    const responses: string[] = [];
    page.on("response", (res) => {
      if (!res.url().startsWith(BASE) && !res.url().includes("/api/proxy/")) return;
      // 只要元信息（状态码与类型）：正文一律走 `watchWire` 那份页面内抓包
      responses.push(`${res.status()} ${res.headers()["content-type"] ?? "?"}`);
    });

    const v = collectReplies();
    await callVendor(page, v, () => panel.button(page, "生成人物关系图谱").click(), "人物关系图谱");
    const header = panel.button(page, /人物关系分析图/);
    await expect(header).toBeVisible({ timeout: 5 * 60_000 });
    await expect(header).toBeEnabled({ timeout: 5 * 60_000 });   // 生成中折叠头是禁用的
    await expectNoFailure(page, v);
    await header.click();

    // 同 R-E6：读界面自己写的那行数量。内联视图里是 `CharacterGraphSection.tsx:88` 的
    // 「N 个角色 · M 条关系」；`CharacterGraph.tsx:342` 那行「N 人 · M 条关系」只在**全屏**
    // 视图里渲染，第一版照它写定位器，结果一条都找不到。
    const caption = panel.text(page, /\d+ 个角色 · \d+ 条关系/).first();
    await expect(caption).toBeVisible({ timeout: 30_000 });
    const [, nodes, edges] = (await caption.innerText()).match(/(\d+) 个角色 · (\d+) 条关系/) ?? [];
    // 数 `"source":` 而不是解析 JSON：模型爱在 JSON 外面裹 ```json 围栏，
    // 而产品自己那份 `extractJSON` 的容错形状不该被测试复刻一遍当判据
    const modelEdgeCounts = v.texts.map((t) => (t.match(/"source"\s*:/g) ?? []).length);
    // 重试会有多份回包，图谱最终只来自其中一次 → 取最大的那份，不累加
    const modelEdges = modelEdgeCounts.length ? Math.max(...modelEdgeCounts) : -1;
    expect(nodes, "图谱的计数行没读出来").toBeTruthy();
    expect(Number(nodes), `图谱只有 ${nodes} 个人物`).toBeGreaterThanOrEqual(2);
    expect(Number(edges), `图谱有 ${nodes} 个人物却回了 ${edges} 条关系：连线全被当幻觉滤掉了`).toBeGreaterThanOrEqual(1);
    // ① 真模型得真的回过关系——否则下面那 12 条线是产品补的兜底链，用户会当成模型分析出来的
    expect(modelEdges, `厂商一次都没回关系（界面上那些「关联」线全是 \`autoGenerateEdges\` 兜底链）｜命中响应 ${responses.length} 份：${responses.join("; ") || "一份都没捞到"}，可解析回包 ${modelEdgeCounts.length} 份`).toBeGreaterThanOrEqual(1);
    // ② 界面展示的关系数不许超过模型回的数量：多出来说明兜底链被叠加到了真关系上
    expect(
      Number(edges),
      `界面显示 ${edges} 条关系，比模型回的 ${modelEdges} 条还多：多出来的是产品自己补的「关联」链，界面上看不出来`,
    ).toBeLessThanOrEqual(modelEdges);
    await expect(panel.root(page).locator("svg line").first()).toBeVisible();
    console.log(`[R-E7] 图谱：${nodes} 人 / 界面 ${edges} 条关系（模型自己回了 ${modelEdges} 条，回包 ${modelEdgeCounts.length} 份）`);
  });

  /**
   * 文字型产物（人物分析 / 时间线 / 范围总结 / 问答）共用的两条底线判据。
   *
   * 为什么不能只断言"面板有字"：产品自己会写「暂无总结，点击上方按钮生成」「正在检索相关内容」
   * 这类占位与状态文案，模型一次都没回正文时界面照样有字。所以两条一起钉：
   *  ① 厂商确实回过一段可比对的正文（去掉 SSE 帧壳与 Markdown 符号后 ≥20 字）；
   *  ② 从厂商回包里取三段等距窗口，只要有一段原样出现在界面上就算上屏。
   *
   * 两条都是量出来的：
   *  - 第 ② 条以前是"找一段连续汉字，够长就算"，那个长度是硬伤——中文回包里逗号、顿号、
   *    Markdown 会把汉字切成短段（实测最长一跑分别只有 14 与 11 字），钉 12 就红在判据自己身上。
   *    换成"任意一段定长窗口"后与标点密度无关，而产品的占位话凑不出 20 字。
   *  - 第 ① 条原本钉 80 字"回够正文"，但这条路径的预算会被厂商截断到 60 字（实测
   *    `范围总结 completion_tokens=2048 / reasoning_tokens=2009`）——**截断是厂商的事，
   *    上屏才是产品的事**，所以地板降到"够切一段窗口"的 20 字；连 20 字都不够时不画红，
   *    按"这一档测不了"跳过（`skipIfVendorGaveNoBody` 管的是另一个形状：正文一个字都没有）。
   */
  async function expectModelWordsShown(page: Page, replies: string[], label: string): Promise<void> {
    const squash = (s: string) => s.replace(/[\s*_`>#~]/g, "");
    const wire = squash(replies.slice().sort((a, b) => b.length - a.length)[0] ?? "");
    if (wire.length < 20) {
      // 回了几个字就被预算截断（实测 R-E8 一回只给「## 受限人物」）：界面上是真有字的，
      // 只是短到切不出一段不误撞占位话的窗口。那是"这一档测不了"，不是产品坏了。
      console.log(`[R-E 截断] ${label}：厂商去壳后只回 ${wire.length} 字（${replies.length} 份回包），切不出一段可比对窗口`);
      test.skip(true, `${label}：厂商回的正文短到 ${wire.length} 字就被截断，判不了"上屏"这半条`);
      return;
    }
    const win = Math.min(20, Math.floor(wire.length / 3));
    const windows = [0, Math.floor(wire.length / 3), Math.floor((wire.length * 2) / 3)]
      .map((i) => wire.slice(i, i + win))
      .filter((w) => w.length === win);
    const body = squash(await panel.root(page).innerText());
    expect(
      windows.some((w) => body.includes(w)),
      `${label}：界面上找不到厂商回包里的任何一段原话（试过 ${windows.map((w) => `「${w.slice(0, 8)}…」`).join(" ")}）`,
    ).toBe(true);
  }

  /**
   * 厂商配额压力的形状。实测这一家有两种：SSE 流里直接夹着限流正文（状态码 200），
   * 以及 `server/routes/proxy.js:165` 原样带上游状态码的 `429 + {error, details}`。
   * 所以判"是不是配额"只看**响应正文里的关键词**，不依赖状态码。
   */
  const THROTTLED = /(频率过高|Too Many Requests|rate_limit_error|RateLimitExceeded)/i;
  type Replies = { texts: string[]; raw: string[]; settle: () => Promise<void> };

  /**
   * 抓厂商回包在页面里做，不在测试侧做。
   *
   * 起因是一次实测到的假红：代理透传 SSE 当时只写 `Content-Type: text/event-stream`（不带
   * charset），Chromium 会先按 windows-1252 解一遍再把体交给测试——`res.text()` 与 `res.body()`
   * **两条都坏**（同一份正文：页面内 fetch 读到 75 字正常中文，测试侧 101 字 `å°±æ‰€ç»™åŽŸæ–‡`），
   * 于是"模型原话上屏"在乱码上永远找不到可比对片段，而界面显示的中文一直是好的。
   * 服务端那两处现在已经补上 `charset=utf-8`（`0542568`，补完复测两条读法都正确），
   * 页面内这份抓包仍然保留，理由换成正面的：它读的是**产品真正吃进去的那一份字节**
   * （hook `window.fetch` 后 `clone()`），而不是测试另开一条读法；对着不带 charset 的
   * 旧后端或别家厂商也不会再被解码方式骗一次。
   */
  async function watchWire(page: Page): Promise<Replies> {
    const texts: string[] = [];
    const raw: string[] = [];
    await page.exposeBinding("__anrWire", (_source, f: { text: string; ct: string }) => {
      raw.push(f.text);
      const c = vendorText(f.text, f.ct);
      if (c.trim()) texts.push(c);
    });
    await page.addInitScript(({ base }) => {
      const orig = window.fetch.bind(window);
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await (orig as typeof fetch)(input, init);
        try {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const ct = res.headers.get("content-type") ?? "";
          const mine = url.includes("/api/proxy/") || url.startsWith(base);
          if (mine && (ct.includes("event-stream") || ct.includes("json"))) {
            void res.clone().text().then((t) => {
              (window as unknown as { __anrWire(f: { text: string; ct: string }): void }).__anrWire({ text: t, ct });
            }).catch(() => {});
          }
        } catch {
          // 抓包这一步出任何问题都不许影响真请求
        }
        return res;
      }) as typeof fetch;
    }, { base: BASE });
    // 页面内那一读是"流读完才回调"，所以 raw 增长本身就等价于旧版 `settle()` 等 body 读完
    return { texts, raw, settle: async () => {} };
  }

  /** 取本用例那份回包（在 `beforeEach` 里已经装好，这里只是给用例一个短名字） */
  function collectReplies(): Replies {
    return V;
  }

  /**
   * 厂商**一个字正文都没回**时的两条。
   *
   * 推理模型（实测 `deepseek-flash`）会把任务级输出预算全花在思考上：时间线那一发
   * `completion_tokens=4096 / reasoning_tokens=4096 / 正文 0 字 / finish_reason=length`。
   * 这时候"模型原话有没有上屏"没有可判的东西，但有一件事必须判：**界面得把这句话说出来**。
   * 所以先钉产品该做对的那半（不许静默吞掉空正文，实测面板确实报
   * 「API 返回了空结果（流式响应无内容）」），再跳过后半截。
   *
   * 只在"完全没有正文"时触发：回了几个字又被截断的那种，界面上是真有字的，
   * 那是可比对长度不够（见 `expectModelWordsShown` 的 skip），不该拿"界面没说话"红它。
   *
   * **先等任务落定，再判界面说没说**（2026-09-27 实测到的中间态）：第一发回空正文时，
   * `map-agent.ts:138` / `graph-agent.ts:71` 会**自愈重发**，面板此刻挂的是
   * 「AI 正在执行：AI 正在重新分析......」。拿那一刻判"界面一个字都没说"是把自愈读成静默——
   * 那一跑的红就是这个形状（`sensenova-6.8-flash-lite` 在 8192 上地图那发 `reasoning=8192 / 正文 0 字`）。
   * 等到面板不再有「正在」为止：重发带回正文就交回各条主判据，仍然一个字都没有才轮到这条。
   */
  async function skipIfVendorGaveNoBody(page: Page, v: Replies, label: string): Promise<void> {
    if (v.texts.some((t) => t.trim())) return;
    await expect
      .poll(async () => (await panel.root(page).innerText()).includes("正在"), {
        timeout: 4 * 60_000,
        message: `${label}：自愈重发一直没落定（面板还挂着「正在…」）`,
      })
      .toBe(false);
    if (v.texts.some((t) => t.trim())) return;
    const lastRaw = v.raw[v.raw.length - 1] ?? "";
    if (THROTTLED.test(lastRaw)) {
      test.skip(true, `${label}：重发撞上配额（最后一发回的是：${lastRaw.slice(0, 160)}）：这一条测不了，与产品无关`);
    }
    const think = lastRaw.match(/"reasoning_tokens"\s*:\s*(\d+)/)?.[1] ?? "?";
    const finish = lastRaw.match(/"finish_reason"\s*:\s*"?([a-z_]+)"?/g)?.slice(-1)[0] ?? "没有 finish_reason";
    const said = await panel.root(page).innerText();
    expect(said, `${label}：厂商回的是空正文（${finish}、思考 ${think} token 把预算吃满），界面却一个字都没说`
      ).toMatch(/空结果|API 返回|失败/);
    test.skip(true, `${label}：厂商在这条路径的输出上限内只思考不吐字（${finish}、reasoning=${think}），界面已如实报错 → 后半截"模型原话上屏"没有可判的东西`);
  }

  /**
   * 点一发厂商、等回包；撞上配额就退避重点。
   *
   * sensenova 的限额按分钟（实测 `RateLimitExceeded.EndpointTPMExceeded`），硬连着点只会
   * 让整组红在"厂商没回内容"上——那报的不是产品的毛病。退到第 5 次仍不放行就整条跳过，
   * 并把原因写清楚：**这一档测不了**，不是产品坏了。
   */
  async function callVendor(page: Page, v: Replies, trigger: () => Promise<void>, label: string): Promise<void> {
    const backoff = Number(process.env.ANR_VENDOR_BACKOFF_MS ?? 90_000);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const before = v.raw.length;
      await trigger();
      await expect
        .poll(() => v.raw.length, { timeout: 4 * 60_000, message: `${label}：点了没等到厂商响应` })
        .toBeGreaterThan(before);
      await v.settle();
      const lastRaw = v.raw[v.raw.length - 1] ?? "";
      if (!THROTTLED.test(lastRaw)) {
        const finish = [...lastRaw.matchAll(/"finish_reason"\s*:\s*"?([a-z_]+)"?/g)].map((m) => m[1]).join(",") || "?";
        console.log(
          `[R-E 回包] ${label}：${v.raw.length} 份响应、正文合计 ${v.texts.reduce((n, s) => n + s.length, 0)} 字、finish_reason=${finish}\n` +
            `  正文前 200 字：${(v.texts[v.texts.length - 1] ?? "（空）").slice(0, 200).replace(/\s+/g, " ")}\n` +
            `  原始帧尾巴 200 字：${lastRaw.slice(-200).replace(/\s+/g, " ")}`,
        );
        await skipIfVendorGaveNoBody(page, v, label);
        return;
      }
      if (attempt === 5) test.skip(true, `厂商配额连续 ${attempt} 次 429 没放行（每次退避 ${backoff / 1000} 秒）：这一档测不了，与产品无关`);
      console.log(`[R-E 限流] ${label} 第 ${attempt} 次撞上 429，退避 ${backoff / 1000} 秒后重点`);
      await page.waitForTimeout(backoff);
    }
  }

  /**
   * 打开一个文字型子项并等它写完。
   *
   * 顺序很要紧：先等厂商回包、把回包摊出来，再等界面换态。反过来写的话，"点了没反应"
   * 只会留下一条超时 5 分钟的 `toBeVisible`，看不出是模型没回、回了空的、
   * 还是产品把一份好回包丢掉了（2026-09-23 R-E8 就是这么红的）。
   */
  async function generateAndWait(page: Page, v: Replies, emptyLabel: string, header: RegExp): Promise<void> {
    await callVendor(page, v, () => panel.button(page, emptyLabel).click(), emptyLabel);
    const head = panel.button(page, header);
    // 这一条超时了先看上一行 `[R-E 回包]`：厂商有回包而界面没换到结果态，才是产品的问题
    await expect(head).toBeVisible({ timeout: 60_000 });
    await expect(head).toBeEnabled({ timeout: 60_000 });
    await expectNoFailure(page, v);
    await head.click();
  }

  test("R-E8 全书人物关系（文字分析）：模型回的人物分析真的上屏", async ({ page }) => {
    const v = collectReplies();
    await generateAndWait(page, v, "生成人物关系分析", /^全书人物关系$/);
    await expectModelWordsShown(page, v.texts, "人物关系分析");
    console.log(`[R-E8] 人物关系分析：厂商回包 ${v.texts.length} 份，面板 ${ (await panel.root(page).innerText()).length } 字`);
  });

  test("R-E9 剧情时间线：模型回的时间线真的上屏", async ({ page }) => {
    const v = collectReplies();
    await generateAndWait(page, v, "生成剧情时间线", /^剧情时间线$/);
    await expectModelWordsShown(page, v.texts, "剧情时间线");
    console.log(`[R-E9] 剧情时间线：厂商回包 ${v.texts.length} 份`);
  });

  test("R-E10 范围总结（第 2-5 章）：喂给模型的就是这四章，回来的话上屏", async ({ page }) => {
    // 「范围」是这条路径唯一容易被做错的事：做错了界面照样出结果、照样花钱，用户看不出差别。
    // 所以钉的是发出去的章节清单——`useSummarizer.ts:517-530` 按 `loadChapters(id, from-1, count)`
    // 取章、逐章拼成 `--- 第N章 渡口N ---`，界面上却完全不体现喂了哪几章。
    const prompts: string[] = [];
    page.on("request", (r) => {
      if (!r.url().startsWith(BASE) && !r.url().includes("/api/proxy/")) return;
      prompts.push(r.postData() ?? "");
    });
    const v = collectReplies();

    await panel.tab(page, "问答").click();
    // 「范围总结」那行是**默认展开**的（`QATab.tsx:36` `useState(true)`），再点一次等于把它收起，
    // 于是 `#range-from` 整块从 DOM 里消失——实测红在 `fill` 的 60 秒超时上，看着像控件不见了的
    // 产品缺陷，其实是判据多点了一下。这里只验它展开着，不去碰那枚开关。
    // 面板挂了两份（桌面侧栏 + 移动端整屏，后者常驻），所以任何定位都要走 `panel.*` 分域，
    // 连 `#qa-input` 这种 id 也不能拿 `page.fill` 用——那会命中两份、报 strict mode violation
    await expect(panel.root(page).locator("#range-from")).toBeVisible();
    await panel.root(page).locator("#range-from").fill("2");
    await panel.root(page).locator("#range-to").fill("5");
    await callVendor(page, v, () => panel.button(page, /^生成$/).click(), "范围总结");
    await expectNoFailure(page, v);

    const sent = prompts.join("\n");
    // 去重：撞配额时 `callVendor` 会重点，同一份范围会被记两遍
    const included = [...new Set([...sent.matchAll(/--- 第(\d+)章 渡口\1 ---/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
    expect(included, `范围总结实际喂给模型的章节是 ${included.join(",")}（要的是第 2-5 章，第 1 章和第 6 章都不该出现）`).toEqual([2, 3, 4, 5]);
    await expectModelWordsShown(page, v.texts, "范围总结");
    console.log(`[R-E10] 范围总结：喂了第 ${included.join("/")} 章、发出 ${sent.length} 字（全书 ${longNovel(40).length} 字），回包 ${v.texts.length} 份`);
  });

  test("R-E11 问答：两问各回一发，第二问的 prompt 里带着第一问", async ({ page }) => {
    // 追问要吃掉上一问是这条路径的全部要点：不带历史时，"它叫什么名字"这种第二问
    // 模型只能瞎答，而界面看不出来。所以钉的是**发出去的第二份 prompt 含第一问的原文**。
    const prompts: string[] = [];
    page.on("request", (r) => {
      if (!r.url().startsWith(BASE) && !r.url().includes("/api/proxy/")) return;
      prompts.push(r.postData() ?? "");
    });
    const v = collectReplies();
    const Q1 = "这本书的渡口主要在做什么营生？";
    const Q2 = "上一个问题里说到的地方，守渡口的人姓什么？";

    await panel.tab(page, "问答").click();
    // **填问题和点发送必须一起放进 trigger**：`useQA` 发出去就把输入框清空（`QATab.tsx:96`
    // 是受控输入），而「发送」在输入为空时是 disabled 的。实测把 fill 写在外面时，撞上限流
    // 之后的那次重试永远点在禁用的按钮上，红成"点不动"——那是判据在骗自己。
    const ask = (q: string) => async () => {
      await panel.root(page).locator("#qa-input").fill(q);
      await panel.button(page, "发送").click();
    };
    await callVendor(page, v, ask(Q1), "问答第一问");
    await expectNoFailure(page, v);

    await callVendor(page, v, ask(Q2), "问答第二问");
    expect(v.texts.length, "两问至少要两份回包").toBeGreaterThanOrEqual(2);

    const second = prompts[prompts.length - 1] ?? "";
    expect(second.includes(Q1), "第二问的 prompt 里没有第一问的原文：追问历史没被带上去").toBe(true);
    await expectModelWordsShown(page, v.texts, "问答");
    console.log(`[R-E11] 问答：${prompts.length} 发请求、${v.texts.length} 份回包，第二问带上了第一问`);
  });

  test("R-E12 逐章批量总结：每章各发一次；再点一次批量不该重烧已有章节", async ({ page }) => {
    // 批量这条路径的两个失败形状正好相反：漏章（只有第一章出了结果，用户以为全书跑完）
    // 与重烧（每次都把已有的再过一遍，钱花在用户看不见的地方）。两边各钉一条。
    const SMALL = `批量小书-${RUN}`;
    await page.getByRole("button", { name: "书架" }).first().click();
    await expect(shelfCard(page, BOOK)).toBeVisible({ timeout: 30_000 });
    await importFiles(page, [txtFile(`${SMALL}.txt`, realNovel())]);
    await expect(shelfCard(page, SMALL)).toBeVisible({ timeout: 30_000 });
    await openBook(page, SMALL);
    await openSummaryPanel(page);
    // 「批量」在**本章分析**那一页（`ChapterTab.tsx:115`），而 `beforeEach` 为了前几条已经切到
    // 「全书分析」并留着——不在这里切回去，就是 60 秒等一枚不存在的按钮
    await panel.tab(page, "本章分析").click();

    // 计数含"直连那一发"：sensenova 不响应 OPTIONS，浏览器直连必失败但请求确实发出去了
    // （见 r-vendor.spec.ts 的 legs()），所以一章可能是 2 发而不是一发——判据只钉"至少每章一发"
    let calls = 0;
    page.on("request", (r) => {
      if (r.url().startsWith(BASE) || r.url().includes("/api/proxy/")) calls++;
    });
    // 批量这一腿不经过 `callVendor`（一次点击打出三发，没有"重点一次"的余地），
    // 所以配额得靠回包体自己认：撞限流时这一条是"现在测不了"，不是产品坏了
    const v = collectReplies();

    await panel.button(page, "批量").click();
    await panel.button(page, "跳过已有总结").click();
    // 进度条里和头部各有一枚「停止」（`ChapterTab.tsx` 两处），不限一枚就是 strict mode violation
    await expect(panel.button(page, /^停止$/).first()).toBeVisible({ timeout: 30_000 });
    // 三章 = 三发（少一发就是漏章；多出来的按重试计，判据只钉"至少每章一次"）
    await expect.poll(() => calls, { timeout: 6 * 60_000, message: "批量总结等不到三发厂商请求" }).toBeGreaterThanOrEqual(3);
    await expect(panel.button(page, "批量")).toBeVisible({ timeout: 6 * 60_000 });   // 「停止」换回来 = 批量跑完
    await expectNoFailure(page, v);
    // 本章摘要的任务级预算只有 1024（`summarizer.ts:26`），推理模型光思考就能把它吃满 →
    // 三章全空时先钉"界面说没说出来"，再判这一档在这只模型上量不到后半截
    await skipIfVendorGaveNoBody(page, v, "逐章批量总结");

    // 每一章都得有自己的正文，不能三章共用一段
    for (const i of [0, 1, 2]) {
      await navChapter(page, i).click();
      await expect(panel.text(page, /暂无总结/)).toHaveCount(0);
      expect((await panel.root(page).innerText()).length, `第${i + 1}章跑完还是空的`).toBeGreaterThan(60);
    }

    // 反向：全部已有总结时再点批量，一次都不许多发
    const before = calls;
    await panel.button(page, "批量").click();
    await panel.button(page, "跳过已有总结").click();
    await page.waitForTimeout(6_000);
    expect(calls - before, `已有总结的书再点一次批量，还是打了 ${calls - before} 发厂商：跳过的意思是没跳过`).toBe(0);
    console.log(`[R-E12] 逐章批量：三章共 ${calls} 发，重跑批量再没发过`);
  });
});
