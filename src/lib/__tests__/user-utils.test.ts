/**
 * user-utils 测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { userKey, getCurrentUsername, isLoggedIn } from "../user-utils";

describe("userKey", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("没有登录时返回原始 key", () => {
    expect(userKey("novel-reader-positions")).toBe("novel-reader-positions");
  });

  it("登录后返回带用户名的 key", () => {
    localStorage.setItem("sync-username", "testuser");
    expect(userKey("novel-reader-positions")).toBe("novel-reader-positions:testuser");
  });

  it("不同用户返回不同的 key", () => {
    localStorage.setItem("sync-username", "user1");
    expect(userKey("positions")).toBe("positions:user1");

    localStorage.setItem("sync-username", "user2");
    expect(userKey("positions")).toBe("positions:user2");
  });
});

describe("getCurrentUsername", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("没有登录时返回 null", () => {
    expect(getCurrentUsername()).toBeNull();
  });

  it("登录后返回用户名", () => {
    localStorage.setItem("sync-username", "testuser");
    expect(getCurrentUsername()).toBe("testuser");
  });
});

describe("isLoggedIn", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("没有登录时返回 false", () => {
    expect(isLoggedIn()).toBe(false);
  });

  it("登录后返回 true", () => {
    localStorage.setItem("sync-username", "testuser");
    expect(isLoggedIn()).toBe(true);
  });
});
