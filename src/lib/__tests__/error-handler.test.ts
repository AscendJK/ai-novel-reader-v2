/**
 * error-handler 测试
 * 全部是纯函数，无需 mock
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AppError,
  normalizeError,
  handleError,
  safeAsync,
  safeSync,
  getUserFriendlyMessage,
  reportError,
} from "../error-handler";

// ── AppError 类 ──

describe("AppError", () => {
  it("构造默认错误（code=UNKNOWN, severity=medium）", () => {
    const err = new AppError("出错了");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AppError");
    expect(err.message).toBe("出错了");
    expect(err.code).toBe("UNKNOWN");
    expect(err.severity).toBe("medium");
    expect(err.context).toBeUndefined();
  });

  it("构造指定 code 和 severity", () => {
    const err = new AppError("网络错误", "NETWORK", "high");
    expect(err.code).toBe("NETWORK");
    expect(err.severity).toBe("high");
  });

  it("构造带 context 的错误", () => {
    const ctx = { statusCode: 401, path: "/api/test" };
    const err = new AppError("认证失败", "AUTH", "high", ctx);
    expect(err.context).toEqual(ctx);
  });
});

// ── normalizeError ──

describe("normalizeError", () => {
  it("已存在的 AppError 直接返回", () => {
    const original = new AppError("test", "NETWORK", "high");
    const result = normalizeError(original);
    expect(result).toBe(original);
  });

  it("APIError（name 为 APIError）映射到正确 code", () => {
    const apiErr = new Error("invalid key") as Error & { code?: string; statusCode?: number };
    apiErr.name = "APIError";
    apiErr.code = "auth";
    const result = normalizeError(apiErr);
    expect(result.code).toBe("AUTH");
    expect(result.severity).toBe("high");
    expect(result.context?.apiCode).toBe("auth");
  });

  it("APIError 未知 code 映射到 API_ERROR", () => {
    const apiErr = new Error("weird") as Error & { code?: string };
    apiErr.name = "APIError";
    apiErr.code = "some_unknown_code";
    const result = normalizeError(apiErr);
    expect(result.code).toBe("API_ERROR");
    expect(result.severity).toBe("medium");
  });

  it("AbortError 映射到 code=ABORTED, severity=low", () => {
    const abortErr = new DOMException("The operation was aborted", "AbortError");
    // 模拟 Error 实例
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    const result = normalizeError(err);
    expect(result.code).toBe("ABORTED");
    expect(result.severity).toBe("low");
  });

  it("网络错误（fetch 关键词）映射到 code=NETWORK", () => {
    const err = new Error("fetch failed: network timeout");
    const result = normalizeError(err);
    expect(result.code).toBe("NETWORK");
    expect(result.severity).toBe("medium");
  });

  it("网络错误（network 关键词）映射到 code=NETWORK", () => {
    const err = new Error("network error: connection refused");
    const result = normalizeError(err);
    expect(result.code).toBe("NETWORK");
  });

  it("普通 Error 映射到 code=UNKNOWN", () => {
    const err = new Error("something went wrong");
    const result = normalizeError(err);
    expect(result.code).toBe("UNKNOWN");
    expect(result.message).toBe("something went wrong");
  });

  it("字符串错误映射到 code=UNKNOWN", () => {
    const result = normalizeError("手动抛出的错误");
    expect(result.code).toBe("UNKNOWN");
    expect(result.message).toBe("手动抛出的错误");
  });

  it("null 不报错", () => {
    const result = normalizeError(null);
    expect(result.code).toBe("UNKNOWN");
  });

  it("undefined 不报错", () => {
    const result = normalizeError(undefined);
    expect(result.code).toBe("UNKNOWN");
  });

  it("number 映射到 code=UNKNOWN", () => {
    const result = normalizeError(42);
    expect(result.code).toBe("UNKNOWN");
    expect(result.message).toBe("42");
  });
});

// ── getUserFriendlyMessage ──

describe("getUserFriendlyMessage", () => {
  const testCases: [string, string, string][] = [
    ["NETWORK", "网络连接失败，请检查网络设置"],
    ["AUTH", "认证失败，请检查 API Key 是否正确"],
    ["DATABASE", "数据访问失败，请刷新页面重试"],
    ["VALIDATION", "输入数据无效，请检查后重试"],
    ["TIMEOUT", "请求超时，请稍后重试"],
    ["ABORTED", "操作已取消"],
    ["API_ERROR", "API 调用失败，请检查配置"],
    ["SYNC_ERROR", "同步失败，请检查网络连接"],
    ["PARSER_ERROR", "数据解析失败，请检查文件格式"],
    ["RATE_LIMIT", "请求频率过高，请稍后重试"],
    ["QUOTA_EXCEEDED", "API 额度已用尽，请充值或等待重置"],
    ["CONTEXT_LENGTH", "请求内容超过模型上下文长度限制"],
    ["SERVER_ERROR", "API 服务器错误，请稍后重试"],
  ];

  for (const [code, expected] of testCases) {
    it(`ErrorCode ${code} 返回正确消息`, () => {
      const err = new AppError("ignored", code as any);
      expect(getUserFriendlyMessage(err)).toBe(expected);
    });
  }

  it("UNKNOWN 返回 message 或默认消息", () => {
    const err = new AppError("自定义错误", "UNKNOWN");
    expect(getUserFriendlyMessage(err)).toBe("自定义错误");
  });
});

// ── handleError ──

describe("handleError", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  it("critical 级别调用 console.error", () => {
    const err = new AppError("严重错误", "UNKNOWN", "critical");
    handleError(err, "测试上下文");
    expect(console.error).toHaveBeenCalled();
  });

  it("high 级别调用 console.error", () => {
    const err = new AppError("高危错误", "AUTH", "high");
    handleError(err, "认证");
    expect(console.error).toHaveBeenCalled();
  });

  it("medium 级别调用 console.warn", () => {
    const err = new AppError("中等错误", "NETWORK", "medium");
    handleError(err, "网络");
    expect(console.warn).toHaveBeenCalled();
  });

  it("low 级别调用 console.debug", () => {
    const err = new AppError("轻微错误", "ABORTED", "low");
    handleError(err, "取消");
    expect(console.debug).toHaveBeenCalled();
  });

  it("silent=false 时抛出错误", () => {
    const err = new AppError("要抛出的错误", "VALIDATION", "medium");
    expect(() => handleError(err, "验证", false)).toThrow("要抛出的错误");
  });

  it("silent=true（默认）时不抛出", () => {
    const err = new AppError("静默错误", "UNKNOWN", "low");
    expect(() => handleError(err, "静默")).not.toThrow();
  });

  it("返回 AppError 实例", () => {
    const err = new AppError("测试", "UNKNOWN", "low");
    const result = handleError(err, "测试");
    expect(result).toBeInstanceOf(AppError);
    expect(result.message).toBe("测试");
  });
});

// ── safeAsync ──

describe("safeAsync", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("成功时返回结果", async () => {
    const result = await safeAsync(() => Promise.resolve(42), "测试");
    expect(result).toBe(42);
  });

  it("失败时返回 fallback 值", async () => {
    const result = await safeAsync(
      () => Promise.reject(new Error("失败")),
      "测试",
      "默认值"
    );
    expect(result).toBe("默认值");
  });

  it("失败时无 fallback 返回 undefined", async () => {
    const result = await safeAsync(
      () => Promise.reject(new Error("失败")),
      "测试"
    );
    expect(result).toBeUndefined();
  });
});

// ── safeSync ──

describe("safeSync", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("成功时返回结果", () => {
    const result = safeSync(() => 42, "测试");
    expect(result).toBe(42);
  });

  it("失败时返回 fallback 值", () => {
    const result = safeSync(
      () => { throw new Error("失败"); },
      "测试",
      "默认值"
    );
    expect(result).toBe("默认值");
  });

  it("失败时无 fallback 返回 undefined", () => {
    const result = safeSync(
      () => { throw new Error("失败"); },
      "测试"
    );
    expect(result).toBeUndefined();
  });
});

// ── reportError ──

describe("reportError", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  it("调用 console.debug", () => {
    const err = new AppError("test", "NETWORK", "high");
    reportError(err);
    expect(console.debug).toHaveBeenCalledWith(
      "[ErrorReporter]",
      "NETWORK",
      "test"
    );
  });
});