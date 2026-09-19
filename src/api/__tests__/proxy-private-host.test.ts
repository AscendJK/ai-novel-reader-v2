/**
 * 代理目标"是否私网"的判定测试（round 3 R-74）
 *
 * 这条判定决定两件事：① `http://` 是否放行（外部必须 HTTPS）；② DNS 重绑定复核
 * 是否跳过（原判私网就不再看解析结果）。旧实现用 `hostname.startsWith("fd"|"fc"|"fe80")`
 * 对**任意主机名**生效，于是 `fdn.example.com` 这类普通公网域名被当成内网：
 * 既能明文打出去，也能在解析到 127.0.0.1 时躲过复核。IPv6 的前缀规则必须只作用在
 * 真正的 IPv6 字面量上。
 */
import { describe, it, expect } from "vitest";

// 同 sync-handler.test.ts：先固定 DB 路径，避免 import 链摸到 server/data 下的真库
(globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env!.NOVEL_READER_DB_PATH = ":memory:";
// @ts-expect-error - 后端 JS 模块无类型声明
const proxy = await import("../../../server/routes/proxy.js");

const isPrivateHost = (proxy as { isPrivateHost?: (h: string) => boolean }).isPrivateHost;
if (typeof isPrivateHost !== "function") {
  throw new Error("server/routes/proxy.js 未导出 isPrivateHost——判定逻辑又被塞回处理函数里了");
}

describe("代理私网判定：域名不得靠字符串前缀冒充内网", () => {
  it("以 fd/fc/fe80 开头的公网域名算公网", () => {
    expect(isPrivateHost("fdn.example.com")).toBe(false);
    expect(isPrivateHost("fc2.qcloud.com")).toBe(false);
    expect(isPrivateHost("fe80-io.example.com")).toBe(false);
    expect(isPrivateHost("fdsa.github.io")).toBe(false);
  });

  it("普通域名一律按公网处理（由解析结果决定能不能明文）", () => {
    expect(isPrivateHost("api.openai.com")).toBe(false);
    expect(isPrivateHost("nas.local")).toBe(false);
    expect(isPrivateHost("8.8.8.8.example.com")).toBe(false);
  });

  it("IPv4 私网/回环/链路本地/CGNAT 仍判私网", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("10.0.0.7")).toBe(true);
    expect(isPrivateHost("192.168.1.20")).toBe(true);
    expect(isPrivateHost("172.16.5.5")).toBe(true);
    expect(isPrivateHost("169.254.169.254")).toBe(true);
    expect(isPrivateHost("100.64.0.1")).toBe(true);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("172.20.0.1")).toBe(true);
    expect(isPrivateHost("173.0.0.1")).toBe(false);
  });

  it("IPv6 字面量：ULA / 链路本地 / 回环判私网，可路由地址判公网", () => {
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("[::1]")).toBe(true);
    expect(isPrivateHost("::")).toBe(true);
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("fc00::1")).toBe(true);
    expect(isPrivateHost("[fd12:3456:7890::1]")).toBe(true);
    expect(isPrivateHost("fe80::1")).toBe(true);
    expect(isPrivateHost("febf::1")).toBe(true);
    // 重绑定复核要把解析结果也过一遍，这些范围不能漏
    expect(isPrivateHost("fec0::1")).toBe(false);
    expect(isPrivateHost("2001:db8::1")).toBe(false);
    expect(isPrivateHost("2606:4700:4700::1111")).toBe(false);
  });

  it("IPv4-mapped IPv6 要先还原再判，不得被前缀绕过", () => {
    expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateHost("::ffff:8.8.8.8")).toBe(false);
  });
});
