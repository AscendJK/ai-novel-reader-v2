/**
 * api-client 测试
 * 依赖 localStorage（已 mock）和 fetch（已 mock）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getServerUrl,
  setServerUrl,
  clearServerUrl,
  hasServerUrl,
  apiFetch,
  checkServerReachable,
  detectAndSetServerUrl,
} from "../api-client";

// 模拟 authHeaders
vi.mock("@/lib/auth-headers", () => ({
  authHeaders: () => ({ Authorization: "Bearer test-token" }),
}));

// ── URL 管理 ──

describe("getServerUrl / setServerUrl / clearServerUrl / hasServerUrl", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("默认返回空字符串", () => {
    expect(getServerUrl()).toBe("");
  });

  it("setServerUrl 后 getServerUrl 返回正确值", () => {
    setServerUrl("http://192.168.1.100:5173");
    expect(getServerUrl()).toBe("http://192.168.1.100:5173");
  });

  it("setServerUrl 自动补全协议头", () => {
    setServerUrl("192.168.1.100:5173");
    expect(getServerUrl()).toBe("http://192.168.1.100:5173");
  });

  it("setServerUrl 自动补全端口", () => {
    setServerUrl("http://192.168.1.100");
    expect(getServerUrl()).toBe("http://192.168.1.100:5173");
  });

  it("setServerUrl 移除末尾斜杠", () => {
    setServerUrl("http://192.168.1.100:5173/");
    expect(getServerUrl()).toBe("http://192.168.1.100:5173");
  });

  it("setServerUrl 移除末尾多余冒号", () => {
    setServerUrl("http://192.168.1.100:5173/:"); // 先前代码失误导致的尾部
    expect(getServerUrl()).toBe("http://192.168.1.100:5173");
  });

  it("clearServerUrl 清除后返回空字符串", () => {
    setServerUrl("http://192.168.1.100:5173");
    clearServerUrl();
    expect(getServerUrl()).toBe("");
  });

  it("hasServerUrl 返回正确状态", () => {
    expect(hasServerUrl()).toBe(false);
    setServerUrl("http://192.168.1.100:5173");
    expect(hasServerUrl()).toBe(true);
    clearServerUrl();
    expect(hasServerUrl()).toBe(false);
  });

  it("setServerUrl 保留 https 协议", () => {
    setServerUrl("https://localhost:8443");
    expect(getServerUrl()).toBe("https://localhost:8443");
  });

  it("setServerUrl 保留已存在的端口", () => {
    setServerUrl("http://192.168.1.100:8443");
    expect(getServerUrl()).toBe("http://192.168.1.100:8443");
  });
});

// ── 无端口 URL 按协议补默认端口 ──

describe("setServerUrl / checkServerReachable 无端口按协议补端口", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("https 无端口补 8443", () => {
    setServerUrl("https://192.168.1.100");
    expect(getServerUrl()).toBe("https://192.168.1.100:8443");
  });

  it("http 无端口补 5173", () => {
    setServerUrl("http://192.168.1.100");
    expect(getServerUrl()).toBe("http://192.168.1.100:5173");
  });

  it("裸域名补 http 协议 + 5173", () => {
    setServerUrl("192.168.1.100");
    expect(getServerUrl()).toBe("http://192.168.1.100:5173");
  });

  it("https 已有端口保留", () => {
    setServerUrl("https://192.168.1.100:9000");
    expect(getServerUrl()).toBe("https://192.168.1.100:9000");
  });

  it("checkServerReachable 对 https 无端口输入探测 8443", async () => {
    globalThis.fetch = vi.fn();
    const mockRes = new Response(null, { status: 200 });
    vi.mocked(globalThis.fetch).mockResolvedValue(mockRes);

    await checkServerReachable("https://192.168.1.100");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://192.168.1.100:8443/api/sync/check-user/test",
      expect.anything()
    );
  });
});


// ── detectAndSetServerUrl 裸 IP 智能探测 ──

describe("detectAndSetServerUrl 裸 IP 智能探测", () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.fetch = vi.fn();
  });

  it("双端口在线时优先 HTTPS", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 200 }));

    const saved = await detectAndSetServerUrl("192.168.1.100");

    expect(saved).toBe("https://192.168.1.100:8443");
    expect(getServerUrl()).toBe("https://192.168.1.100:8443");
    // 探测顺序：先 https 后 http，https 通则只探测一次
    const calls = vi.mocked(globalThis.fetch).mock.calls.map((c) => c[0]);
    expect(String(calls[0])).toContain("https://192.168.1.100:8443");
    expect(calls.length).toBe(1);
  });

  it("仅 HTTP 在线时回落 5173", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (String(url).includes("https://")) throw new TypeError("fetch failed");
      return new Response(null, { status: 200 });
    });

    const saved = await detectAndSetServerUrl("192.168.1.100");

    expect(saved).toBe("http://192.168.1.100:5173");
    expect(getServerUrl()).toBe("http://192.168.1.100:5173");
  });

  it("全部不可达时保存 http 默认值", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError("fetch failed"));

    const saved = await detectAndSetServerUrl("192.168.1.100");

    expect(saved).toBe("http://192.168.1.100:5173");
    expect(getServerUrl()).toBe("http://192.168.1.100:5173");
  });

  it("显式协议不探测直接规范化", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 200 }));

    const saved = await detectAndSetServerUrl("https://192.168.1.100");

    expect(saved).toBe("https://192.168.1.100:8443");
    expect(getServerUrl()).toBe("https://192.168.1.100:8443");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("显式端口不探测直接规范化", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 200 }));

    const saved = await detectAndSetServerUrl("192.168.1.100:9000");

    expect(saved).toBe("http://192.168.1.100:9000");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("空输入抛错", async () => {
    await expect(detectAndSetServerUrl("  ")).rejects.toThrow("服务器地址不能为空");
  });
});


// ── apiFetch ──

describe("apiFetch", () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.fetch = vi.fn();
  });

  it("未配置 URL 且页面托管于 GitHub Pages 时抛出错误（不回退）", async () => {
    // jsdom 默认 hostname 为 localhost，此处模拟 github.io 托管环境
    const original = window.location;
    vi.stubGlobal("window", { ...window, location: { ...original, hostname: "ascendjk.github.io", origin: "https://ascendjk.github.io" } });
    try {
      await expect(apiFetch("/api/test")).rejects.toThrow("未配置服务器地址");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("未配置 URL 且页面为同源部署（localhost）时回退当前源", async () => {
    // jsdom 默认 hostname 为 localhost，走同源回退
    const mockRes = new Response('{"ok":true}', { status: 200 });
    vi.mocked(globalThis.fetch).mockResolvedValue(mockRes);

    await apiFetch("/api/test");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/localhost(:\d+)?\/api\/test$/),
      expect.anything()
    );
  });

  it("拼接 URL 正确", async () => {
    setServerUrl("http://192.168.1.100:5173");
    const mockRes = new Response('{"ok":true}', { status: 200 });
    vi.mocked(globalThis.fetch).mockResolvedValue(mockRes);

    await apiFetch("/api/novels");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://192.168.1.100:5173/api/novels",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      })
    );
  });

  it("默认添加认证头", async () => {
    setServerUrl("http://192.168.1.100:5173");
    const mockRes = new Response('{"ok":true}', { status: 200 });
    vi.mocked(globalThis.fetch).mockResolvedValue(mockRes);

    await apiFetch("/api/sync/data");

    const callHeaders = vi.mocked(globalThis.fetch).mock.calls[0][1]?.headers as Record<string, string>;
    expect(callHeaders).toBeDefined();
    // authHeaders 的返回值应该被合并
    const headersObj = callHeaders as Record<string, string>;
    expect(headersObj["Authorization"]).toBe("Bearer test-token");
  });

  it("skipAuth=true 时不添加认证头", async () => {
    setServerUrl("http://192.168.1.100:5173");
    const mockRes = new Response('{"version":"2.1.8"}', { status: 200 });
    vi.mocked(globalThis.fetch).mockResolvedValue(mockRes);

    await apiFetch("/api/version", { signal: AbortSignal.timeout(5000) }, true);

    const callHeaders = vi.mocked(globalThis.fetch).mock.calls[0][1]?.headers as Record<string, string>;
    const headersObj = callHeaders as Record<string, string>;
    expect(headersObj["Authorization"]).toBeUndefined();
  });

  it("合并自定义 headers", async () => {
    setServerUrl("http://192.168.1.100:5173");
    const mockRes = new Response('{"ok":true}', { status: 200 });
    vi.mocked(globalThis.fetch).mockResolvedValue(mockRes);

    await apiFetch("/api/test", {
      headers: { "X-Custom": "custom-value" },
    });

    const callHeaders = vi.mocked(globalThis.fetch).mock.calls[0][1]?.headers as Record<string, string>;
    const headersObj = callHeaders as Record<string, string>;
    expect(headersObj["Authorization"]).toBe("Bearer test-token");
    expect(headersObj["X-Custom"]).toBe("custom-value");
  });

  it("传递 signal 给 fetch", async () => {
    setServerUrl("http://192.168.1.100:5173");
    const mockRes = new Response('{"ok":true}', { status: 200 });
    vi.mocked(globalThis.fetch).mockResolvedValue(mockRes);

    const controller = new AbortController();
    await apiFetch("/api/test", { signal: controller.signal });

    expect(vi.mocked(globalThis.fetch).mock.calls[0][1]?.signal).toBe(controller.signal);
  });
});

// ── checkServerReachable ──

describe("checkServerReachable", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  it("可达时返回 true", async () => {
    const mockRes = new Response(null, { status: 200 });
    vi.mocked(globalThis.fetch).mockResolvedValue(mockRes);

    const result = await checkServerReachable("http://192.168.1.100:5173");
    expect(result).toBe(true);
  });

  it("返回 404 也算可达", async () => {
    const mockRes = new Response(null, { status: 404 });
    vi.mocked(globalThis.fetch).mockResolvedValue(mockRes);

    const result = await checkServerReachable("http://192.168.1.100:5173");
    expect(result).toBe(true);
  });

  it("其他状态码返回 false", async () => {
    const mockRes = new Response(null, { status: 500 });
    vi.mocked(globalThis.fetch).mockResolvedValue(mockRes);

    const result = await checkServerReachable("http://192.168.1.100:5173");
    expect(result).toBe(false);
  });

  it("网络错误时返回 false", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError("fetch failed"));

    const result = await checkServerReachable("http://192.168.1.100:5173");
    expect(result).toBe(false);
  });

  it("自动补全协议头", async () => {
    const mockRes = new Response(null, { status: 200 });
    vi.mocked(globalThis.fetch).mockResolvedValue(mockRes);

    await checkServerReachable("192.168.1.100:5173");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\//),
      expect.anything()
    );
  });

  it("有端口时保留端口", async () => {
    const mockRes = new Response(null, { status: 200 });
    vi.mocked(globalThis.fetch).mockResolvedValue(mockRes);

    await checkServerReachable("http://192.168.1.100:8443");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://192.168.1.100:8443/api/sync/check-user/test",
      expect.anything()
    );
  });
});