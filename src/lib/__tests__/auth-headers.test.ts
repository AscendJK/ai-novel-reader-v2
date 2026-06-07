/**
 * auth-headers 测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { authHeaders } from "../auth-headers";

describe("authHeaders", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("应该返回 Content-Type 头（没有 token）", () => {
    const headers = authHeaders();
    expect(headers).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("应该返回 Authorization 头（有 token）", () => {
    localStorage.setItem("sync-token", "test-token-123");
    const headers = authHeaders();
    expect(headers).toEqual({
      Authorization: "Bearer test-token-123",
      "Content-Type": "application/json",
    });
  });

  it("应该包含 Bearer 前缀", () => {
    localStorage.setItem("sync-token", "my-token");
    const headers = authHeaders();
    expect(headers.Authorization).toBe("Bearer my-token");
  });

  it("应该始终包含 Content-Type", () => {
    const headers1 = authHeaders();
    expect(headers1["Content-Type"]).toBe("application/json");

    localStorage.setItem("sync-token", "token");
    const headers2 = authHeaders();
    expect(headers2["Content-Type"]).toBe("application/json");
  });

  it("应该处理空 token", () => {
    localStorage.setItem("sync-token", "");
    const headers = authHeaders();
    // 空字符串是 falsy，所以不应该有 Authorization 头
    expect(headers).toEqual({
      "Content-Type": "application/json",
    });
  });
});
