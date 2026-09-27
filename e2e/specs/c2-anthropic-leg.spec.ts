import { test, expect, type Page, type Request } from "@playwright/test";
import { stubBackend, idleTtsStatus, type Backend, type StubTable } from "../fixtures/backend";
import {
  VENDOR_CHAT_PATH, VENDOR_MESSAGES_PATH, anthropicVendorTable, chatRequests, vendorBaseUrl,
  type AnthropicLegScript,
} from "../fixtures/vendor";
import { openApp, seedSession } from "../pages/app";
import { addProvider, leaveSettings, openSettings, openSummaryPanel } from "../pages/settings";
import { panel } from "../pages/panel";
import { importFiles, miniNovel, openBook, txtFile } from "../pages/shelf";

/**
 * Anthropic Messages 那条腿在浏览器层的第一批判据。
 *
 * **为什么单开一组**：这一腿以前在 `e2e/` 里 **0 命中**（假厂商端点只做了 OpenAI 格式），
 * 也就是"用户在设置里选了 Anthropic 之后到底接没接上"这件事，浏览器层从来没看过——
 * 单测把 `parseResponse` 判得再细，也判不到"选完格式之后真挂载上了另一条腿"。
 * 2026-09-27 修 anthropic 读正文那一格（只读 `content[0].text`，思考块在前会把真答案扔掉）时
 * 记下了这笔欠账，这一组就是还它。
 *
 * 演法与 C 组同一套：服务商的 baseUrl 配成同源假端点，厂商整段 SSE 一次性 fulfill。
 * 与 C 组的区别只在**形状**：头上是 `x-api-key`+`anthropic-version`、正文是 `content` 块数组
 * （思考块与正文块是两种块）、流式是 `content_block_delta`。
 *
 * ## 变异台账（2026-09-27 本机，基线 `anthropic.ts` = sha256 `9d048367…`、`registry.ts` 未改）
 * 每轮一把、跑完 `cp` + `cmp` 回基线；0 刀对照 **6 passed / 23.2 秒**。
 * - BK1 `registry.ts` 里 anthropic 那一支整个不走（`false && …`）  **6 红**（全组）
 *   ——归属记在 AN1 上：它判的就是"选完格式接的是哪条腿"，接错了后面全塌是正确行为，不是判据混了格
 * - BK2 头上少发 `anthropic-version`                       1 红：AN2
 * - BK3 `buildMessages` 里 system 那支删掉 `continue`       **0 红＝等价变异，不补判据**：
 *   system 排在最前，删了之后它被下面那句"首条必须是 user 否则丢弃前导"（R-36 那道守卫）挡掉，
 *   同一条格子有两只闸一起拦，单摘一只量不到。换成拆掉 `body.system` 那一行（BK3'）才红 AN2——
 *   **所以 AN2 里"system 不进消息序列"这一格判不住，判得住的是"system 单独成字段"**
 * - BK3' `if (systemPrompt) body.system = …` 恒不写         1 红：AN2
 * - BK4 正文退回只读首块（`blocks[0].text`）                 1 红：AN3
 *   （AN5 不跟着红：它第二发的正文本来就在首块，"读错半格"与"要不要降级"是两件事）
 * - BK5 流式把 thinking 也累加进正文                        1 红：AN4（界面上真的多出一段草稿）
 * - BK6 请求级 thinking 不读（`config.thinking === false`）   1 红：AN5，35.7 秒——第二发永远不带
 *   `disabled`，剧本就一直只回思考块，图谱做不出来
 * - BK7 非流式那句不喂证据（`emptyResultNote(undefined)`）    1 红：AN6（界面退回那三种猜测）
 *
 * 三条一开始就按设计"绿着"的护栏各有自己的刀：AN1 的 BK1、AN5 的 BK6、AN6 的 BK7。
 * 没有为 BK3 那格假造读数。
 */

