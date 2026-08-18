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

// ── apiFetch ──

describe("apiFetch", () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.fetch = vi.fn();
  });

  it("未配置 URL 时抛出错误", async () => {
    await expect(apiFetch("/api/test")).rejects.toThrow("未配置服务器地址");
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