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
});
