/**
 * AI Provider 响应解析测试
 * 重点覆盖：API 返回 200 但 choices/content 为空（空壳响应）时，必须抛错而非静默返回空内容
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOpenAIProvider } from "../providers/openai";
import { createAnthropicProvider } from "../providers/anthropic";
import type { ProviderConfig } from "../types";
import { APIError } from "../error-handler";

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
function mockOpenAIStream(chunks: { content?: string; reasoning?: string }[], usage?: unknown) {
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
  // 结束块
  lines.push(`data: ${JSON.stringify({ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`);
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
 */
describe("OpenAI provider 空正文的措辞：有证据才说思考吃满，说了要给出口", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
    localStorage.clear();
  });

  const REASONING_USAGE = {
    prompt_tokens: 9900,
    completion_tokens: 8192,
    total_tokens: 18092,
    completion_tokens_details: { reasoning_tokens: 8192 },
  };

  it("流式：只有 reasoning 帧 + usage 带 reasoning_tokens → 说清是思考吃满，不再猜模型名", async () => {
    mockOpenAIStream([{ reasoning: "第一步" }, { reasoning: "第二步" }], REASONING_USAGE);
    const provider = createOpenAIProvider(openaiConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.message).toContain("8192");
    expect(err.message).toContain("思考");
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

  it("流式：usage 里没有 reasoning_tokens → 保留原来那三种猜测，不许编一个原因", async () => {
    mockOpenAIStream([{ reasoning: "想" }], { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 });
    const provider = createOpenAIProvider(openaiConfig);
    const err = await provider.chat({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err.message).toContain("模型名称不存在或无权访问");
    expect(err.message).not.toContain("花在思考上");
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
    expect(err.message).toContain("8192");
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
