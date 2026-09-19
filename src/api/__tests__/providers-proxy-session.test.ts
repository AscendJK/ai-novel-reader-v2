/**
 * 直连被 CORS 挡 → 代理回退这条链路的"会话语义"。
 *
 * 复现的真实故障：后端会话存在内存 Map 里（server/sync-handler.js），重启即全部失效，
 * 而 localStorage 还留着旧 token。同步链路会自动重注册续期（sync-client 的 401 分支），
 * AI 链路过去不会——它只会把代理的 401 藏进最初的 CORS/网络错误里，用户看到的永远是
 * "生成失败"，且再点一次就好了（因为中间那次同步把 token 续上了）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { refreshSession } = vi.hoisted(() => ({ refreshSession: vi.fn() }));
vi.mock("@/sync/sync-client", () => ({ syncClient: { refreshSession } }));

import { createOpenAIProvider } from "../providers/openai";
import { createAnthropicProvider } from "../providers/anthropic";
import { APIError } from "../error-handler";

const openaiConfig = {
  id: "t-openai",
  format: "openai" as const,
  name: "T",
  apiKey: "sk-test",
  baseUrl: "https://api.example.com/v1",
  model: "m",
};
const anthropicConfig = { ...openaiConfig, id: "t-anthropic", format: "anthropic" as const };

type Step = { status: number; body?: unknown } | Error;

/** 按 URL 分流：直连命中 baseUrl，代理命中 /api/proxy/chat；各自按脚本走 */
function scriptedFetch(direct: Step[], proxy: Step[]) {
  const calls: { url: string; auth: string | null }[] = [];
  let d = 0;
  let p = 0;
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, auth: new Headers((init?.headers ?? {}) as HeadersInit).get("Authorization") });
    const isProxy = u.includes("/api/proxy/chat");
    const step = (isProxy ? proxy[p++] : direct[d++]) ?? { status: 500, body: { error: "脚本用尽" } };
    if (step instanceof Error) throw step;
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { fn, calls };
}

const CORS = () => new TypeError("Failed to fetch");
const okOpenAI = { status: 200, body: { choices: [{ message: { role: "assistant", content: "图谱结果" } }] } };
const okAnthropic = { status: 200, body: { content: [{ type: "text", text: "图谱结果" }] } };
const UNAUTHORIZED = { status: 401, body: { error: "需要登录" } };
const REQ = { messages: [{ role: "user" as const, content: "hi" }], stream: false };

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("sync-token", "stale-token");
  refreshSession.mockReset();
});

describe("代理回退的会话续期（A）", () => {
  it("代理 401 → 重注册拿到新 token → 用新 token 重试一次并成功", async () => {
    const { fn, calls } = scriptedFetch([CORS()], [UNAUTHORIZED, okOpenAI]);
    globalThis.fetch = fn;
    refreshSession.mockImplementation(async () => {
      localStorage.setItem("sync-token", "fresh-token");
      return true;
    });

    const result = await createOpenAIProvider(openaiConfig).chat(REQ);

    expect(result.content).toBe("图谱结果");
    expect(refreshSession).toHaveBeenCalledTimes(1);
    const proxyCalls = calls.filter((c) => c.url.includes("/api/proxy/chat"));
    expect(proxyCalls).toHaveLength(2);
    // 第二次必须带上重注册后的新 token：apiFetch 每次都从 localStorage 现取
    expect(proxyCalls[0].auth).toBe("Bearer stale-token");
    expect(proxyCalls[1].auth).toBe("Bearer fresh-token");
  });

  it("Anthropic 同一条链路同样生效", async () => {
    const { fn } = scriptedFetch([CORS()], [UNAUTHORIZED, okAnthropic]);
    globalThis.fetch = fn;
    refreshSession.mockResolvedValue(true);

    const result = await createAnthropicProvider(anthropicConfig).chat(REQ);
    expect(result.content).toBe("图谱结果");
  });
});

describe("不再把会话失效掩盖成网络错误（B）", () => {
  it("续期成功但代理仍 401 → 同样报会话失效，且不再无限重试", async () => {
    const { fn, calls } = scriptedFetch([CORS()], [UNAUTHORIZED, UNAUTHORIZED]);
    globalThis.fetch = fn;
    refreshSession.mockResolvedValue(true);

    const err = await createOpenAIProvider(openaiConfig).chat(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.apiCode).toBe("auth");
    expect(calls.filter((c) => c.url.includes("/api/proxy/chat"))).toHaveLength(2);
  });

  it("代理 401 不再被翻译成「API Key 错误」——那是后端在说需要登录", async () => {
    // 旧行为：代理的 401 一路走到 parseResponse → classifyError 按"上游认证失败"报，
    // 于是用户被告知去检查 API Key，而真正失效的是本地与后端的会话。
    const { fn } = scriptedFetch([CORS()], [UNAUTHORIZED]);
    globalThis.fetch = fn;
    refreshSession.mockResolvedValue(false);

    const err = await createOpenAIProvider(openaiConfig).chat(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.apiCode).toBe("auth");
    expect(err.message).toContain("登录");
    // classifyError 对 401 的措辞会把人支去检查密钥；这里必须不是它
    expect(err.message).not.toMatch(/API Key 错误|已过期或无权访问/);
  });

  it("代理自己回 5xx 时如实报代理的错误，且不去续期", async () => {
    const { fn } = scriptedFetch([CORS()], [{ status: 500, body: { error: "上游炸了" } }]);
    globalThis.fetch = fn;

    const err = await createOpenAIProvider(openaiConfig).chat(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.statusCode).toBe(500);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("代理连不上（请求本身失败）时保留既有语义：抛最初的直连错误", async () => {
    const { fn } = scriptedFetch([CORS()], [new TypeError("proxy unreachable")]);
    globalThis.fetch = fn;

    const err = await createOpenAIProvider(openaiConfig).chat(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe("Failed to fetch");
  });
});