const USER = "e2e-anthropic-user";
/** 必须纯 ASCII：这串原样进 `x-api-key` 头，HTTP 头只允许 ISO-8859-1（C 组同一条教训） */
const FAKE_KEY = "sk-e2e-anthropic-fake-key-0123";
const SUMMARY_TEXT = "城下的雪落了三天，守卒与船家都在等同一个没有来的人。";
const THINKING_TEXT = "先想一段不该给读者看的草稿：雪、渡口、鼓声。";

async function readyWithAnthropic(page: Page, script: AnthropicLegScript, legs?: { direct?: AnthropicLegScript; proxy?: AnthropicLegScript }): Promise<Backend> {
  const table: StubTable = { ...idleTtsStatus, ...anthropicVendorTable(script, legs) };
  const backend = await stubBackend(page, table);
  // 离线态起步：这一腿与 openai 那条一样，离线或没有 sync-token 时只走直连
  await seedSession(page, { username: USER, offline: true });
  await openApp(page);
  await openSettings(page);
  await addProvider(page, {
    name: "e2e Anthropic 假商", format: "anthropic",
    key: FAKE_KEY, baseUrl: vendorBaseUrl(page), model: "e2e-model",
  });
  await leaveSettings(page);
  await importFiles(page, [txtFile("AN 测试书.txt", miniNovel())]);
  await openBook(page, "AN 测试书");
  await openSummaryPanel(page);
  return backend;
}

const messagesSent = (backend: Backend) => chatRequests(backend, VENDOR_MESSAGES_PATH);

