/**
 * 登录页那句「无法连接到服务器，请检查地址是否正确」把四件事压成了一句（方案 A，制作人 09-29 拍）。
 * 这一档只钉**浏览器里真能确定**的那几格，剩下的一律归到那句总括：
 *
 *  1. 后端**有回应**但状态码不是 200/404 —— 那就不是"连不上"，更不该让人去改地址；
 *  2. **混合内容**：只有 HTTPS 页面打**公网**的 HTTP 目标才算这一类。09-29 深夜在
 *     `https://ascendjk.github.io` 里真浏览器量死：`http://example.com/` **0～1 毫秒** TypeError（出门前就拦），
 *     而 `http://192.168.1.10:5173` 在 4 毫秒拿到 **HTTP 200**、`http://192.168.1.99:5173` 走了 21 秒得
 *     `ERR_CONNECTION_TIMED_OUT` —— **本机/局域网的明文不按混合内容处理**，那一路上管它的是第 3 类那道授权。
 *     （这里更正一处旧假话：本文件曾写"局域网 HTTP 2 毫秒被混合内容拦死"，那是把公网那一格的读数安到了局域网头上。）
 *  3. **「本地网络访问」权限是被拒状态**（Chrome/Edge 现在用权限提示，不再是 `Access-Control-Allow-Private-Network` 那个头；
 *     09-29 深夜制作人在真 Chrome 上量到提示并点了允许——第一次失败、允许之后同一网站不再问且直连成功）；
 *  4. 我们自己的 **5 秒**到点（`AbortController`，不是网络报错）；
 *  5. 以上都不是 → 老实说"连不上"，并把**证书不认**一起报出来（js 里分不出"端口没人听"与"证书不被信任"，不许假分）。
 *
 * 顺序本身也要判住：本地目标**永远不许**报成混合内容（那是把浏览器当幌子，真实原因多半是端口没人听）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { probeServer, PROBE_FAILURE_TEXT } from "@/lib/api-client";

const PROBE_PATH = "/api/sync/check-user/test";

/** 把页面伪装成安全上下文（`window.isSecureContext` 是产品读的那个信号） */
function setSecureContext(value: boolean) {
  Object.defineProperty(window, "isSecureContext", { value, configurable: true });
}

function setPermissionState(state: string | null) {
  if (state === null) {
    // 老浏览器：navigator.permissions 根本没有 query，或查询这个名字直接 reject
    Object.defineProperty(navigator, "permissions", {
      value: { query: () => Promise.reject(new Error("not supported")) },
      configurable: true,
    });
    return;
  }
  Object.defineProperty(navigator, "permissions", {
    value: { query: vi.fn(() => Promise.resolve({ state })) },
    configurable: true,
  });
}

beforeEach(() => {
  setSecureContext(true);
  setPermissionState("prompt");
  globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PR1 后端有回应 ≠ 连不上", () => {
  it("状态码 500 → 原因是 http-status，不是「地址不对」那一类", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 500 }));
    const r = await probeServer("https://192.168.1.10:8443");
    expect(r.ok).toBe(false);
    expect(r.reason, "后端答了话只是没答对：这一格不能混进「连不上」").toBe("http-status");
  });

  it("对照：200 与 404 都算活着，而且没有原因", async () => {
    for (const status of [200, 404]) {
      globalThis.fetch = vi.fn(async () => new Response(null, { status }));
      const r = await probeServer("https://192.168.1.10:8443");
      expect(r, `${status} 必须算可达`).toEqual({ ok: true, reason: null });
    }
  });
});

describe("PR2 混合内容那一格（只有 HTTPS 页面 → 公网 HTTP 才算）", () => {
  it("https 页面打公网明文 http://example.com 失败 → mixed-content（这一格浏览器确实是出门前就拦）", async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const r = await probeServer("http://example.com");
    expect(r.reason).toBe("mixed-content");
  });

  it("本机/局域网的明文**永远不许**报混合内容——那一路真实原因多半是端口没人听", async () => {
    const localTargets = [
      "http://192.168.1.10:5173",   // 09-29 深夜真机：https 页里这发拿到过 HTTP 200
      "http://192.168.1.99:5173",   // 同页另一发走了 21 秒 ERR_CONNECTION_TIMED_OUT：出网了，没被策略拦
      "http://10.0.0.5:5173",
      "http://172.20.8.9:5173",
      "http://169.254.7.7:5173",
      "http://mybook.local:5173",
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      "http://[::1]:5173",
    ];
    for (const target of localTargets) {
      globalThis.fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
      const r = await probeServer(target);
      expect(r.reason, `${target} 是本地地址，不许甩锅给混合内容`).not.toBe("mixed-content");
      expect(r.reason).toBe("unreachable");
    }
  });

  it("172.16 与 172.31 之间的私有段算本地；172.32 与 173.16 这种公网冒充形状不算", async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    expect((await probeServer("http://172.16.0.1:5173")).reason).not.toBe("mixed-content");
    expect((await probeServer("http://172.31.255.254:5173")).reason).not.toBe("mixed-content");
    expect((await probeServer("http://172.32.0.1:5173")).reason).toBe("mixed-content");
    expect((await probeServer("http://173.16.0.1:5173")).reason).toBe("mixed-content");
  });

  it("页面本身不是安全上下文（本机 http 开着用）→ 一律不许报混合内容", async () => {
    setSecureContext(false);
    globalThis.fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const r = await probeServer("http://192.168.1.10:5173");
    expect(r.reason).not.toBe("mixed-content");
  });

  it("https 后端失败跟协议无关 → 不许报成 mixed-content", async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const r = await probeServer("https://192.168.1.10:8443");
    expect(r.reason).toBe("unreachable");
  });
});

