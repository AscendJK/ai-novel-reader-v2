/**
 * AI Provider 响应解析测试
 * 重点覆盖：API 返回 200 但 choices/content 为空（空壳响应）时，必须抛错而非静默返回空内容
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOpenAIProvider } from "../providers/openai";
import { createAnthropicProvider } from "../providers/anthropic";
import type { ProviderConfig } from "../types";
import { APIError, isEmptyResultError } from "../error-handler";

const openaiConfig = {
  id: "test-openai",
  format: "openai" as const,
  name: "Test OpenAI",
  apiKey: "sk-test",
  baseUrl: "https://api.example.com/v1",
  model: "test-model",
};

const anthropicConfig = {
  id: "test-anthropic",
  format: "anthropic" as const,
  name: "Test Anthropic",
  apiKey: "sk-test",
  baseUrl: "https://api.example.com/v1",
  model: "test-model",
};

function mockFetchResponse(body: unknown, status = 200) {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

/** 捕获 fetch 请求参数，返回普通 JSON 响应（body 默认 OpenAI 格式） */
function mockFetchCapture(body?: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify(body ?? { choices: [{ message: { content: "ok" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  return calls;
}

/** 构造 OpenAI 格式的 SSE 流式响应 */
function mockOpenAIStream(chunks: { content?: string; reasoning?: string }[], usage?: unknown, finish = "stop") {
  const lines: string[] = [];
  for (const c of chunks) {
    const delta: Record<string, unknown> = {};
    if (c.reasoning) delta.reasoning_content = c.reasoning;
    if (c.content) delta.content = c.content;
    const evt: Record<string, unknown> = {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 0,
      model: "test-model",
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    if (usage) evt.usage = usage;
    lines.push(`data: ${JSON.stringify(evt)}`);
    lines.push("");
  }
  // 结束块。`finish` 默认 "stop"；被输出上限切断那一发厂商在这里给的是 "length"
  lines.push(`data: ${JSON.stringify({ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}`);
  lines.push("");
  lines.push("data: [DONE]");
  lines.push("");
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Response(lines.join("\n"), {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    })
  );
}

/** 构造 Anthropic 格式的 SSE 流式响应 */
function mockAnthropicStream(textChunks: string[], usage?: unknown) {
  const lines: string[] = [];
  lines.push(`data: ${JSON.stringify({ type: "message_start", message: { id: "msg-1", usage: { input_tokens: 100, output_tokens: 0 } } })}`);
  lines.push("");
  for (const t of textChunks) {
    lines.push(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: t } })}`);
    lines.push("");
  }
  if (usage) {
    lines.push(`data: ${JSON.stringify({ type: "message_delta", usage })}`);
    lines.push("");
  }
  lines.push(`data: ${JSON.stringify({ type: "message_stop" })}`);
  lines.push("");
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Response(lines.join("\n"), {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    })
  );
}

/** 构造 Anthropic 原始 SSE：事件自己给，好演 thinking_delta / signature_delta 这些真厂商发的东西 */
function mockAnthropicRawStream(events: unknown[]) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n`).join("");
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } })
  );
}

