/**
 * AI 两条腿（直连 / 代理）的分工判据：**换腿只治"这条路走不通"，不治"厂商答了但答得不对"**。
 *
 * 为什么单独立一只文件：`openai.ts` 与 `anthropic.ts` 过去写成
 * `try { return parseResponse(await doDirect(req)); } catch { 换代理 }`。
 * 在 async 函数里 `return 一个 promise` **不 await**，所以厂商响应回来之后解析阶段抛的错
 * （401、429、400 超限、空响应）根本不进那个 catch —— 看着像"认证错误不走代理"有守卫，
 * 实际那条守卫对这类错误永远不执行；而任何人手写 `return await parseResponse(...)`
 * 把这些错误"接回"判断里，就会变成：厂商已经生成完一次了，又换腿打第二次，
 * 同一份 token 花两遍。下面的用例钉的是这个边界，两种写法都要红得下来。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/sync/sync-client", () => ({
  syncClient: { refreshSession: vi.fn(async () => false) },
}));

import { createOpenAIProvider } from "../providers/openai";
import { createAnthropicProvider } from "../providers/anthropic";
import { APIError } from "../error-handler";
import type { AIProvider, ChatCompletionRequest, ProviderConfig } from "../types";

/** 一发请求的剧本：要么给一个 HTTP 响应，要么让 fetch 抛（连不上/超时/被取消） */
type Step = { status: number; body?: unknown } | { throws: unknown };

/** 按 URL 分流：直连命中 baseUrl，代理命中后端 `/api/proxy/chat`；各自按脚本走 */
function scriptedFetch(direct: Step[], proxy: Step[]) {
  const calls: string[] = [];
  let d = 0;
  let p = 0;
  const fn = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    calls.push(u.includes("/api/proxy/chat") ? "proxy" : "direct");
    const step = (u.includes("/api/proxy/chat") ? proxy[p++] : direct[d++]) ?? { status: 500, body: { error: "脚本用尽" } };
    // 别用 `instanceof Error` 分辨"要抛的那一发"：jsdom 的 DOMException 不是 Error 的实例
    if ("throws" in step) throw step.throws;
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { fn, calls };
}

const base = {
  id: "t",
  name: "T",
  apiKey: "sk-test",
  baseUrl: "https://api.example.com/v1",
  model: "m",
} satisfies Omit<ProviderConfig, "format">;

const NON_STREAM: ChatCompletionRequest = {
  messages: [{ role: "user", content: "hi" }],
  stream: false,
};

/** 两家厂商各回各的合法形状，"成功"这件事不是判据的重点，打了几次才是 */
const cases: { label: string; config: ProviderConfig; create: (c: ProviderConfig) => AIProvider; ok: Step; empty: Step }[] = [
  {
    label: "openai",
    config: { ...base, format: "openai" },
    create: createOpenAIProvider,
    ok: { status: 200, body: { choices: [{ message: { role: "assistant", content: "总结" } }] } },
    empty: { status: 200, body: { choices: null } },
  },
  {
    label: "anthropic",
    config: { ...base, format: "anthropic" },
    create: createAnthropicProvider,
    ok: { status: 200, body: { content: [{ type: "text", text: "总结" }] } },
    empty: { status: 200, body: { content: [] } },
  },
];

beforeEach(() => {
  localStorage.clear();
  // 有 token 才会启用"直连 → 代理"两条腿；没 token 时产品刻意只走直连
  localStorage.setItem("sync-token", "e2e-token");
});

describe.each(cases)("$label：厂商答过了就不再换腿（不重复花钱）", ({ config, create, empty }) => {
  it("直连回 401 → 一次请求都不许再发给代理，报的是厂商的密钥问题", async () => {
    const { fn, calls } = scriptedFetch([{ status: 401, body: { error: { message: "bad key" } } }], [empty]);
    globalThis.fetch = fn;

    const err = await create(config).chat(NON_STREAM).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.apiCode).toBe("auth");
    expect(calls).toEqual(["direct"]);
  });

  it("直连回 429 限流 → 换腿也只会再撞一次限流，所以一次都不许多发", async () => {
    const { fn, calls } = scriptedFetch([{ status: 429, body: { error: { message: "slow down" } } }], [empty]);
    globalThis.fetch = fn;

    const err = await create(config).chat(NON_STREAM).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.apiCode).toBe("rate_limit");
    expect(calls).toEqual(["direct"]);
  });

  it("直连回 400 且是超限 → 归类成上下文超限，且不换腿", async () => {
    const { fn, calls } = scriptedFetch(
      [{ status: 400, body: { error: { message: "maximum context length exceeded" } } }],
      [empty],
    );
    globalThis.fetch = fn;

    const err = await create(config).chat(NON_STREAM).catch((e) => e);
    expect(err.apiCode).toBe("context_length");
    expect(calls).toEqual(["direct"]);
  });

  it("直连回 200 但是空壳 → 报空结果，不换腿重打（重打就是花两遍）", async () => {
    const { fn, calls } = scriptedFetch([empty], [empty]);
    globalThis.fetch = fn;

    const err = await create(config).chat(NON_STREAM).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.message).toMatch(/空结果/);
    expect(calls).toEqual(["direct"]);
  });
});

describe.each(cases)("$label：连不上才换腿", ({ config, create, ok }) => {
  it("直连断网 → 代理补一次并成功，总共两次", async () => {
    const { fn, calls } = scriptedFetch([{ throws: new TypeError("Failed to fetch") }], [ok]);
    globalThis.fetch = fn;

    expect(await create(config).chat(NON_STREAM)).toMatchObject({ content: "总结" });
    expect(calls).toEqual(["direct", "proxy"]);
  });

  it("直连挂起被超时掐断 → 也算连不上，换腿", async () => {
    const { fn, calls } = scriptedFetch([{ throws: new Error("直连超时（30 秒无响应）") }], [ok]);
    globalThis.fetch = fn;

    expect(await create(config).chat(NON_STREAM)).toMatchObject({ content: "总结" });
    expect(calls).toEqual(["direct", "proxy"]);
  });

  it("两条腿都连不上 → 抛最初那个直连错误（代理的错误只会把人支去查后端）", async () => {
    const { fn, calls } = scriptedFetch(
      [{ throws: new TypeError("Failed to fetch") }],
      [{ throws: new TypeError("proxy unreachable") }],
    );
    globalThis.fetch = fn;

    const err = await create(config).chat(NON_STREAM).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe("Failed to fetch");
    expect(calls).toEqual(["direct", "proxy"]);
  });

  it("用户点了停止（AbortError）→ 原样上抛，绝不换腿再打一次", async () => {
    // 真浏览器里 fetch 被 abort 抛的就是 DOMException；判据用的是 `instanceof DOMException`，
    // 造普通 Error 只会测到一个不相干的分支上。
    const { fn, calls } = scriptedFetch([{ throws: new DOMException("user stopped", "AbortError") }], [ok]);
    globalThis.fetch = fn;

    const err = await create(config).chat(NON_STREAM).catch((e) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(calls).toEqual(["direct"]);
  });
});
