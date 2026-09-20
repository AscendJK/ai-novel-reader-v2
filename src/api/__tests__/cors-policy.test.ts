/**
 * CORS 来源判定（批次 G / server/index.js 抽出的 cors-policy.mjs）
 *
 * 这条判据错一次的表现是"前端换了个访问方式就全线失败"——AI、同步、朗读一起没，
 * 而报错只在浏览器控制台里。项目的访问模型是"局域网内无密码 + 公网来源不放过"，
 * 两个方向都要钉：放过得够（局域网、Pages、开发端口），也拦得住（公网、以及拿局域网
 * 字样做后缀混淆的来源）。
 */
import { describe, it, expect } from "vitest";

// @ts-expect-error - 后端 JS 模块无类型声明
const policy = await import("../../../server/lib/cors-policy.mjs");
const { isOriginAllowed, extraAllowedOrigins, STATIC_ALLOWED_ORIGINS } = policy as {
  isOriginAllowed: (origin: string | undefined, envOrigins?: string[]) => boolean;
  extraAllowedOrigins: (envValue: unknown) => string[];
  STATIC_ALLOWED_ORIGINS: string[];
};

describe("该放过的来源必须放过", () => {
  it("无 Origin（同源请求、curl、原生 App）一律放过", () => {
    expect(isOriginAllowed(undefined)).toBe(true);
    expect(isOriginAllowed("")).toBe(true);
  });

  it("开发端口与本机 https 在清单里", () => {
    for (const o of ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "https://localhost", "https://127.0.0.1"]) {
      expect(isOriginAllowed(o), o).toBe(true);
    }
  });

  it("GitHub Pages 托管前端能直连后端", () => {
    expect(isOriginAllowed("https://ascendjk.github.io")).toBe(true);
  });

  it("局域网与私有段（含任意端口）放过——这是既定的无密码访问模型", () => {
    for (const o of [
      "http://192.168.1.100:8443", "http://192.168.1.1:5173", "https://192.168.0.7",
      "http://10.0.0.7:8080", "http://172.16.0.1:8443", "http://172.31.255.255",
      "http://localhost:8443", "http://127.0.0.1:9999",
    ]) {
      expect(isOriginAllowed(o), o).toBe(true);
    }
  });

  it("用户在 CORS_ORIGINS 里配的域名生效，带空格的条目也生效", () => {
    const extra = extraAllowedOrigins("https://read.myhome.net, https://nas.lan:8443");
    expect(extra).toEqual(["https://read.myhome.net", "https://nas.lan:8443"]);
    expect(isOriginAllowed("https://read.myhome.net", extra)).toBe(true);
    expect(isOriginAllowed("https://other.example", extra)).toBe(false);
  });

  it("CORS_ORIGINS 未设置时不产生空条目（空串会放过 Origin: \"\"）", () => {
    expect(extraAllowedOrigins(undefined)).toEqual([]);
    expect(extraAllowedOrigins("  ")).toEqual([]);
    expect(extraAllowedOrigins("a.com,,b.com")).toEqual(["a.com", "b.com"]);
  });
});

describe("该拦住的来源必须拦住", () => {
  it("公网域名不放过——后端会替前端去访问用户配的厂商地址", () => {
    for (const o of ["https://evil.example.com", "http://8.8.8.8", "https://example.org:443"]) {
      expect(isOriginAllowed(o), o).toBe(false);
    }
  });

  it("拿局域网字样做后缀混淆的域名不放过", () => {
    for (const o of [
      "http://192.168.1.1.evil.com",
      "http://10.0.0.1.evil.com",
      "http://localhost.evil.com",
      "http://127.0.0.1.evil.com:8443",
      "https://ascendjk.github.io.attacker.net",
    ]) {
      expect(isOriginAllowed(o), o).toBe(false);
    }
  });

  it("把本机地址写进 userinfo 的 URL 不放过（真实主机是 evil.com）", () => {
    expect(isOriginAllowed("http://127.0.0.1:5173@evil.com")).toBe(false);
    expect(isOriginAllowed("http://localhost@evil.com")).toBe(false);
  });

  it("Origin 带路径或尾部斜杠时不放过（Origin 头本来就不含这些）", () => {
    expect(isOriginAllowed("http://127.0.0.1:5173/evil")).toBe(false);
    expect(isOriginAllowed("http://192.168.1.5/")).toBe(false);
  });

  it("172 段的私有范围边界是 16-31，不是全体 172", () => {
    expect(isOriginAllowed("http://172.15.0.1")).toBe(false);
    expect(isOriginAllowed("http://172.32.0.1")).toBe(false);
    expect(isOriginAllowed("http://172.16.0.1")).toBe(true);
    expect(isOriginAllowed("http://172.31.0.1")).toBe(true);
  });

  it("192.168 只放过完整四段", () => {
    expect(isOriginAllowed("http://192.168.1")).toBe(false);
    expect(isOriginAllowed("http://192.168.1.1.1")).toBe(false);
  });

  it("协议前缀不能省，也不能是别的协议", () => {
    expect(isOriginAllowed("192.168.1.5:8443")).toBe(false);
    expect(isOriginAllowed("ftp://192.168.1.5")).toBe(false);
    expect(isOriginAllowed("httpx://192.168.1.5")).toBe(false);
  });

  it("固定清单里没有通配项（放开成 * 就是把这个口子整个开掉）", () => {
    expect(STATIC_ALLOWED_ORIGINS).not.toContain("*");
    expect(STATIC_ALLOWED_ORIGINS.every((o) => /^https?:\/\/[^/*]+$/.test(o))).toBe(true);
  });
});
