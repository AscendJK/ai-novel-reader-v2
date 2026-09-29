/**
 * 「连接方式」这一格的逻辑（制作人 09-29 深夜原话「加一个选项，选择什么就连什么，然后选项的默认方式是 http」）。
 *
 * 这一档把旧的"裸 IP 双端口自动探测"整个换掉，因此**明确推翻**一条旧判据：
 * `api-client.test.ts` 里那句「双端口在线时优先 HTTPS」不再成立——选了 HTTP 就不该有人替用户去连 8443。
 * 换掉的理由是真机读数：局域网那台机器没开 8443 是常态，白撞一发要吃 2 秒（09-29 实测 `ECONNREFUSED` 2010ms、
 * 打错 IP 更是 21 秒），而"哪条通"这件事用户自己最清楚。
 *
 * 钉住的四件事：
 *  1. **只发所选那一条**：另一条协议一次都不许出现（不许"顺手再试一下"）；
 *  2. **输入框优先**：地址里写了协议，就以他写的为准，选择器不许改写它；
 *  3. **不通也照样存**并带原因回来——存不存与通不通是两件事，界面才说得出"为什么连不上"；
 *  4. 端口的默认值只按**最终协议**补（https→8443、http→5173），裸地址与带协议两种写法都要对。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getServerUrl,
  detectAndSetServerUrl,
  serverSchemeOf,
  withScheme,
  type ServerScheme,
} from "@/lib/api-client";

const PROBE_PATH = "/api/sync/check-user/test";

/** 记账用的 fetch：按"哪条协议来的一律通"回话，并记下每一发出门的 URL */
function fetchThatAnswersAll() {
  const seen: string[] = [];
  globalThis.fetch = vi.fn(async (...args: Parameters<typeof fetch>) => {
    seen.push(String(args[0]));
    return new Response(null, { status: 200 });
  });
  return seen;
}

/** 只有所选那条通、另一条一律连不上——用来证明"没去偷试另一条" */
function fetchThatOnlyAnswers(scheme: ServerScheme) {
  const seen: string[] = [];
  globalThis.fetch = vi.fn(async (...args: Parameters<typeof fetch>) => {
    const url = String(args[0]);
    seen.push(url);
    if (url.startsWith(`${scheme}://`)) return new Response(null, { status: 200 });
    throw new TypeError("Failed to fetch");
  });
  return seen;
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
});

describe("SC1 只发所选那一条（不许顺手再试另一条）", () => {
  it("两条腿其实都开着 + 选 HTTP → 存 http:5173，而且一次都没碰 https", async () => {
    const seen = fetchThatAnswersAll();
    const r = await detectAndSetServerUrl("192.168.1.100", "http");
    expect(r.url).toBe("http://192.168.1.100:5173");
    expect(getServerUrl()).toBe("http://192.168.1.100:5173");
    expect(seen).toEqual([`http://192.168.1.100:5173${PROBE_PATH}`]);
    expect(seen.filter((u) => u.startsWith("https://")), "选了 HTTP 就不该有人替用户去连 8443").toEqual([]);
  });

  it("选 HTTPS → 存 https:8443，一次都没碰 http", async () => {
    const seen = fetchThatAnswersAll();
    const r = await detectAndSetServerUrl("192.168.1.100", "https");
    expect(r.url).toBe("https://192.168.1.100:8443");
    expect(seen).toEqual([`https://192.168.1.100:8443${PROBE_PATH}`]);
    expect(seen.filter((u) => u.startsWith("http://")), "选了 HTTPS 就不该有人替用户去连 5173").toEqual([]);
  });

  it("两条都开着时选的那条优先于\"另一个也能通\"（旧口径\"优先 HTTPS\"到此作废）", async () => {
    const seen = fetchThatAnswersAll();
    await detectAndSetServerUrl("10.0.0.9", "http");
    expect(seen.some((u) => u.includes(":8443"))).toBe(false);
  });
});

