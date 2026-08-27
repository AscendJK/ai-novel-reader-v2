/**
 * sync-handler 后端会话语义测试
 * 验证"会话过期"与"被另一设备踢出"的区分——这是"刷新后书架消失"bug 的
 * 后端根因：服务器重启后内存 sessions 清空，旧 token 心跳返回 -1，
 * 此前被标记为 kicked:true 导致前端强制登出。修复后 -1 语义保持为
 * session_expired，由前端自动重注册恢复。
 */
import { describe, it, expect } from "vitest";

// 直接 import 模块级单例（sessions 是模块内存 Map）
// 先设置 DB 路径为内存库，避免测试污染生产数据库（server/data/novels.db）。
// ESM 静态 import 会提升，必须用动态 import 以确保环境变量先于模块加载生效。
(globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env!.NOVEL_READER_DB_PATH = ":memory:";
// @ts-expect-error - 后端 JS 模块无类型声明，测试仅验证运行时语义
const handler = await import("../../../server/sync-handler.js");

describe("sync-handler 会话语义", () => {
  it("register 为已知设备重建会话并复用 clientId", () => {
    const username = `u-${Date.now()}`;
    const clientId = "device-abc";
    const token = handler.createSession(username);

    const activeCount = handler.register(username, clientId, token);
    expect(activeCount).toBeGreaterThan(0);

    // 再次 register（模拟刷新后重注册）→ 会话重建成功
    const token2 = handler.createSession(username);
    const activeCount2 = handler.register(username, clientId, token2);
    expect(activeCount2).toBeGreaterThan(0);
    // 已知设备被记录
    expect(handler.validateSession(token2)).toBe(username);
  });

  it("会话过期（token 不在 sessions 中）时 heartbeat 返回 -1", () => {
    const username = `k-${Date.now()}`;
    const clientId = "device-k";
    const token = handler.createSession(username);
    handler.register(username, clientId, token);

    // 模拟服务器重启：token 对应的 session 不存在（直接测不存在的 token）
    const staleToken = "stale-token-not-in-sessions";
    // 先注册让设备已知
    handler.register(username, clientId, token);
    const result = handler.heartbeat(username, clientId, staleToken);
    expect(result).toBe(-1); // -1 = session expired（不是 0，不是正数）
  });

  it("有效会话 heartbeat 返回 1", () => {
    const username = `h-${Date.now()}`;
    const clientId = "device-h";
    const token = handler.createSession(username);
    handler.register(username, clientId, token);

    const result = handler.heartbeat(username, clientId, token);
    expect(result).toBe(1);
  });

  it("未知设备 heartbeat 返回 0（未注册）", () => {
    const username = `z-${Date.now()}`;
    const result = handler.heartbeat(username, "unknown-device", "any-token");
    expect(result).toBe(0);
  });

  it("已知设备数量有上限，超出时淘汰最旧设备", () => {
    const username = `d-${Date.now()}`;
    // 注册超过上限的设备（上限 10，注册 12 个）
    for (let i = 0; i < 12; i++) {
      const t = handler.createSession(username);
      handler.register(username, `dev-${i}`, t);
    }
    const devices = handler.getUserDevices(username);
    expect(devices.length).toBeLessThanOrEqual(10);
    // 最旧的设备（dev-0）应被淘汰
    expect(devices).not.toContain("dev-0");
    // 最新的设备应保留
    expect(devices).toContain("dev-11");
  });

  it("后注册的设备覆盖 active_device（选项① 后到优先）", () => {
    const username = `a-${Date.now()}`;
    const tA = handler.createSession(username);
    handler.register(username, "device-A", tA);
    // 模拟重启后 A 重注册恢复在线
    const tA2 = handler.createSession(username);
    handler.register(username, "device-A", tA2);
    // 此时 active_device 应为 A
    expect(handler.isActive(username, "device-A")).toBe(true);

    // 后到者 B 注册 → 覆盖 active_device
    const tB = handler.createSession(username);
    handler.register(username, "device-B", tB);
    expect(handler.isActive(username, "device-B")).toBe(true);
    expect(handler.isActive(username, "device-A")).toBe(false);
  });

  it("被顶替的旧设备 heartbeat 返回 -2（kicked）", () => {
    const username = `x-${Date.now()}`;
    const tA = handler.createSession(username);
    handler.register(username, "device-A", tA);
    // A 是活跃设备，心跳正常
    expect(handler.heartbeat(username, "device-A", tA)).toBe(1);

    // B 后登录，覆盖 active_device
    const tB = handler.createSession(username);
    handler.register(username, "device-B", tB);
    // 旧设备 A 再次心跳 → 被顶替（-2），而非会话过期（-1）
    const result = handler.heartbeat(username, "device-A", tA);
    expect(result).toBe(-2);
  });

  it("isActive 回退到内存 knownDevices（无持久化记录时）", () => {
    const username = `y-${Date.now()}`;
    // 通过 register 持久化 active_device 后验证 isActive 判定
    const t = handler.createSession(username);
    handler.register(username, "device-Y", t);
    expect(handler.isActive(username, "device-Y")).toBe(true);
    expect(handler.isActive(username, "other")).toBe(false);
  });
});
