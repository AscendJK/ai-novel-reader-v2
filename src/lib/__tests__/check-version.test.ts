/**
 * check-version 测试
 * 依赖 apiFetch 和 getServerUrl
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkVersion } from "../check-version";

// 使用 vi.hoisted 确保 mock 函数在 vi.mock 工厂前可用
const { mockApiFetch, mockGetServerUrl } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockGetServerUrl: vi.fn(),
}));

// 模拟 APP_VERSION
vi.mock("@/config/version", () => ({
  APP_VERSION: "2.1.8",
}));

// 模拟 apiFetch 和 getServerUrl
vi.mock("@/lib/api-client", () => ({
  apiFetch: mockApiFetch,
  getServerUrl: mockGetServerUrl,
}));

describe("checkVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("无 URL 时返回 match: true, backend: null", async () => {
    mockGetServerUrl.mockReturnValue("");

    const result = await checkVersion();

    expect(result).toEqual({
      match: true,
      frontend: "2.1.8",
      backend: null,
    });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("后端返回相同版本时 match: true", async () => {
    mockGetServerUrl.mockReturnValue("http://192.168.1.100:5173");
    mockApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ version: "2.1.8" }), { status: 200 })
    );

    const result = await checkVersion();

    expect(result.match).toBe(true);
    expect(result.frontend).toBe("2.1.8");
    expect(result.backend).toBe("2.1.8");
  });

  it("后端返回不同版本时 match: false", async () => {
    mockGetServerUrl.mockReturnValue("http://192.168.1.100:5173");
    mockApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ version: "2.1.7" }), { status: 200 })
    );

    const result = await checkVersion();

    expect(result.match).toBe(false);
    expect(result.frontend).toBe("2.1.8");
    expect(result.backend).toBe("2.1.7");
  });

  it("后端返回非 200 时返回错误信息", async () => {
    mockGetServerUrl.mockReturnValue("http://192.168.1.100:5173");
    mockApiFetch.mockResolvedValue(
      new Response(null, { status: 500 })
    );

    const result = await checkVersion();

    expect(result.match).toBe(false);
    expect(result.backend).toBeNull();
    expect(result.error).toContain("500");
  });

  it("网络错误时返回 match: true（不阻塞使用）", async () => {
    mockGetServerUrl.mockReturnValue("http://192.168.1.100:5173");
    mockApiFetch.mockRejectedValue(new TypeError("fetch failed"));

    const result = await checkVersion();

    expect(result.match).toBe(true);
    expect(result.backend).toBeNull();
  });

  it("调用 apiFetch 时传入 skipAuth=true", async () => {
    mockGetServerUrl.mockReturnValue("http://192.168.1.100:5173");
    mockApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ version: "2.1.8" }), { status: 200 })
    );

    await checkVersion();

    // 第三个参数是 skipAuth
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/api/version",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      true
    );
  });
});