describe("PR3 「本地网络访问」被拒那一格", () => {
  it("权限状态 denied + 目标是本机/局域网地址 → local-network-blocked", async () => {
    setPermissionState("denied");
    globalThis.fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const r = await probeServer("https://192.168.1.10:8443");
    expect(r.reason).toBe("local-network-blocked");
  });

  it("granted 与 prompt 都不是证据 → 不许凭空说「浏览器拦住了」", async () => {
    for (const state of ["granted", "prompt"]) {
      setPermissionState(state);
      globalThis.fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
      const r = await probeServer("https://192.168.1.10:8443");
      expect(r.reason, `权限状态 ${state} 说明不了任何事`).toBe("unreachable");
    }
  });

  it("老浏览器查不到这个权限名 → 不许把「查不到」当成「被拒」", async () => {
    setPermissionState(null);
    globalThis.fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const r = await probeServer("https://192.168.1.10:8443");
    expect(r.reason).toBe("unreachable");
  });

  it("目标不是本机地址（公网后端）→ 连权限都不该去查", async () => {
    const query = vi.fn(() => Promise.resolve({ state: "denied" }));
    Object.defineProperty(navigator, "permissions", { value: { query }, configurable: true });
    globalThis.fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const r = await probeServer("https://example.invalid:8443");
    expect(query, "公网地址的失败与本地网络权限无关").not.toHaveBeenCalled();
    expect(r.reason).toBe("unreachable");
  });

  it("本地明文目标 + 权限被拒 → 报「被拦住」，不许报混合内容（制作人 09-29 真机点允许那一条的形状）", async () => {
    setPermissionState("denied");
    globalThis.fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const r = await probeServer("http://192.168.1.10:5173");
    expect(r.reason).toBe("local-network-blocked");
  });

  it("公网明文目标 → 这一格轮不到权限去解释（不查权限，直接报混合内容）", async () => {
    const query = vi.fn(() => Promise.resolve({ state: "denied" }));
    Object.defineProperty(navigator, "permissions", { value: { query }, configurable: true });
    globalThis.fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const r = await probeServer("http://book.example.org:8080");
    expect(query, "公网目标出不了混合内容那一格，权限状态解释不了它").not.toHaveBeenCalled();
    expect(r.reason).toBe("mixed-content");
  });
});

describe("PR4 我们自己那 5 秒到点", () => {
  it("fetch 挂着不动、5 秒后被我们自己的 AbortController 掐掉 → timeout", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      (...args: Parameters<typeof fetch>) =>
        new Promise<Response>((_resolve, reject) => {
          args[1]?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const pending = probeServer("https://192.168.1.10:8443");
    await vi.advanceTimersByTimeAsync(5_000);
    const r = await pending;
    expect(r.reason, "到点是我们自己掐的，说的是「没回应」而不是「连不上」").toBe("timeout");
  });
});

describe("PR5 文案与类别同源，且五类各说各话", () => {
  const reasons = ["http-status", "mixed-content", "local-network-blocked", "timeout", "unreachable"] as const;

  it("每一类都有自己的 badge 与 note（不许五类其实是同一句话）", () => {
    const notes = reasons.map((r) => PROBE_FAILURE_TEXT[r].note);
    const badges = reasons.map((r) => PROBE_FAILURE_TEXT[r].badge);
    expect(new Set(notes).size, `note 有两类撞了同一句：${notes.join(" ｜ ")}`).toBe(reasons.length);
    expect(new Set(badges).size).toBe(reasons.length);
    for (const r of reasons) {
      expect(PROBE_FAILURE_TEXT[r].note.length, `${r} 的 note 短到没说清`).toBeGreaterThan(10);
    }
  });

  it("被拒那一类必须同时给「怎么放开」和「若已放开则另有原因」两条路", () => {
    const note = PROBE_FAILURE_TEXT["local-network-blocked"].note;
    expect(note).toContain("本地网络");
    expect(note, "只说被拦住、不说下一步，等于把用户堵在原地").toMatch(/允许/);
    expect(note, "权限被拒也可能是环境默认值，不许把话说死").toMatch(/端口|后端/);
  });

  it("混合内容那一类必须说清是「公网明文」并给出可执行的那一句（改用 https）", () => {
    const note = PROBE_FAILURE_TEXT["mixed-content"].note;
    expect(note).toMatch(/https:\/\//);
    expect(note, "这一类现在只管公网目标，话里必须点明，否则局域网用户会被指去配 8443").toContain("公网");
  });

  it("「被拦住」那一类要告诉用户这份授权记在网站身上、只点一次", () => {
    const note = PROBE_FAILURE_TEXT["local-network-blocked"].note;
    expect(note, "不说清授权的落点，用户会以为每填一个地址都要点一次").toMatch(/这(一|个)站|这个网站/);
    expect(note).toMatch(/一(次|下)/);
  });

  it("总括那一类不许再假指唯一的错因（证书不认也在里面）", () => {
    const note = PROBE_FAILURE_TEXT["unreachable"].note;
    expect(note).not.toContain("请检查地址是否正确");
    expect(note, "「Failed to fetch」分不出端口没人听与证书不认，必须一起报").toContain("证书");
  });

  it("探测路径照旧：规范化后的地址 + /api/sync/check-user/test", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (...args: Parameters<typeof fetch>) => {
      seen.push(String(args[0]));
      return new Response(null, { status: 200 });
    });
    await probeServer("192.168.1.100:5173");
    expect(seen).toEqual([`http://192.168.1.100:5173${PROBE_PATH}`]);
  });
});
