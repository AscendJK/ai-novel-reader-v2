/**
 * 两级超时预算（直连 / 代理）
 *
 * 用户看到的症状：点“生成”之后界面转圈好几分钟，像是程序死了。根因是两条腿各自
 * 拿 120 秒预算串起来跑——直连挂满 120 秒才让位给代理，代理再挂 120 秒，最坏 240 秒。
 * 直连在这里只是“探路”（能不能不经过后端打通厂商），所以它的预算必须短得多；
 * 但非流式请求的响应头要等整段生成完才回来，给它短预算会造成直连白打一次 +
 * 代理重打一次（双份 token），所以那条腿不许缩。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createOpenAIProvider } from "../providers/openai";
import { createAnthropicProvider } from "../providers/anthropic";

const openaiConfig = {
  id: "t-openai",
  format: "openai" as const,
  name: "T",
  apiKey: "sk-test",
  baseUrl: "https://api.example.com/v1",
  model: "m",
};
const anthropicConfig = { ...openaiConfig, id: "t-anthropic", format: "anthropic" as const };

const STREAM_REQ = { messages: [{ role: "user" as const, content: "hi" }], stream: true };
const JSON_REQ = { messages: [{ role: "user" as const, content: "hi" }], stream: false };

const OPENAI_OK = { choices: [{ message: { role: "assistant", content: "代理拿回来的" } }] };

/** 两条腿的绝对时间线：直连 0s 起，代理在直连让位后才起 */
const DIRECT_STREAM_MS = 30_000;
const LEG_MS = 120_000;

/** 记下发给 fetch 的 signal，永不主动响应；abort 时才 reject（模拟网关黑洞：连上但没回音） */
function hangingFetch() {
  const calls: { url: string; signal?: AbortSignal | null }[] = [];
  const fn = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const signal = init?.signal;
    calls.push({ url: u, signal });
    return new Promise<Response>((_resolve, reject) => {
      const onAbort = () => reject(new DOMException("This operation was aborted", "AbortError"));
      if (!signal) return;
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  });
  return { fn, calls };
}

const isProxy = (u: string | undefined) => !!u && u.includes("/api/proxy/chat");

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("sync-token", "a-token"); // 有 token 才会走“直连→代理”两条腿
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("直连只当探路", () => {
  it("流式请求：直连在 30 秒让位给代理，而不是等满 120 秒", async () => {
    const { fn, calls } = hangingFetch();
    globalThis.fetch = fn;
    void createOpenAIProvider(openaiConfig).chat(STREAM_REQ).catch(() => {});

    await vi.advanceTimersByTimeAsync(DIRECT_STREAM_MS - 1_000);
    expect(calls.length).toBe(1);
    expect(calls[0].signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000); // 跨过 30 秒
    expect(calls[0].signal?.aborted).toBe(true);
    expect(isProxy(calls[1]?.url)).toBe(true);
  });

  it("代理那条腿保留 120 秒预算（它才是真正干活的一条）", async () => {
    const { fn, calls } = hangingFetch();
    globalThis.fetch = fn;
    void createOpenAIProvider(openaiConfig).chat(STREAM_REQ).catch(() => {});

    await vi.advanceTimersByTimeAsync(DIRECT_STREAM_MS + 1_000); // 直连让位，代理起跑
    const proxyCall = calls.find((c) => isProxy(c.url));
    expect(proxyCall).toBeTruthy();

    // 代理只跑了 1 秒——不许借用直连剩下的时间，也不许提前掐
    await vi.advanceTimersByTimeAsync(LEG_MS - 2_000);
    expect(proxyCall?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(3_000); // 代理累计过 120 秒
    expect(proxyCall?.signal?.aborted).toBe(true);
  });

  it("非流式直连不许缩到 30 秒：整段生成完才回头，缩了会白打一次多花一份 token", async () => {
    const { fn, calls } = hangingFetch();
    globalThis.fetch = fn;
    void createOpenAIProvider(openaiConfig).chat(JSON_REQ).catch(() => {});

    await vi.advanceTimersByTimeAsync(DIRECT_STREAM_MS + 1_000);
    expect(calls.length).toBe(1);
    expect(calls[0].signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(LEG_MS - DIRECT_STREAM_MS + 1_000);
    expect(calls[0].signal?.aborted).toBe(true);
  });

  it("直连超时之后代理成功：用户拿到代理的结果", async () => {
    const hanging = hangingFetch();
    globalThis.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (isProxy(u)) {
        return Promise.resolve(
          new Response(JSON.stringify(OPENAI_OK), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      return hanging.fn(u, init);
    });

    const pending = createOpenAIProvider(openaiConfig).chat(STREAM_REQ);
    await vi.advanceTimersByTimeAsync(DIRECT_STREAM_MS + 1_000);
    expect((await pending).content).toBe("代理拿回来的");
  });

  it("超时错误点名是哪条腿（否则用户会去查一个没坏的后端）", async () => {
    const { fn } = hangingFetch();
    globalThis.fetch = fn;
    // 两条腿都挂满：报的是直连那条（30 秒），因为根因在它；代理那条的失败按既有行为丢弃
    const pending = createOpenAIProvider(openaiConfig)
      .chat(STREAM_REQ)
      .then(() => null, (e: unknown) => e as Error);
    await vi.advanceTimersByTimeAsync(DIRECT_STREAM_MS + LEG_MS + 2_000);
    const err = await pending;
    expect(err?.message).toMatch(/直连/);
    expect(err?.message).toMatch(new RegExp(`${DIRECT_STREAM_MS / 1000}\\s*秒`));
  });
});

describe("anthropic 同一套预算", () => {
  it("流式直连 30 秒让位，代理再等满自己的 120 秒", async () => {
    const { fn, calls } = hangingFetch();
    globalThis.fetch = fn;
    void createAnthropicProvider(anthropicConfig).chat(STREAM_REQ).catch(() => {});

    await vi.advanceTimersByTimeAsync(DIRECT_STREAM_MS + 1_000);
    expect(calls[0].signal?.aborted).toBe(true);
    const proxyCall = calls.find((c) => isProxy(c.url));
    expect(proxyCall?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(LEG_MS - 1_000);
    expect(proxyCall?.signal?.aborted).toBe(true);
  });
});
