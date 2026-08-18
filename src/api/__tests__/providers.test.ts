/**
 * AI Provider 响应解析测试
 * 重点覆盖：API 返回 200 但 choices/content 为空（空壳响应）时，必须抛错而非静默返回空内容
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOpenAIProvider } from "../providers/openai";
import { createAnthropicProvider } from "../providers/anthropic";
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
      headers: { "Content-Type": "text/event-stream" },
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
      headers: { "Content-Type": "text/event-stream" },
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
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
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
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
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
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
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
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
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