describe("SC2 输入框写了协议就以它为准", () => {
  it("地址里写着 https://，选择器给的是 http → 仍存 https（不静默改写用户输入的协议）", async () => {
    const seen = fetchThatAnswersAll();
    const r = await detectAndSetServerUrl("https://192.168.1.100", "http");
    expect(r.url).toBe("https://192.168.1.100:8443");
    expect(seen).toEqual([`https://192.168.1.100:8443${PROBE_PATH}`]);
  });

  it("地址里写着 http://，选择器给的是 https → 仍存 http", async () => {
    const seen = fetchThatAnswersAll();
    const r = await detectAndSetServerUrl("http://192.168.1.100", "https");
    expect(r.url).toBe("http://192.168.1.100:5173");
    expect(seen.filter((u) => u.startsWith("https://"))).toEqual([]);
  });

  it("只写端口不写协议 → 协议由选择器决定，端口照用户写的留住", async () => {
    const seen = fetchThatAnswersAll();
    expect((await detectAndSetServerUrl("192.168.1.100:9000", "https")).url).toBe("https://192.168.1.100:9000");
    expect((await detectAndSetServerUrl("192.168.1.100:9000", "http")).url).toBe("http://192.168.1.100:9000");
    expect(seen.length).toBe(2);
  });
});

describe("SC3 不通也照样存下来，并把原因带回去", () => {
  it("所选那条连不上 → ok:false + 原因，地址仍然是所选那条（不许回落到另一条）", async () => {
    const seen = fetchThatOnlyAnswers("https");   // 只有 https 通，而我们偏要选 http
    const r = await detectAndSetServerUrl("192.168.1.100", "http");
    expect(r.url).toBe("http://192.168.1.100:5173");
    expect(getServerUrl()).toBe("http://192.168.1.100:5173");
    expect(r.ok).toBe(false);
    expect(r.reason, "探不通必须带回来一个原因，界面才说得出为什么").not.toBeNull();
    expect(seen, "只发了一发：没通也不许再去撞另一条协议").toHaveLength(1);
  });

  it("空输入仍旧抛错（这一格不随选项改变）", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(detectAndSetServerUrl("   ", "http")).rejects.toThrow("服务器地址不能为空");
  });
});

describe("SC5 点「连接方式」时地址怎么跟着改（withScheme）", () => {
  it("两条方向都把协议与**那条的默认端口**一起换掉", () => {
    expect(withScheme("http://192.168.1.10:5173", "https")).toBe("https://192.168.1.10:8443");
    expect(withScheme("https://192.168.1.10:8443", "http")).toBe("http://192.168.1.10:5173");
  });

  it("用户自己写过的端口原样保留——只换协议，不许把 9000 改成 8443", () => {
    expect(withScheme("http://192.168.1.10:9000", "https")).toBe("https://192.168.1.10:9000");
    expect(withScheme("https://192.168.1.10:9000", "http")).toBe("http://192.168.1.10:9000");
  });

  it("裸地址走同一条路（补上协议与默认端口）；空输入还是空，不许凭空长出地址", () => {
    expect(withScheme("192.168.1.10", "https")).toBe("https://192.168.1.10:8443");
    expect(withScheme("192.168.1.10", "http")).toBe("http://192.168.1.10:5173");
    expect(withScheme("   ", "https")).toBe("");
  });
});

describe("SC4 选择器显示什么由\"最终生效的协议\"决定", () => {
  it("已存的地址带协议 → 读出那个协议；没存过 → 默认 http", () => {
    expect(serverSchemeOf(""), "没存过地址时默认走 HTTP（制作人拍的默认值）").toBe("http");
    expect(serverSchemeOf("https://192.168.1.10:8443")).toBe("https");
    expect(serverSchemeOf("http://192.168.1.10:5173")).toBe("http");
  });

  it("输入框里现写的协议盖过已存的地址（回填按钮时要跟着他正在写的东西走）", () => {
    expect(serverSchemeOf("http://192.168.1.10:5173", "https://192.168.1.10:8443")).toBe("http");
    expect(serverSchemeOf("192.168.1.10", "https://192.168.1.10:8443")).toBe("https");
    expect(serverSchemeOf("", "")).toBe("http");
  });
});