const GRAPH = {
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

test("AN1 选到 Anthropic 格式：打的是 `/v1/messages`，OpenAI 那条端点一发都不许多打，正文照样上屏", async ({ page }) => {
  const backend = await readyWithAnthropic(page, { content: SUMMARY_TEXT });

  await panel.button(page, "总结本章").click();
  await expect(panel.text(page, SUMMARY_TEXT)).toBeVisible({ timeout: 20_000 });

  expect(backend.count("POST", VENDOR_MESSAGES_PATH), "选了 Anthropic 格式却一发出到 /messages 都没有").toBe(1);
  expect(backend.count("POST", VENDOR_CHAT_PATH), "打到了 OpenAI 的 chat/completions＝这一腿根本没接上，界面那句成功是别的腿给的").toBe(0);
  // 换腿不许把"发哪一章的正文"也换掉：这一发的 messages 里必须是第一章那段
  expect(JSON.stringify(messagesSent(backend)[0].messages), "正文没跟着过来＝这条腿发了个空问题").toContain("洛阳城下的雪");
});

test("AN2 发出去的是 Messages 形状：system 单独一格、钥匙与版本在头上，不许串到另一条腿的头", async ({ page }) => {
  test.setTimeout(90_000);
  // 走图谱那一屏：它是这条腿上**唯一真带 system** 的常见调用（`graph-agent.ts` 的
  // "你是一个JSON数据生成器"）。本章摘要那条不发 system，拿它判这句会判到一个不存在的东西。
  const heads: Record<string, string> = {};
  const backend = await readyWithAnthropic(page, (_body, req: Request) => {
    const h = req.headers();
    heads["x-api-key"] = h["x-api-key"] ?? "";
    heads["anthropic-version"] = h["anthropic-version"] ?? "";
    heads["authorization"] = h["authorization"] ?? "";
    return { content: GRAPH };
  });

  await panel.tab(page, "全书分析").click();
  await panel.button(page, "生成人物关系图谱").click();
  await expect(panel.text(page, "3 个角色 · 2 条关系")).toBeVisible({ timeout: 30_000 });

  const [sent] = messagesSent(backend);
  expect(sent, "/messages 一次都没被打到").toBeTruthy();
  expect(sent).toMatchObject({ model: "e2e-model", stream: true });
  expect(typeof sent.max_tokens).toBe("number");
  // Messages 格式里 system 不是消息序列的一员：混进去这一发直接被厂商拒（R-36 那族形状）
  expect(typeof sent.system).toBe("string");
  expect(sent.system as string).toContain("JSON");
  expect((sent.messages as { role: string }[]).map((m) => m.role)).toEqual(["user"]);
  // 钥匙走自己的头，不带 OpenAI 那套 Bearer：串了就是发错腿
  expect(heads["x-api-key"]).toBe(FAKE_KEY);
  expect(heads["anthropic-version"]).not.toBe("");
  expect(heads["authorization"], "带着 Authorization 打 Anthropic＝这条腿串到了另一条腿上").toBe("");
});

test("AN3 思考块排在正文前面：真答案必须上屏，不许被当成空壳扔掉", async ({ page }) => {
  // 非流式那一发：`content` = [thinking 块, text 块]。改动前读的是 `content[0].text`——
  // 首块没有 `text` 字段，于是那一发被判成"空结果"，界面报的是一句假话。
  const backend = await readyWithAnthropic(page, {
    nonStreaming: true, thinking: THINKING_TEXT, content: SUMMARY_TEXT,
    usage: { input: 900, output: 320 },
  });

  await panel.button(page, "总结本章").click();
  await expect(panel.text(page, SUMMARY_TEXT)).toBeVisible({ timeout: 20_000 });
  // 草稿不许跟着上来
  await expect(panel.text(page, THINKING_TEXT)).toHaveCount(0);
  expect(messagesSent(backend)).toHaveLength(1);
});

test("AN4 流式：thinking 帧与 text 帧混着来时只把 text 上屏", async ({ page }) => {
  await readyWithAnthropic(page, { thinking: THINKING_TEXT, content: SUMMARY_TEXT, usage: { input: 900, output: 320 } });

  await panel.button(page, "总结本章").click();
  await expect(panel.text(page, SUMMARY_TEXT)).toBeVisible({ timeout: 20_000 });
  await expect(panel.text(page, THINKING_TEXT)).toHaveCount(0);
});

test("AN5 一整发只想不答：第二发真的带上 `thinking:disabled`，最后把结果做出来（图谱那条降级链在这条腿上接得上）", async ({ page }) => {
  test.setTimeout(90_000); // 两发 + 面板展开
  // 剧本按请求体分流：**没带 thinking 字段那一发只回思考块**（正文一个字都没有），
  // 带了 `thinking:{type:"disabled"}` 的那一发才给 JSON。产品不关思考重发就永远停在第一发。
  const backend = await readyWithAnthropic(page, (body) =>
    body?.thinking === undefined
      ? { nonStreaming: true, thinking: THINKING_TEXT, content: "", usage: { input: 900, output: 3072 } }
      : { nonStreaming: true, content: GRAPH, usage: { input: 900, output: 400 } },
  );

  await panel.tab(page, "全书分析").click();
  await panel.button(page, "生成人物关系图谱").click();
  await expect(panel.text(page, "3 个角色 · 2 条关系")).toBeVisible({ timeout: 30_000 });

  const sent = messagesSent(backend);
  expect(sent.length, "只发了一发＝那句『空正文才关思考重发』在这条腿上没触发").toBe(2);
  expect(sent[0].thinking, "第一发不许预先关掉思考（质量优先）").toBeUndefined();
  expect(sent[1].thinking).toEqual({ type: "disabled" });
});

test("AN6 两发都只回思考：界面上说的是那句『花在思考上』，不是那三种猜测", async ({ page }) => {
  const backend = await readyWithAnthropic(page, {
    nonStreaming: true, thinking: THINKING_TEXT, content: "", usage: { input: 900, output: 3072 },
  });

  await panel.button(page, "总结本章").click();
  await expect(panel.text(page, /花在思考上/)).toBeVisible({ timeout: 20_000 });
  // 反面对照：这句一出现，那三种猜测就不许同时出现（名对、钥对、参数对，说它等于说假话）
  await expect(panel.text(page, /模型名称不存在/)).toHaveCount(0);
  expect(messagesSent(backend)).toHaveLength(1);
});