describe("OpenAI provider parseResponse", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
    localStorage.clear();
  });

  it("正常响应时返回 content 和 token 用量", async () => {
    mockFetchResponse({
      id: "chatcmpl-1",
      choices: [{ message: { role: "assistant", content: "这是总结" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
    const provider = createOpenAIProvider(openaiConfig);
    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(result.content).toBe("这是总结");
    expect(result.tokensUsed).toEqual({ input: 100, output: 50, total: 150 });
  });

  it("choices 为 null 时抛错（ModelScope 空壳响应场景）", async () => {
    mockFetchResponse({
      id: "",
      object: "",
      created: 0,
      model: "deepseek-ai/DeepSeek-V4-Flash-0731",
      system_fingerprint: "",
      choices: null,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    const provider = createOpenAIProvider(openaiConfig);
    await expect(provider.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({
      name: "APIError",
      apiCode: "server",
    });
  });

  it("choices 为空数组时抛错", async () => {
    mockFetchResponse({
      choices: [],
      usage: {},
    });
    const provider = createOpenAIProvider(openaiConfig);
    await expect(provider.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(APIError);
  });

  it("choices[0].message.content 缺失时抛错", async () => {
    mockFetchResponse({
      choices: [{ message: { role: "assistant" } }],
      usage: {},
    });
    const provider = createOpenAIProvider(openaiConfig);
    await expect(provider.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(APIError);
  });

  it("choices[0].message.content 不是字符串时抛错", async () => {
    mockFetchResponse({
      choices: [{ message: { role: "assistant", content: { nested: true } } }],
      usage: {},
    });
    const provider = createOpenAIProvider(openaiConfig);
    await expect(provider.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(APIError);
  });

  // ↓↓↓ 2026-09-27 补：非流式那一腿以前对"一个字都没有"是**静默返回空串**，而流式那一腿
  // （上面的"空流"）是抛错。两腿口径不一致的代价不只是界面空白——agent 的「空正文才降级重发」
  // 认的是错误前缀（`isEmptyResultError`），静默返回让那条链在这条腿上整条不起作用。

  it("非流式正文是空字符串也要抛，并且降级链认得它（锚是前缀，不是整句文案）", async () => {
    mockFetchResponse({
      choices: [{ message: { role: "assistant", content: "" } }],
      usage: { prompt_tokens: 900, completion_tokens: 8192, total_tokens: 9092 },
    });
    const provider = createOpenAIProvider(openaiConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(isEmptyResultError(err), `抛的不是"空正文"那一类，降级那一发就不会关思考：${err?.message}`).toBe(true);
  });

  it("只有空白符的正文算空（另一格：厂商回一串空格同样是没回话）", async () => {
    mockFetchResponse({
      choices: [{ message: { role: "assistant", content: "   \n " } }],
      usage: {},
    });
    const provider = createOpenAIProvider(openaiConfig);
    await expect(provider.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(APIError);
  });

  it("空字符串这一路也要说准原因：usage 里有 reasoning_tokens 就点名思考吃满", async () => {
    mockFetchResponse({
      choices: [{ message: { role: "assistant", content: "" } }],
      usage: { completion_tokens: 8192, completion_tokens_details: { reasoning_tokens: 4100 } },
    });
    const provider = createOpenAIProvider(openaiConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    // 整句一起比，别只断言"含 4100"：末尾那句原始响应里 8192/4100 都印着，单挑数字谁都糊得过去
    expect(err.message).toContain("4100 token 花在思考上");
    expect(err.message).toContain("思考");
  });

  /**
   * 这一格三条（+ 改口径的一条）的变异台账，2026-09-27 深夜实跑。
   * 基线快照两份都在台架目录，还原走 `cp`（不许 `git restore`——同批文件里带着别的未提交改动）：
   * `mut-baseline-openai.ts` sha 前缀 `1384d7369c220439`、`mut-baseline-errorhandler.ts` 前缀 `ab528880826a0317`。
   * 四刀跑完 markers 都归零、两份 sha 都回到上面这两个值、`git diff --numstat` 回到 `11/3` 与 `10/3`。
   * - N1 流式那处退回 `emptyResultNote(reasoningTokens)`（不递字数）→ 红 2：新写的流式格 + 改口径那条一字思考格。
   * - N2 非流式那处退回 `emptyResultNote(reasoning)` → 红 1：非流式那一格（证明两处都得单独递，少一处就有一处说假话）。
   * - N3 摘掉 `emptyResultNote` 里"只有字数证据"那一整支 → 红 3（三条全被推回那三种猜测）。
   * - N4 那一支误用成 token 模板（把字数当 token 报）→ 红 1：只有"不许替厂商编 token 数"那条咬住它。
   * 没有一刀 0 红。
   */
  it("流式那一腿只给 delta.reasoning_content、usage 没给 reasoning_tokens：也要说准是思考吃满", async () => {
    // 2026-09-27 modelscope（ZhipuAI/GLM-5.3-Flash，vllm 版）实测形状：
    // `982 帧 / delta.content 0 字 / reasoning_content 3002 字 / finish_reason=length`，
    // 而它的 usage 只有 prompt/completion/total，**没有 completion_tokens_details** →
    // 只看那个字段的产品会对用户说"模型名不存在/无权访问/参数不支持"这三句假话。
    mockOpenAIStream([{ reasoning: "渡口与船家的意象反复出现，".repeat(60) }]);
    const provider = createOpenAIProvider(openaiConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(isEmptyResultError(err), "还是那句「空正文」，降级链认得到").toBe(true);
    expect(err.message, `流里收到 660 字思考，报错却说那三种猜测：${err.message}`).toMatch(/字思考|花在思考上/);
    expect(err.message).not.toContain("模型名称不存在");
  });

  it("非流式那一腿同一格证据也要用上：message.reasoning_content 有字就不许猜那三种原因", async () => {
    mockFetchResponse({
      choices: [{ message: { role: "assistant", content: "", reasoning_content: "船家＝摆渡人，等船的人＝未至之约" } }],
      usage: { completion_tokens: 900 },
    });
    const provider = createOpenAIProvider(openaiConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err.message).toMatch(/字思考|花在思考上/);
    expect(err.message).not.toContain("模型名称不存在");
  });

  it("反向那一格：连思考都没回（正文与 reasoning 全空）→ 照旧只说那三种猜测，不替厂商编原因", async () => {
    mockOpenAIStream([{ content: "" }]);
    const provider = createOpenAIProvider(openaiConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err.message).toContain("模型名称不存在");
    expect(err.message).not.toMatch(/字思考|花在思考上/);
  });

  it("反向那一格：正文哪怕只有一个字也不许当空壳抛掉", async () => {
    mockFetchResponse({
      choices: [{ message: { role: "assistant", content: "好" } }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
    const provider = createOpenAIProvider(openaiConfig);
    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(result.content).toBe("好");
  });

  it("那句要说清是「哪一种空」：choices 没了 ≠ 有 choices 但正文空白", async () => {
    const provider = createOpenAIProvider(openaiConfig);
    const ask = () => provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);

    mockFetchResponse({ choices: null, usage: {} });
    expect((await ask()).message).toContain("choices 为空");

    mockFetchResponse({ choices: [{ message: { role: "assistant", content: "" } }], usage: {} });
    const blank = (await ask()).message;
    // 把"正文空白"报成"choices 为空"会把读者的排查方向整个带偏（那像是网关吞了响应）
    expect(blank, "两种空写成同一句话就没法分辨了").not.toContain("choices 为空");
    expect(blank).toContain("正文是空白");
  });

  it("响应包含 error 字段时，错误信息包含原始响应内容", async () => {
    mockFetchResponse({
      choices: null,
      error: { message: "model not found" },
    });
    const provider = createOpenAIProvider(openaiConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.message).toContain("model not found");
  });

  it("响应不是合法 JSON 时抛错", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("<html>error page</html>", { status: 200 })
    );
    const provider = createOpenAIProvider(openaiConfig);
    await expect(provider.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({
      name: "APIError",
      apiCode: "unknown",
    });
  });

  it("流式响应（SSE）时聚合 delta.content（ModelScope 场景）", async () => {
    mockOpenAIStream(
      [
        { reasoning: "思考中..." },
        { content: "你好" },
        { content: "，我是AI" },
      ],
      { prompt_tokens: 13, completion_tokens: 10, total_tokens: 23 }
    );
    const provider = createOpenAIProvider(openaiConfig);
    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    // reasoning_content 不应被聚合进最终答案
    expect(result.content).toBe("你好，我是AI");
    expect(result.tokensUsed).toEqual({ input: 13, output: 10, total: 23 });
  });

  it("流式响应跳过 reasoning_content 只聚合 content", async () => {
    mockOpenAIStream([
      { reasoning: "第一步思考" },
      { reasoning: "第二步思考" },
      { content: "最终答案" },
    ]);
    const provider = createOpenAIProvider(openaiConfig);
    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(result.content).toBe("最终答案");
  });

  it("流式响应中嵌入 error 块时抛错", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        [
          'data: {"id":"1","choices":[{"index":0,"delta":{"role":"assistant"}}]}',
          "",
          'data: {"error":{"message":"model not found"}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } }
      )
    );
    const provider = createOpenAIProvider(openaiConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.message).toContain("model not found");
  });

  it("流式响应无任何内容时抛错（空流）", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        ['data: {"id":"1","choices":[{"index":0,"delta":{"content":""}}]}', "", "data: [DONE]", ""].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } }
      )
    );
    const provider = createOpenAIProvider(openaiConfig);
    await expect(provider.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({
      name: "APIError",
      apiCode: "server",
    });
  });

  it("默认请求体包含 stream: true", async () => {
    const calls = mockFetchCapture();
    const provider = createOpenAIProvider(openaiConfig);
    await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.stream).toBe(true);
  });

  it("config.stream 为 false 时请求体包含 stream: false", async () => {
    const calls = mockFetchCapture();
    const provider = createOpenAIProvider({ ...openaiConfig, stream: false });
    await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.stream).toBe(false);
  });

  it("请求级 stream 覆盖 config 配置", async () => {
    const calls = mockFetchCapture();
    const provider = createOpenAIProvider({ ...openaiConfig, stream: true });
    await provider.chat({ messages: [{ role: "user", content: "hi" }], stream: false });
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.stream).toBe(false);
  });
});

/**
 * 空正文那句报错到底该说什么。
 *
 * 2026-09-27 真厂商实测到的形状：`sensenova-6.8-flash-lite` 在 8192 的输出预算上回
 * `completion_tokens=8192 / reasoning_tokens=8192 / 正文 0 字 / finish_reason=length`——
 * 思考与正文共用同一份预算，想满了就没字。而旧文案猜的是「模型名称不存在或无权访问、请求参数不被支持」，
 * 对这种形状是**假话**：模型名是对的、参数也是对的，用户照着去查密钥只会查不到。
 * 真原因就在同一个响应的 `usage.completion_tokens_details.reasoning_tokens` 里，我们一直只读
 * `prompt_tokens` / `completion_tokens`，那个字段白拿不读。
 *
 * 两头都要钉：**有证据才说思考吃满**（没 reasoning_tokens 或为 0 时保留原来那三种猜测，不许编），
 * 说了还得给出出口（关思考 / 调大上限），只报一个数不算把话说完。
 * 前缀「API 返回了空结果」是 agent 那侧认这种失败、进而降级重发的锚，一起钉住。
 *
 * ## 变异台账（基线 openai.ts `5a83f0c4` / 11736 B，实现之后重抓；5 刀全咬红）
 * 每轮固定读数 `markers=1 / markers_left=0 / sha 回到 5a83f0c4`，对照轮 34 条全绿。
 * - N1 门槛从 `> 0` 挪成 `>= 0`（有字段就当思考吃满）  1 红：只有「reasoning_tokens 明确为 0」那条
 * - N2 整段判断摘掉（恒说三种猜测）                  3 红：流式两条 + 非流式那条一起塌
 * - N3 只接流式那一腿（非流式恒传 undefined）        1 红：非流式那条——**两腿各有一格，单摘一条腿只红一条**
 * - N4 只报数、把出口那半句摘掉                      1 红：「说了就得给出口」那条（"含思考"那条照样绿，
 *   说明那两条判的是两件事：有没有说原因 / 有没有给出口）
 * - N5 改前缀（`API 空响应`）                        1 红：锚那条
 * 立红阶段的过程账：这七条刚写下时 **3 红 4 绿**——4 条绿的是"钉现状"那半（没证据不许编、前缀不许动），
 * 它们的牙由 N5 与 N2 证明，不是由"实现前就红"证明。
 *
 * ## 2026-09-27 重打：措辞搬进 `error-handler.ts` 之后，夹具与断言各收紧一次
 * 搬家的判据不能是"改 openai.ts 里的文案 openai 红"（那本来就同一只文件），得是**改另一只文件里
 * 的共用内核，这一档跟着红**。基线换成 openai.ts `5f0378a9`（已无本地那份 `emptyResultNote`）。
 * 先收了两处假绿的可能：
 * - 三条 `toContain("8192")` 换成整句 `toContain("4100 token 花在思考上")`——只断"含这个数字"时，
 *   报错句尾那段「原始响应：{…}」里 8192 本来就躺着，内核不报数也测不出（实测：旧断言下 G1 只红 1 条）。
 * - `REASONING_USAGE` 里 `completion_tokens` 与 `reasoning_tokens` 不再同为一个数（8192 / 4100），
 *   否则"读错字段"那一刀拿的是同一个数字，看不出来。
 * 重打的读数（每轮一把，跑完 `cp` + `cmp` 还原）：
 * - N6 内核 `${reasoningTokens}` → `${0}`            4 红：这一档 3 条 + 内核自己 1 条（`providers.test.ts`
 *   三条同红就是"这一腿真在读那一份"的证据）
 * - N7 内核整段判断废掉                              7 红：这一档 4 条 + 内核 3 条
 * - N8 内核门槛 `> 0` → `>= 0`                       2 红：与旧 N1 同格，这一档只红「明确为 0」那条
 * - N9 非流式取值换成 `usage.completion_tokens`       2 红（这一档非流式那条 + `parseResponse` 里
 *   "空字符串这一路也要说准原因"）；流式那一腿同样换错字段 → 1 红。**旧夹具（两个数一样）下这两刀都是 0 红**，
 *   也就是"读哪个字段"这一格在收紧之前根本没判住。
 */
describe("OpenAI provider 空正文的措辞：有证据才说思考吃满，说了要给出口", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
    localStorage.clear();
  });

  // 两个数字**故意不一样**：以前 reasoning_tokens 也写 8192，于是"把读取的字段换成 completion_tokens"
  // 这一刀打进去 0 红——那句里的 8192 是从哪儿来的根本分不出来。4100 只有走 reasoning_tokens 才会出现。
  const REASONING_USAGE = {
    prompt_tokens: 9900,
    completion_tokens: 8192,
    total_tokens: 18092,
    completion_tokens_details: { reasoning_tokens: 4100 },
  };

  it("流式：只有 reasoning 帧 + usage 带 reasoning_tokens → 说清是思考吃满，不再猜模型名", async () => {
    mockOpenAIStream([{ reasoning: "第一步" }, { reasoning: "第二步" }], REASONING_USAGE);
    const provider = createOpenAIProvider(openaiConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    // 整句一起比：只断言"句子里有 4100"会被末尾那段原始响应糊过去（原始响应里什么数字都有）
    expect(err.message).toContain("4100 token 花在思考上");
    expect(err.message).not.toContain("模型名称不存在");
  });

  it("那条锚不许动：前缀仍是「API 返回了空结果」（agent 靠它认这种失败才降级重发）", async () => {
    mockOpenAIStream([{ reasoning: "想" }], REASONING_USAGE);
    const provider = createOpenAIProvider(openaiConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err.message.startsWith("API 返回了空结果")).toBe(true);
  });

  it("说了思考吃满就得给出口：关思考与调大上限两条都在话里", async () => {
    mockOpenAIStream([{ reasoning: "想" }], REASONING_USAGE);
    const provider = createOpenAIProvider(openaiConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err.message).toContain("关闭思考");
    expect(err.message).toContain("上限");
  });

  it("流式：只有一字思考、usage 没给 token 明细 → 点名「回过思考」但不许编出 token 数", async () => {
    // 这条老判据编码的是"没有 token 数就猜那三种原因"，而"猜原因"正是 2026-09-27 要修的假话
    // （流里明明收到 reasoning_content）。口径改成：**见到过思考就说见过（按字数），
    // 但一家厂商没给 token 明细就不许报 token 数**——两半各钉一头，谁都不许糊。
    mockOpenAIStream([{ reasoning: "想" }], { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 });
    const provider = createOpenAIProvider(openaiConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err.message).toMatch(/1 字思考/);
    expect(err.message, "这家没给明细，报 token 数就是替厂商编").not.toMatch(/\d+ token 花在思考上/);
    expect(err.message).not.toContain("模型名称不存在");
  });

  it("流式：reasoning_tokens 明确为 0（真·空流）同样不许说成思考吃满", async () => {
    mockOpenAIStream([{ content: "" }], {
      prompt_tokens: 5, completion_tokens: 0, total_tokens: 5,
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    const provider = createOpenAIProvider(openaiConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err.message).toContain("模型名称不存在或无权访问");
    expect(err.message).not.toContain("花在思考上");
  });

  it("非流式空壳：reasoning_tokens 在 JSON 的 usage 里，一样要说出来", async () => {
    mockFetchResponse({ choices: null, usage: REASONING_USAGE });
    const provider = createOpenAIProvider(openaiConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err.message).toContain("4100 token 花在思考上");
    expect(err.message).not.toContain("模型名称不存在");
  });

  it("非流式空壳没有那个字段时照旧说三种猜测", async () => {
    mockFetchResponse({ choices: null, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    const provider = createOpenAIProvider(openaiConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err.message).toContain("模型名称不存在或无权访问");
    expect(err.message).not.toContain("花在思考上");
  });
});

/**
 * 请求级 thinking 覆盖。
 *
 * 设置页那枚「关闭思考」是**厂商级**的（`config.thinking`），而 agent 的降级重发需要的是
 * **这一发**关一次思考（第一发仍然让模型想，质量优先）。所以 `ChatCompletionRequest` 也要能带，
 * 且优先级是"请求级 > 配置级"。四格各给一个相反的值：只认一侧的实现都能被其中一格抓出来。
 * 都没设时**一个字段都不许多发**——那是不支持这个参数的模型（ModelScope 等）的护身符。
 */
describe("OpenAI provider 请求级 thinking 覆盖配置级", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
    localStorage.clear();
  });

  const sentThinking = (config: ProviderConfig, reqThinking?: boolean) => {
    const calls = mockFetchCapture();
    const provider = createOpenAIProvider(config);
    const req: { messages: { role: "user"; content: string }[]; thinking?: boolean } = {
      messages: [{ role: "user", content: "hi" }],
    };
    if (reqThinking !== undefined) req.thinking = reqThinking;
    return provider.chat(req).then(() => {
      const body = JSON.parse(calls[0].init?.body as string);
      return { has: "thinking" in body, value: body.thinking };
    });
  };

  it("请求级 false 而配置没设 → 发 disabled（这是降级重发那一发的形状）", async () => {
    expect(await sentThinking(openaiConfig, false)).toEqual({ has: true, value: { type: "disabled" } });
  });

  it("请求级 true 而配置是 false → 不许发 disabled（请求级说话算数）", async () => {
    expect(await sentThinking({ ...openaiConfig, thinking: false }, true)).toEqual({ has: false, value: undefined });
  });

  it("请求没带、配置是 false → 照旧发 disabled（设置页那枚勾不许被这次改动弄坏）", async () => {
    expect(await sentThinking({ ...openaiConfig, thinking: false })).toEqual({ has: true, value: { type: "disabled" } });
  });

  it("两边都没设 → 一个 thinking 字段都不许多发", async () => {
    expect(await sentThinking(openaiConfig)).toEqual({ has: false, value: undefined });
  });

  it("配置是 true 而请求没带 → 也不发（只有显式 false 才发）", async () => {
    expect(await sentThinking({ ...openaiConfig, thinking: true })).toEqual({ has: false, value: undefined });
  });
});

/**
 * 同一条契约的 Anthropic 形状。
 *
 * 「空正文才降级重发」（`36c6294`）往请求上挂的是 `thinking: false`，而 anthropic.ts 当时
 * **根本不读这个字段**——对这家厂商那发降级等于空转：第二发和第一发参数一模一样，钱花两遍、
 * 正文照样空。这里钉的就是"这一发真的把思考关了"。
 * 反过来也要钉住"不许多发"：Anthropic 的 `thinking:{type:"enabled"}` 会**改变输出质量与花费**，
 * 产品从没要求过开启思考，实现里手滑写成 enabled 必须红。
 */
describe("Anthropic provider 请求级 thinking 覆盖配置级", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
    localStorage.clear();
  });

  const sentThinking = (config: ProviderConfig, reqThinking?: boolean) => {
    const calls = mockFetchCapture({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = createAnthropicProvider(config);
    const req: { messages: { role: "user"; content: string }[]; thinking?: boolean } = {
      messages: [{ role: "user", content: "hi" }],
    };
    if (reqThinking !== undefined) req.thinking = reqThinking;
    return provider.chat(req).then(() => {
      const body = JSON.parse(calls[0].init?.body as string);
      return { has: "thinking" in body, value: body.thinking };
    });
  };

  it("请求级 false → 发 {type:'disabled'}（降级重发那一发的形状）", async () => {
    expect(await sentThinking(anthropicConfig, false)).toEqual({ has: true, value: { type: "disabled" } });
  });

  it("请求没带、配置是 false → 照旧发 disabled（设置页那枚勾不许被弄坏）", async () => {
    expect(await sentThinking({ ...anthropicConfig, thinking: false })).toEqual({ has: true, value: { type: "disabled" } });
  });

  it("请求级 true 而配置是 false → 不许发 disabled（请求级说话算数）", async () => {
    expect(await sentThinking({ ...anthropicConfig, thinking: false }, true)).toEqual({ has: false, value: undefined });
  });

  it("两边都没设 → 一个 thinking 字段都不许多发", async () => {
    expect(await sentThinking(anthropicConfig)).toEqual({ has: false, value: undefined });
  });

  it("配置是 true 而请求没带 → 也不许发 enabled（开启思考会改质量与花费，产品从没要求过）", async () => {
    expect(await sentThinking({ ...anthropicConfig, thinking: true })).toEqual({ has: false, value: undefined });
  });

  it("关思考不许顺手改 max_tokens（那一格由输出预算唯一出处管）", async () => {
    const calls = mockFetchCapture({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await createAnthropicProvider(anthropicConfig).chat({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4321,
      thinking: false,
    });
    const body = JSON.parse(calls[0].init?.body as string) as Record<string, unknown>;
    expect(body.max_tokens).toBe(4321);
  });
});

/**
 * 判别力台账（2026-09-27 本机，`npx vitest run src/api/__tests__/providers.test.ts`）。
 * 基线：src/api/providers/anthropic.ts = sha256 dade7d05…，产品侧只有 4 行加、0 行删。
 * 立红阶段：改产品之前"必须发 disabled"那两格就是红的（读到 `has:false`）；
 * 四条"不许多发"当时是绿的——它们是这次改动的护栏，不是新增行为。
 *
 *  B1 摘掉 `if (...) body.thinking = ...` 那一行 → 2 红（正是立红那两格）
 *  B2 优先级倒过来写成 `config.thinking ?? req.thinking` → 1 红：请求级 true 而配置 false 那一格
 *  B3 `=== false` 换成 `!== undefined` → 2 红：请求级 true 那一格 + 配置 true 那一格
 *  B4 值换成 `{ type: "enabled" }` → 2 红：两格"必须发 disabled"（读得到 has:true 但值不对）
 *  B5 在那个分支里顺手 `body.max_tokens = 1024` → 1 红：关思考不许改预算那一格
 *
 * 没有一刀 0 红。两条腿（直连与代理）共用同一个 `buildBody`，所以只判直连那一腿的 body：
 * "把 thinking 只塞进一条腿"的形状在这份实现里不存在，为它再下一刀是空刀。
 */

/**
 * 判别力台账·第二笔（2026-09-27 同日，制作人点头"OpenAI 那条腿按你的建议来"）。
 * 判据在上面 `describe("OpenAI provider parseResponse")` 里那五条新条目（O1..O5）；
 * 基线：`src/api/providers/openai.ts` = sha256 `622ffd9a…`（改完之后那一份），
 * 改前那一份是 `6cc4d805…`。每刀之后 `cp` 回基线 + `cmp` + 重核 sha；0 刀对照 **50 passed**。
 *
 *  产品这一笔改了同一个 `if`：`content === null` → `content === null || content.trim() === ""`，
 *  并把那句文案分成"choices 为空"与"正文是空白"两种。
 *  O1 空字符串要抛且 `isEmptyResultError` 认得（降级那一发的锚）
 *  O2 只有空白符也算空（另一格）      O3 这一路也要说准原因（usage 里有 reasoning_tokens）
 *  O4 反向：只有一个字不许误抛        O5 那句要说清是"哪一种空"
 *
 *  W1 把 `|| content.trim() === ""` 摘掉（＝退回改前那半）→ **4 红**（O1 O2 O3 O5）
 *  W2 只去掉 `trim()`（`content === ""`）        → **1 红**（O2）＝空白符那一格独立有牙
 *  W3 `shape` 固定成 "choices 为空"              → **1 红**（O5）
 *  W4 `emptyResultNote(reasoning)` 传 undefined   → **2 红**（O3 + 早先那条"非流式空壳要说出
 *      reasoning_tokens"——两格共用同一只函数，一刀红两条，不是判据混了格）
 *  W5 判据放宽成 `content.trim().length < 2`      → **1 红**（O4）＝反向取样那一格有牙
 *
 * 为什么这一笔值得单独记：**它修的不是"界面少一行字"，是一条链的开关**。agent 的
 * 「确认这一发空正文 → 第二发带 `thinking:false` 重发」认的是错误前缀（`error-handler.ts:53`），
 * 静默返回空串时那条链在 OpenAI 这条腿上根本不触发——而测试全绿、看不出来。
 *
 * 基线已过时一句：这笔之后 `emptyResultNote` 搬进了 `error-handler.ts`（openai.ts 基线
 * `622ffd9a…` → `5f0378a9…`）。W1/W2/W3/W5 打在 openai.ts 的那两个 `if` 上，位置没动、结论照旧；
 * **W4 那格（内核不报原因）已由上面台账的 N6/N7 在新基线上重打**，读数换成 4 红 / 7 红。
 */

/**
 * 判别力台账·第三笔（2026-09-27，制作人点头「继续啃」）。
 * 对象：`src/api/providers/anthropic.ts`，基线 sha256 `9d048367…` / 12625 B（改前那一份是 `dade7d05…`）。
 * 判据 13 条（A1..A13），刀 10 把（K1..K10）。每轮一把、跑完 `cp` + `cmp` 回到 9d048367；
 * 0 刀对照：**63 passed**（本文件）。
 *
 * 这一腿原先的读法是 `contentArr?.[0]?.text`——只看第一块。两个后果，一真一假：
 *  - **真答案被扔掉**：思考型厂商回 `[{thinking…},{text…}]`，首块没有 `text` 字段，于是那一发
 *    被判成"空结果"，界面报的是"模型名称不存在或无权访问"——名对、钥对、参数对，纯假话；
 *  - **假空被放过去**：首块 `text` 是空串时 `content === null` 不成立，那一发**静默返回空串**，
 *    agent 的「空正文才关思考重发」（认的是错误前缀）在这条腿上整条不起作用。
 * 改法与 openai.ts 同一口径：所有 `text` 块拼起来当正文，拼完是空白就算空壳；证据从
 * `reasoning_tokens` 换成"有没有非空 thinking 块"（这家没那个字段），数字取 `usage.output_tokens`
 * ——正文一个字都没有时，那一发输出的就是思考花掉的数。
 *
 *  立红读数（产品未动，13 条里 10 条已写下）：**7 failed / 53 passed**。三条当时就绿的是护栏：
 *  「只有思考块要抛错」（改动前也抛，只是话说不准）、「流式反向空流」、「思考不混进正文」——
 *  它们的牙分别由 K2、K8、K7 证明，不是由"实现前就红"证明。后又补 3 条护栏（空壳 thinking 两腿各一、
 *  content 不是数组），实现已就位、当场绿，配 K5/K8/K9。
 *
 *  K1 正文退回只读首块（`blocks[0].text`）        2 红：思考块在前 + 分几块拼全
 *  K2 摘掉 `|| content.trim() === ""`             8 红：新写的 6 条**连同两条老用例**（空数组、
 *     `content[0].text 缺失`）一起塌——那两条本来就在判同一格静默返回，改动前它们是绿的假象
 *  K3 `shape` 固定成 "content 缺失"               1 红：「哪一种空」那条（两种空混成一句就没法分辨）
 *  K4 证据门槛摘掉（恒传 `outputTokens`）          2 红：「没思考块不许说思考吃满」+「空壳 thinking 不算证据」
 *  K5 非流式"非空 thinking"那半摘掉                1 红：空壳 thinking 那条
 *  K6 流式的 `thinking_delta` 记录整行摘掉         1 红：流式点名思考那条
 *  K7 把草稿当正文（thinking 也 `content +=`）      2 红：「思考不许混进正文」+「只有 thinking 增量要报数」
 *     ——后一条红得比预期有意思：草稿一混进正文，`content` 就非空，"这一发没回话"那一格整个消失
 *  K8 流式"非空 thinking"那半摘掉                  1 红：流式空壳 thinking 那条
 *  K9 摘掉 `Array.isArray` 守卫                    1 红：content 是字符串时抛的是 TypeError，
 *     没有前缀 → 降级那条链断（这一格是补判据之后才咬得住的）
 *  K10 **改的是 `error-handler.ts` 那只内核**（`${reasoningTokens}` → `${0}`）
 *     6 红：内核 1 + OpenAI 3 + **Anthropic 2** —— 这一刀是"两条腿真共用同一份措辞"的证据；
 *     搬家那一笔（N6）当时只红 4 条，anthropic 这两条是这次接上来的。
 * 没有一刀 0 红。
 *
 * 记一笔欠账（不是这次要修的）：**整条 anthropic 腿在浏览器层 0 判据**——实测 `grep -i anthropic e2e/`
 * 0 命中，假厂商端点只做了 OpenAI 格式。也就是说这一腿"接没接上真挂载"（agent 选到 anthropic 时
 * 整条生成链走不走得通）jsdom 这一档给不了答案，与本轮同一形状的坑（"我自己往容器 dispatch 的判据
 * 量不到监听其实没接上"）同源。要么给 e2e 的假厂商加一个 anthropic 格式端点，要么这条腿永远只有单测。
 */

describe("Anthropic provider parseResponse", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
    localStorage.clear();
  });

  it("正常响应时返回 content 和 token 用量", async () => {
    mockFetchResponse({
      id: "msg-1",
      content: [{ type: "text", text: "这是总结" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const provider = createAnthropicProvider(anthropicConfig);
    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(result.content).toBe("这是总结");
    expect(result.tokensUsed).toEqual({ input: 100, output: 50, total: 150 });
  });

  it("content 为 null 时抛错（空壳响应）", async () => {
    mockFetchResponse({
      id: "msg-1",
      content: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const provider = createAnthropicProvider(anthropicConfig);
    await expect(provider.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({
      name: "APIError",
      apiCode: "server",
    });
  });

  it("content 为空数组时抛错", async () => {
    mockFetchResponse({
      id: "msg-1",
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const provider = createAnthropicProvider(anthropicConfig);
    await expect(provider.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(APIError);
  });

  it("content[0].text 缺失时抛错", async () => {
    mockFetchResponse({
      id: "msg-1",
      content: [{ type: "text" }],
      usage: {},
    });
    const provider = createAnthropicProvider(anthropicConfig);
    await expect(provider.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(APIError);
  });

  // ↓↓↓ 2026-09-27 批次 B：这一腿读正文只读 `content[0].text`，而思考型厂商回的是
  // `[{thinking…},{text…}]`——首块没有 `text`，于是**后面那块真答案整个被扔掉**，报的还是
  // "可能原因：模型名称不存在或无权访问"（假话：名对、钥对、参数对）。首块 text 是空串时更糟：
  // 那一发被原样当成合法答复返回，静默空串，降级那一发根本不触发。
  // 这一簇先立红。

  const THINKING_FIRST = {
    id: "msg-1",
    content: [
      { type: "thinking", thinking: "先想一段很长的", signature: "sig-1" },
      { type: "text", text: "真正的总结" },
    ],
    // 320 与下面任何一段数字都不重，"那句里的数从哪来的"才分得出来
    usage: { input_tokens: 10, output_tokens: 320 },
  };

  it("思考块排在正文前面：正文必须照样交出来，不许当成空壳扔掉", async () => {
    mockFetchResponse(THINKING_FIRST);
    const provider = createAnthropicProvider(anthropicConfig);
    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(result.content).toBe("真正的总结");
    // 思考本身不许混进正文（那是给用户看的答案，不是模型的草稿）
    expect(result.content).not.toContain("先想一段很长的");
  });

  it("正文分在几个 text 块里要拼全，首块是空串也不算没回话", async () => {
    mockFetchResponse({
      id: "msg-1",
      content: [
        { type: "text", text: "" },
        { type: "text", text: "前半 " },
        { type: "text", text: "后半" },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const provider = createAnthropicProvider(anthropicConfig);
    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(result.content).toBe("前半 后半");
  });

  it("只有思考块、一个字正文都没回 → 要抛错，而且降级那条链认得这个错", async () => {
    mockFetchResponse({
      id: "msg-1",
      content: [{ type: "thinking", thinking: "想满了", signature: "sig-2" }],
      usage: { input_tokens: 10, output_tokens: 2048 },
    });
    const provider = createAnthropicProvider(anthropicConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(isEmptyResultError(err), "抛的不是「空正文」那一类，第二发就不会关思考").toBe(true);
  });

  it("那一发要把证据说出来：思考块的预算记在 output_tokens，就得报那个数", async () => {
    mockFetchResponse({
      id: "msg-1",
      content: [{ type: "thinking", thinking: "想满了", signature: "sig-3" }],
      usage: { input_tokens: 10, output_tokens: 3072 },
    });
    const provider = createAnthropicProvider(anthropicConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    // 整句一起比：句尾「原始响应」里躺着 3072，只断"含这个数字"糊得过去
    expect(err.message).toContain("3072 token 花在思考上");
    expect(err.message).not.toContain("模型名称不存在");
  });

  it("反向那一格：没有思考块时，output_tokens 再大也不许说成思考吃满", async () => {
    mockFetchResponse({
      id: "msg-1",
      content: [{ type: "text", text: "" }],
      usage: { input_tokens: 10, output_tokens: 3072 },
    });
    const provider = createAnthropicProvider(anthropicConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err.message).toContain("模型名称不存在");
    expect(err.message).not.toContain("花在思考上");
  });

  it("只有一个空壳 thinking 块（没内容）→ 不算证据，照旧说那三种猜测", async () => {
    mockFetchResponse({
      id: "msg-1",
      content: [
        { type: "thinking", thinking: "   ", signature: "sig-4" },
        { type: "text", text: "" },
      ],
      usage: { input_tokens: 10, output_tokens: 3072 },
    });
    const provider = createAnthropicProvider(anthropicConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err.message).toContain("模型名称不存在");
    expect(err.message).not.toContain("花在思考上");
  });

  it("正文只有空白符要抛错，不许静默返回那一串空格", async () => {
    mockFetchResponse({
      id: "msg-1",
      content: [{ type: "text", text: " \n " }],
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    const provider = createAnthropicProvider(anthropicConfig);
    await expect(provider.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(APIError);
  });

  it("content 不是数组（网关回个字符串）→ 按空壳抛错，不许崩在数组操作上", async () => {
    // 崩在 `blocks.map` 上抛的是 TypeError：没有「API 返回了空结果」那个前缀，
    // agent 那条「空正文才关思考重发」的链就此断开，界面收到的也是一句没头没尾的堆栈。
    mockFetchResponse({ id: "msg-1", content: "upstream returned a string", usage: {} });
    const provider = createAnthropicProvider(anthropicConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err, `抛的不是 APIError：${err?.name}`).toBeInstanceOf(APIError);
    expect(isEmptyResultError(err)).toBe(true);
  });

  it("那一句要说清是「哪一种空」：content 没了 ≠ 有块但一个字都没有", async () => {
    const provider = createAnthropicProvider(anthropicConfig);
    const ask = () => provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);

    mockFetchResponse({ id: "msg-1", content: null, usage: {} });
    expect((await ask()).message).toContain("content 缺失");

    mockFetchResponse({ id: "msg-1", content: [{ type: "text", text: "  " }], usage: {} });
    const blank = (await ask()).message;
    expect(blank, "两种空写成同一句话就没法分辨了").not.toContain("content 缺失");
    expect(blank).toContain("正文是空白");
  });

  it("流式响应（SSE）时聚合 content_block_delta 的 text", async () => {
    mockAnthropicStream(["你好", "，我是", "Claude"], { input_tokens: 100, output_tokens: 30 });
    const provider = createAnthropicProvider(anthropicConfig);
    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(result.content).toBe("你好，我是Claude");
    expect(result.tokensUsed).toEqual({ input: 100, output: 30, total: 130 });
  });

  it("流式响应中嵌入 error 事件时抛错", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        [
          'data: {"type":"message_start","message":{"id":"msg-1","usage":{"input_tokens":5,"output_tokens":0}}}',
          "",
          'data: {"type":"error","error":{"type":"invalid_request_error","message":"bad key"}}',
          "",
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } }
      )
    );
    const provider = createAnthropicProvider(anthropicConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.message).toContain("bad key");
  });

  it("流式响应无内容时抛错", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        [
          'data: {"type":"message_start","message":{"id":"msg-1","usage":{"input_tokens":5,"output_tokens":0}}}',
          "",
          'data: {"type":"message_stop"}',
          "",
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } }
      )
    );
    const provider = createAnthropicProvider(anthropicConfig);
    await expect(provider.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({
      name: "APIError",
      apiCode: "server",
    });
  });

  const thinkingEvents = (out: number) => [
    { type: "message_start", message: { id: "msg-1", usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想了一大段" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", usage: { output_tokens: out } },
    { type: "message_stop" },
  ];

  it("流式那一腿同样要说准原因：只有 thinking 增量 + output_tokens 有数 → 点名思考吃满", async () => {
    mockAnthropicRawStream(thinkingEvents(3072));
    const provider = createAnthropicProvider(anthropicConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    // 整句比对：raw 里也印着 3072（这一档的教训是从 OpenAI 那条腿抄来的）
    expect(err.message).toContain("3072 token 花在思考上");
    expect(err.message).not.toContain("模型名称不存在");
    expect(isEmptyResultError(err)).toBe(true);
  });

  it("流式反向：一帧思考都没有的空流，照旧说那三种猜测", async () => {
    mockAnthropicStream([], { input_tokens: 5, output_tokens: 999 });
    const provider = createAnthropicProvider(anthropicConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err.message).toContain("模型名称不存在");
    expect(err.message).not.toContain("花在思考上");
  });

  it("流式那一腿同样只认「真的想过」：thinking 帧是空白就不算证据", async () => {
    mockAnthropicRawStream([
      { type: "message_start", message: { id: "msg-1", usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "   " } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", usage: { output_tokens: 3072 } },
      { type: "message_stop" },
    ]);
    const provider = createAnthropicProvider(anthropicConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err.message).toContain("模型名称不存在");
    expect(err.message).not.toContain("花在思考上");
  });

  it("思考增量不许混进正文：thinking 与 text 一起来时只交正文那一半", async () => {
    mockAnthropicRawStream([
      ...thinkingEvents(200).slice(0, 5),
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "答案是" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "这样" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", usage: { output_tokens: 200 } },
      { type: "message_stop" },
    ]);
    const provider = createAnthropicProvider(anthropicConfig);
    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(result.content).toBe("答案是这样");
  });

  it("默认请求体包含 stream: true", async () => {
    const calls = mockFetchCapture({ id: "msg-1", content: [{ type: "text", text: "ok" }], usage: {} });
    const provider = createAnthropicProvider(anthropicConfig);
    await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.stream).toBe(true);
  });

  it("config.stream 为 false 时请求体包含 stream: false", async () => {
    const calls = mockFetchCapture({ id: "msg-1", content: [{ type: "text", text: "ok" }], usage: {} });
    const provider = createAnthropicProvider({ ...anthropicConfig, stream: false });
    await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.stream).toBe(false);
  });
});

/**
 * Anthropic 角色交替（round 2 批次 3 / R-36）
 *
 * API 要求 user/assistant 严格交替。QA 里失败或被取消的那一轮会把用户消息
 * 留在历史里，下一轮就出现连续两条 user → 400，之后每次追问都失败。
 */
describe("Anthropic provider 消息归一", () => {
  const anthropicReply = { content: [{ type: "text", text: "ok" }], usage: {} };

  function anthropicMessages(calls: { url: string; init?: RequestInit }[]) {
    return JSON.parse(calls[0].init?.body as string).messages as { role: string; content: string }[];
  }

  it("连续两条 user 合并成一条", async () => {
    const calls = mockFetchCapture(anthropicReply);
    const provider = createAnthropicProvider(anthropicConfig);
    await provider.chat({ messages: [
      { role: "user", content: "第一个问题" },
      { role: "user", content: "第二个问题" },
    ] });
    const msgs = anthropicMessages(calls);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toContain("第一个问题");
    expect(msgs[0].content).toContain("第二个问题");
  });

  it("连续 assistant 同样合并，正常交替保持原样", async () => {
    const calls = mockFetchCapture(anthropicReply);
    const provider = createAnthropicProvider(anthropicConfig);
    await provider.chat({ messages: [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u2" },
    ] });
    expect(anthropicMessages(calls).map((m) => `${m.role}:${m.content}`))
      .toEqual(["user:u1", "assistant:a1\n\na2", "user:u2"]);
  });

  it("首条不是 user 时丢弃前导 assistant（否则整个请求被拒）", async () => {
    const calls = mockFetchCapture(anthropicReply);
    const provider = createAnthropicProvider(anthropicConfig);
    await provider.chat({ messages: [
      { role: "assistant", content: "不该有的开头" },
      { role: "user", content: "u1" },
    ] });
    expect(anthropicMessages(calls)).toEqual([{ role: "user", content: "u1" }]);
  });

  it("system 仍单独走 system 字段，不混进消息序列", async () => {
    const calls = mockFetchCapture(anthropicReply);
    const provider = createAnthropicProvider(anthropicConfig);
    await provider.chat({ messages: [
      { role: "system", content: "你是助手" },
      { role: "user", content: "u1" },
    ] });
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.system).toBe("你是助手");
    expect(body.messages).toEqual([{ role: "user", content: "u1" }]);
  });
});

/**
 * 厂商这一发被自己的输出上限切断了，得把这个事实带到调用方（`truncated`）。
 *
 * 为什么要 provider 来摊：`finish_reason` / `stop_reason` 只存在于厂商的响应里，而 agent 拿到的
 * 只有 `content`。2026-09-28 真厂商（`vbatch-deepseek-0928`，小说地图那一发）实测到的形状是
 * **思考吃满预算但挤出半截 JSON**：`completion_tokens=8192 / reasoning_tokens=8080 / 正文 246 字 /
 * finish_reason=length`。它不是"一个字正文都没回"，所以 agent 那条「空正文才关思考重发」的降级
 * 完全不认它，第二发照旧开思考、这回一个字都没回。
 *
 * 只认厂商给的那个值，别自己拿"正文短"或"括号不配对"去猜——猜出来的会把一份本来能用的回包
 * 也标成截断（09-23 实测过 4852 字的截断回包仍拼出了可用地图）。
 * 两头各钉一条：`length`/`max_tokens` 必须标，正常收尾与别的收尾原因（`content_filter`）不许标。
 *
 * ## 变异台账（2026-09-28 实跑，四刀无一记 0 红；四只产品文件先 `cp` 基线、每刀还原后当场核 sha）
 * 基线：`openai.ts 7c96dc39…` / `anthropic.ts 1301fad7…` / `map-agent.ts e41b4ec2…` /
 * `graph-agent.ts b86b72f6…`。对照轮（0 刀）175 条全绿、reds=0。
 *  - AA1 openai 流式那处写死 `truncated:false` → 红 1（流式正例）
 *  - AA2 openai 非流式那处写死 `false` → 红 1（非流式正例）——**两条腿各一刀**：只接一支的写法
 *    在这里会放过另一支，与上面"空正文两腿各一刀"是同一族坑
 *  - AA3 anthropic 流式摘掉 `stop_reason` 那一读 → 红 1（图谱那腿的正例）
 *  - AA4 openai 流式把判断放宽成"凡非空收尾都算切断" → 红 1（正常收尾不许标那一条）
 *    ——这条是这一批唯一咬住"过度标记"的刀，别以为有了正例就不用下它
 *  产品那一层的刀（AA5..AA7：map/graph 摘掉 `response.truncated` 那一读、切断就地不交给解析）
 *  记在 `src/agents/__tests__/map-agent.test.ts` 那一段末尾，同一轮一起数。
 */
describe("厂商被输出上限切断那一发要摊到调用方（truncated）", () => {
  // 断在字符串中间的地图 JSON，真回包的尾巴就是这个样子
  const CUT = '{"layers":[{"level":1,"name":"沧澜水路天下"},{"level":2,"name":"府郡港域","description":';

  it("OpenAI 流式：正文有字而 finish_reason=length → truncated:true", async () => {
    mockOpenAIStream([{ content: CUT }], { completion_tokens: 8192, completion_tokens_details: { reasoning_tokens: 8080 } }, "length");
    const provider = createOpenAIProvider(openaiConfig);
    const r = await provider.chat({ messages: [{ role: "user", content: "画一张地图" }] });
    expect(r.content).toBe(CUT);
    expect(r.truncated, "厂商说这一发被切断了，agent 拿不到这个数就会把半截 JSON 当成一份完整回包").toBe(true);
  });

  it("OpenAI 流式：正常收尾（stop）不许带截断标记", async () => {
    mockOpenAIStream([{ content: CUT }]);
    const provider = createOpenAIProvider(openaiConfig);
    const r = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(r.truncated, "正文一样长、只有收尾不同：拿正文猜截断就是把每一发都标成没成").toBeFalsy();
  });

  it("OpenAI 非流式：choices[0].finish_reason=length → truncated:true", async () => {
    mockFetchResponse({
      choices: [{ message: { role: "assistant", content: CUT }, finish_reason: "length" }],
      usage: { completion_tokens: 8192 },
    });
    const provider = createOpenAIProvider(openaiConfig);
    const r = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(r.truncated).toBe(true);
  });

  it("OpenAI 非流式：别的收尾原因（content_filter）不算被上限切断", async () => {
    mockFetchResponse({
      choices: [{ message: { role: "assistant", content: "这段被内容策略拦了" }, finish_reason: "content_filter" }],
      usage: { completion_tokens: 12 },
    });
    const provider = createOpenAIProvider(openaiConfig);
    const r = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(r.truncated, "关思考重发救不了内容策略：把它标成截断等于对用户说假话").toBeFalsy();
  });

  it("Anthropic 流式：message_delta 里 stop_reason=max_tokens → truncated:true", async () => {
    mockAnthropicRawStream([
      { type: "message_start", message: { id: "m", usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: CUT } },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 4096 } },
      { type: "message_stop" },
    ]);
    const provider = createAnthropicProvider(anthropicConfig);
    const r = await provider.chat({ messages: [{ role: "user", content: "画一张地图" }] });
    expect(r.content).toBe(CUT);
    expect(r.truncated).toBe(true);
  });

  it("Anthropic 非流式：stop_reason=end_turn 不许带截断标记", async () => {
    mockFetchResponse({ content: [{ type: "text", text: "写完了" }], stop_reason: "end_turn", usage: {} });
    const provider = createAnthropicProvider(anthropicConfig);
    const r = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(r.truncated).toBeFalsy();
  });
});
