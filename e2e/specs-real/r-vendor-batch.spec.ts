/**
 * R-E5..E7：批量生成在真厂商上各跑一次（全书总览 / 地图 / 人物关系图谱）。
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
import { importFiles, longNovel, openBook, shelfCard, txtFile } from "../pages/shelf";
import { RUN, signIn } from "./fixtures";

const key = process.env.ANR_VENDOR1_KEY ?? "";
const BASE = process.env.ANR_VENDOR1_BASE ?? "https://411.cc.cd/v1";
const MODEL = process.env.ANR_VENDOR1_MODEL ?? "gpt-5.6-luna";
const USER = `r组批量-${RUN}`;
const BOOK = `批量长书-${RUN}`;

/**
 * 把一发厂商回包摊成纯文本。
 *
 * 必须是 SSE 感知的：`config.stream` 没显式关掉时 `openai.ts:20` 就带 `stream:true` 出去，
 * 这家厂商回的是 `text/event-stream`（实测 `200 text/event-stream`），照 JSON 解会一份都解不出来，
 * 于是"模型回了多少条关系"读成 0 —— 那是判据读错了，不是产品错了。代理那条腿原样转发，两边都认。
 */
function vendorText(body: string, contentType: string): string {
  if (!contentType.includes("event-stream")) {
    try {
      return (JSON.parse(body) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
    } catch {
      return "";
    }
  }
  let out = "";
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      out += (JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content ?? "";
    } catch {
      // 半帧/心跳帧解不开不是这一条判据要管的事
    }
  }
  return out;
}

// 不用 `.serial`：三条各自有 `beforeEach`（各自一份 context），串起来只会让第一条红了
// 把后面两条一起吞掉（实测报 `did not run`），变异验收时看不全
test.describe("真后端：批量生成三条打在真厂商上", () => {
  test.skip(!key, "没设 ANR_VENDOR1_KEY：这一组要真厂商，缺了就跳过（不算红）");

  /** 三条都要同一份前置：配好厂商 + 一本 40 章长书 + 面板展开到「全书分析」 */
  test.beforeEach(async ({ page, baseURL }) => {
    test.setTimeout(10 * 60_000);
    await signIn(page, baseURL!, USER);
    await openSettings(page);
    await addProvider(page, { name: `R-E 批量-${RUN}`, key, baseUrl: BASE, model: MODEL });
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
  });

  /** 一次点击之后的两条通用底线：不许失败条、不许静默无事发生 */
  async function expectNoFailure(page: Page) {
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

    await panel.button(page, "生成全书总览").click();
    await expect(panel.button(page, /^全书总览$/)).toBeVisible({ timeout: 5 * 60_000 });
    await expectNoFailure(page);
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
    await panel.button(page, "生成小说地图").click();
    const header = panel.button(page, /小说地图/);
    await expect(header).toBeVisible({ timeout: 5 * 60_000 });
    // 「小说地图」这枚折叠头在**生成过程中是 disabled 的**（实测直接点会卡在 actionTimeout 的
    // 60 秒上，报出来像"按钮点不动"的产品缺陷，其实是模型还在写），所以先等它放开
    await expect(header).toBeEnabled({ timeout: 5 * 60_000 });
    await expectNoFailure(page);
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
    const modelEdgeCounts: number[] = [];
    const responses: string[] = [];
    const pending: Promise<void>[] = [];
    page.on("response", (res) => {
      if (!res.url().startsWith(BASE) && !res.url().includes("/api/proxy/")) return;
      responses.push(`${res.status()} ${res.headers()["content-type"] ?? "?"}`);
      pending.push(
        res
          .text()
          .then((t) => {
            const content = vendorText(t, res.headers()["content-type"] ?? "");
            if (!content) return;
            // 数 `"source":` 而不是解析 JSON：模型爱在 JSON 外面裹 ```json 围栏，
            // 而产品自己那份 `extractJSON` 的容错形状不该被测试复刻一遍当判据
            modelEdgeCounts.push((content.match(/"source"\s*:/g) ?? []).length);
          })
          .catch(() => {}),
      );
    });

    await panel.button(page, "生成人物关系图谱").click();
    const header = panel.button(page, /人物关系分析图/);
    await expect(header).toBeVisible({ timeout: 5 * 60_000 });
    await expect(header).toBeEnabled({ timeout: 5 * 60_000 });   // 生成中折叠头是禁用的
    await expectNoFailure(page);
    await header.click();

    // 同 R-E6：读界面自己写的那行数量。内联视图里是 `CharacterGraphSection.tsx:88` 的
    // 「N 个角色 · M 条关系」；`CharacterGraph.tsx:342` 那行「N 人 · M 条关系」只在**全屏**
    // 视图里渲染，第一版照它写定位器，结果一条都找不到。
    const caption = panel.text(page, /\d+ 个角色 · \d+ 条关系/).first();
    await expect(caption).toBeVisible({ timeout: 30_000 });
    const [, nodes, edges] = (await caption.innerText()).match(/(\d+) 个角色 · (\d+) 条关系/) ?? [];
    await Promise.all(pending);
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
});
