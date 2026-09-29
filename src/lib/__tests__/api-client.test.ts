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
  getEffectiveServerUrl,
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


// ── detectAndSetServerUrl：选什么连什么（09-29 深夜改口径）──
//
// 旧口径是"裸 IP 双端口自动探测、两条都开着优先 HTTPS"，这一格把它整个换掉：
// 登录页现在有一枚「连接方式」选项，选了哪条就只探那一条。换的理由是真机读数——局域网机器没开 8443 是常态，
// 白撞一发要吃 2 秒（实测 ECONNREFUSED 2010ms，IP 打错更是 21 秒）。细则与判据在 api-client-server-scheme.test.ts。

describe("detectAndSetServerUrl 选什么连什么", () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.fetch = vi.fn();
  });

  it("裸 IP + 选 http：存 http:5173，只发一发", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 200 }));

    const r = await detectAndSetServerUrl("192.168.1.100", "http");

    expect(r.url).toBe("http://192.168.1.100:5173");
    expect(getServerUrl()).toBe("http://192.168.1.100:5173");
    expect(vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]))).toEqual([
      "http://192.168.1.100:5173/api/sync/check-user/test",
    ]);
  });

  it("裸 IP + 选 https：存 https:8443", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 200 }));

    const r = await detectAndSetServerUrl("192.168.1.100", "https");

    expect(r.url).toBe("https://192.168.1.100:8443");
    expect(getServerUrl()).toBe("https://192.168.1.100:8443");
  });

  it("不通也存所选那条，并把原因带回来（旧口径在这里会回落到 http 默认值）", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError("fetch failed"));

    const r = await detectAndSetServerUrl("192.168.1.100", "https");

    expect(r.url).toBe("https://192.168.1.100:8443");
    expect(getServerUrl()).toBe("https://192.168.1.100:8443");
    expect(r.ok).toBe(false);
    expect(r.reason).not.toBeNull();
  });

  it("显式协议以输入为准：选择器给 http 也存 https，并且现在要探这一发", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 200 }));

    const r = await detectAndSetServerUrl("https://192.168.1.100", "http");

    expect(r.url).toBe("https://192.168.1.100:8443");
    expect(getServerUrl()).toBe("https://192.168.1.100:8443");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("显式端口留住，协议仍由选择器决定", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 200 }));

    const r = await detectAndSetServerUrl("192.168.1.100:9000", "https");

    expect(r.url).toBe("https://192.168.1.100:9000");
  });

  it("空输入抛错", async () => {
    await expect(detectAndSetServerUrl("  ", "http")).rejects.toThrow("服务器地址不能为空");
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

describe("apiFetch 的总超时与调用方 signal 的关系（round 3 批次 D）", () => {
  beforeEach(() => {
    localStorage.clear();
    setServerUrl("https://192.168.1.100:8443");
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 }));
  });

  const sentSignal = () => (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]?.signal;

  it("不传 timeoutMs 时不强加超时（长请求由调用方自己管）", async () => {
    await apiFetch("/api/rag/progress");
    expect(sentSignal()).toBeUndefined();
  });

  it("传了 timeoutMs 就带上会真的 abort 的 signal", async () => {
    await apiFetch("/api/novels", { timeoutMs: 5 });
    const signal = sentSignal();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 25));
    expect(signal.aborted).toBe(true); // 到点必须真的中断，否则"总超时"是假的
  });

  it("调用方自带 signal 时不得被总超时顶掉——那是“停止”按钮的中断句柄", async () => {
    const ctrl = new AbortController();
    await apiFetch("/api/novels", { timeoutMs: 5, signal: ctrl.signal });
    expect(sentSignal()).toBe(ctrl.signal);
  });

  it("timeoutMs 不得混进 fetch 的 init 里", async () => {
    await apiFetch("/api/novels", { timeoutMs: 1000, method: "POST" });
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.timeoutMs).toBeUndefined();
    expect(init.method).toBe("POST");
  });
});

/**
 * `getEffectiveServerUrl` 是整条下载/代理链实际用的那只（`apiFetch`、`model-loader`、
 * `client-encoder`、`worker-client` 都从它拿地址），而**碰到它的测试历来全把它 mock 掉**
 * （`useSyncOrchestration-*`、`check-version`、`model-loader`、`client-encoder` 各 stub 一份），
 * 于是"这台设备到底该往哪儿发请求"这件事从没被直接答过。
 *
 * `apiFetch` 那两格已经间接走过"同源回退"与"Pages 不回退"，这里补的是它没走到的三条：
 * ① 显式配置优先（哪怕同源模式本来就可用，用户填了就得听他的）；② Pages 那条排除是
 * `.github.io` **和** `.github.com` 两支；③ 判的是**后缀**而不是"名字里含 github.io"。
 * 第四支 `typeof window === "undefined"` 在 jsdom 里永远走不到（这仓没有 SSR），
 * 判它等于判桩，不写。
 */
describe("getEffectiveServerUrl 的三档决定", () => {
  const KEY = "server-url";
  const withHost = (hostname: string, origin: string, fn: () => void) => {
    const original = window.location;
    vi.stubGlobal("window", { ...window, location: { ...original, hostname, origin } });
    try { fn(); } finally { vi.unstubAllGlobals(); }
  };

  beforeEach(() => { localStorage.clear(); });

  it("填过服务器就以它为准：同源模式明明可用也不许被当前源顶掉", () => {
    localStorage.setItem(KEY, "https://nas.example.com:8443");
    withHost("reader.example.com", "https://reader.example.com", () => {
      expect(getEffectiveServerUrl()).toBe("https://nas.example.com:8443");
    });
  });

  it("Pages 那两条排除都在：只留 .github.io 的话，pages.github.com 那台会偷偷打自己", () => {
    withHost("someone.github.com", "https://someone.github.com", () => {
      expect(getEffectiveServerUrl(), "没配置时 Pages 域名要留在离线模式").toBe("");
    });
    withHost("someone.github.io", "https://someone.github.io", () => {
      expect(getEffectiveServerUrl()).toBe("");
    });
  });

  it("判的是后缀：自托管域名里带「github.io」字样也算不上 Pages，同源回退还得在", () => {
    // 样本刻意选 endsWith 与 includes 结论不同的那个——`mygithub.io` 结尾并不是 `.github.io`
    withHost("mygithub.io", "https://mygithub.io", () => {
      expect(getEffectiveServerUrl(), "这是用户自己的机器，不该被当成 Pages").toBe("https://mygithub.io");
    });
  });

  it("同源部署（局域网里后端伺服页面）未配置时回退当前源", () => {
    withHost("192.168.1.7", "http://192.168.1.7:8443", () => {
      expect(getEffectiveServerUrl()).toBe("http://192.168.1.7:8443");
    });
  });

  // 刻意不写"配置是空串时也算没配置"那一格：`src/test/setup.ts` 的 localStorage 桩里
  // `getItem` 把 `""` 归成 `null`，空串与"根本没这条"在这个夹具里不可区分——
  // 写出来无论产品怎么改都会绿，属于凑数判据。
});