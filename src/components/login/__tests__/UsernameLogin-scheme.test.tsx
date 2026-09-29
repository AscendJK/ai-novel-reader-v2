/**
 * 登录页「连接方式」这一格（制作人 09-29 拍：把藏在背后的自动探测换成明写 selectable）。
 *
 * 口径翻转为：
 *  1. **选哪条连哪条**——裸 IP 只探所选那一条，不许再"先探一条不行换另一条"；
 *  2. **默认 HTTP**——只在没存过地址时吃这个默认值；存过就按存的那条回填；
 *  3. **点按钮会把地址里的协议一起改掉**（含那条的默认端口，用户自己写过的端口保留）——
 *     做成"输入写了协议就把按钮 disabled"的话，已存过地址的人打开面板就永远是禁用态，这个选项等于没有；
 *  4. 换方式**当场重探**，状态行不许留着上一协议的结论。
 *
 * 为什么钉在组件这一层：`api-client` 那档（`src/lib/__tests__/api-client-server-scheme.test.ts`）
 * 只证明"给了 scheme 就只探那一条"；**界面上默认值落哪、按钮什么时候让按、点了之后传的是哪一个**
 * 只有挂载起来才看得见。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

let storedUrl = "";
const probeCalls: string[] = [];
const detectCalls: Array<[string, string | undefined]> = [];

const probeMock = vi.fn(async (url: string) => {
  probeCalls.push(url);
  return { ok: true, reason: null };
});
const detectMock = vi.fn(async (url: string, scheme?: string) => {
  detectCalls.push([url, scheme]);
  probeCalls.push(`__detect__:${url}`);
  return { url, ok: true, reason: null };
});

vi.mock("@/lib/api-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    getServerUrl: () => storedUrl,
    setServerUrl: vi.fn(),
    detectAndSetServerUrl: detectMock,
    probeServer: probeMock,
  };
});

const { UsernameLogin } = await import("@/components/login/UsernameLogin");
const api = await import("@/lib/api-client");

const httpRadio = () => screen.getByRole("radio", { name: "HTTP :5173" });
const httpsRadio = () => screen.getByRole("radio", { name: "HTTPS :8443" });
const urlInput = () => screen.getByPlaceholderText("192.168.1.100");

/** 打开配置面板（没存过地址时那枚按钮写「配置」，存过写「更改」） */
function openConfig() {
  fireEvent.click(screen.getByRole("button", { name: storedUrl ? "更改" : "配置" }));
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  storedUrl = "";
  probeCalls.length = 0;
  detectCalls.length = 0;
});
afterEach(cleanup);

describe("SX1 默认值：没存过地址吃 HTTP，存过就按存的那条回填", () => {
  it("一台机器第一次配 → 选中的是 HTTP :5173，不是 HTTPS", () => {
    render(<UsernameLogin localUsers={["甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} />);
    openConfig();
    expect(httpRadio()).toHaveAttribute("aria-checked", "true");
    expect(httpsRadio()).toHaveAttribute("aria-checked", "false");
  });

  it("存过 https 地址 → 控件回填 HTTPS（默认值只在该没存过时生效，不许覆盖用户上一次的选择）", () => {
    storedUrl = "https://192.168.1.5:8443";
    render(<UsernameLogin localUsers={["甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} />);
    openConfig();
    expect(httpsRadio()).toHaveAttribute("aria-checked", "true");
    expect(httpRadio()).toHaveAttribute("aria-checked", "false");
  });

  it("把整行清空再填裸 IP → 仍按上一次生效的那条协议，不许悄悄掉回默认", async () => {
    storedUrl = "https://192.168.1.5:8443";
    render(<UsernameLogin localUsers={["甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} />);
    openConfig();
    fireEvent.change(urlInput(), { target: { value: "" } });
    fireEvent.change(urlInput(), { target: { value: "192.168.1.100" } });
    // 这一格钉的是"选择器自己记着上一次的生效协议"：清空只是擦掉输入，不是擦掉选择
    expect(httpsRadio()).toHaveAttribute("aria-checked", "true");
    expect(httpsRadio()).toBeEnabled();
    fireEvent.click(httpRadio());
    await waitFor(() => expect(httpRadio()).toHaveAttribute("aria-checked", "true"));
  });
});

describe("SX2 选什么连什么：只发所选那一条", () => {
  it("默认 HTTP：保存时传给 detect 的是 http，全程没碰过 https", async () => {
    render(<UsernameLogin localUsers={["甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} />);
    openConfig();
    fireEvent.change(urlInput(), { target: { value: "192.168.1.100" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并连接" }));
    await waitFor(() => expect(detectMock).toHaveBeenCalled());
    expect(detectCalls).toEqual([["192.168.1.100", "http"]]);
    expect(
      [...probeCalls, ...detectCalls.map(([u]) => u)].filter((u) => u.includes("https://")),
      "选了 HTTP 就不许再暗地里探一次 https——那正是这次要拆掉的「自动改试另一条」"
    ).toHaveLength(0);
  });

  it("改成 HTTPS 后：当场重探 https，且此后不再出现 http 那一腿", async () => {
    render(<UsernameLogin localUsers={["甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} />);
    openConfig();
    fireEvent.change(urlInput(), { target: { value: "192.168.1.100" } });
    fireEvent.click(httpsRadio());
    await waitFor(() => expect(probeCalls).toContain("https://192.168.1.100:8443"));
    expect(httpRadio()).toHaveAttribute("aria-checked", "false");

    probeCalls.length = 0;
    detectCalls.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "保存并连接" }));
    await waitFor(() => expect(detectMock).toHaveBeenCalled());
    expect(detectCalls, "点过 HTTPS 之后保存的就是那条完整地址，协议也是 https").toEqual([
      ["https://192.168.1.100:8443", "https"],
    ]);
    expect(probeCalls.filter((u) => u.startsWith("http://")), "换了 HTTPS 还补一腿 http 就是没改干净").toHaveLength(0);
  });

  it("换方式之后状态行不许留着上一协议的结论：重新探测跑起来", async () => {
    render(<UsernameLogin localUsers={["甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} />);
    openConfig();
    fireEvent.change(urlInput(), { target: { value: "192.168.1.100" } });
    probeCalls.length = 0;
    fireEvent.click(httpsRadio());
    await waitFor(() => expect(probeCalls).toEqual(["https://192.168.1.100:8443"]));
  });
});

describe("SX3 点按钮会把输入里的协议一起改掉（否则这选项对已存过地址的人等于没有）", () => {
  it("已存 https 地址：框里预填的就是 https://…:8443，点 HTTP 会把整条改掉并按 http 重探", async () => {
    storedUrl = "https://192.168.1.5:8443";
    render(<UsernameLogin localUsers={["甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} />);
    openConfig();
    expect(httpsRadio()).toHaveAttribute("aria-checked", "true");
    expect(httpRadio()).toBeEnabled();

    probeCalls.length = 0;
    fireEvent.click(httpRadio());
    await waitFor(() => expect(urlInput()).toHaveValue("http://192.168.1.5:5173"));
    expect(httpRadio()).toHaveAttribute("aria-checked", "true");
    // 只看点击之后：挂载时那一发（探已存的那条 https）由上一条判据管，别混进来
    await waitFor(() => expect(probeCalls.filter((u) => u.startsWith("http://"))).toEqual(["http://192.168.1.5:5173"]));
  });

  it("输入里写着协议也一样能点：https://x 点 HTTP → http://x:5173，保存发的是改写后那条", async () => {
    render(<UsernameLogin localUsers={["甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} />);
    openConfig();
    fireEvent.change(urlInput(), { target: { value: "https://192.168.1.100" } });
    expect(httpsRadio()).toHaveAttribute("aria-checked", "true");
    fireEvent.click(httpRadio());
    await waitFor(() => expect(urlInput()).toHaveValue("http://192.168.1.100:5173"));

    fireEvent.click(screen.getByRole("button", { name: "保存并连接" }));
    await waitFor(() => expect(detectMock).toHaveBeenCalled());
    expect(detectCalls[detectCalls.length - 1]).toEqual(["http://192.168.1.100:5173", "http"]);
  });

  it("用户自己写过的端口保留，只有对面那条的默认端口跟着换", () => {
    storedUrl = "https://192.168.1.5:8443";
    render(<UsernameLogin localUsers={["甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} />);
    openConfig();
    fireEvent.change(urlInput(), { target: { value: "https://192.168.1.5:9000" } });
    fireEvent.click(httpRadio());
    expect(urlInput()).toHaveValue("http://192.168.1.5:9000");
  });
});

describe("SX4 这一格在无障碍树上找得到，提示行不再承诺自动探测", () => {
  it("radiogroup 有自己的名字，两枚控件各有 name（过面板控件那把地板）", () => {
    render(<UsernameLogin localUsers={["甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} />);
    openConfig();
    expect(screen.getByRole("radiogroup", { name: "连接方式" })).toBeInTheDocument();
    expect(httpRadio()).toHaveAttribute("name", "server-scheme-http");
    expect(httpsRadio()).toHaveAttribute("name", "server-scheme-https");
  });

  it("提示行不许再写「自动探测」——现在是我们按用户的选择连", () => {
    render(<UsernameLogin localUsers={["甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} />);
    openConfig();
    const hint = screen.getByText(/只填 IP 时按上面选的方式连/);
    expect(hint.textContent).not.toContain("自动探测");
    expect(hint.textContent).toContain("5173");
    expect(hint.textContent).toContain("8443");
  });

  it("框里已有内容时那份清单不展开；清空再聚焦才给看——顺带点一条，控件跟着那条走", () => {
    storedUrl = "https://192.168.1.5:8443";
    localStorage.setItem("novel-reader-recent-urls", JSON.stringify(["http://192.168.1.9:5173"]));
    render(<UsernameLogin localUsers={["甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} />);
    openConfig();
    fireEvent.focus(urlInput());
    expect(screen.queryByText("http://192.168.1.9:5173"), "预填着地址还展开清单，会把下面的控件挤得点不到").toBeNull();

    fireEvent.change(urlInput(), { target: { value: "" } });
    fireEvent.focus(urlInput());
    fireEvent.click(screen.getByText("http://192.168.1.9:5173"));
    expect(httpRadio()).toHaveAttribute("aria-checked", "true");
    expect(urlInput()).toHaveValue("http://192.168.1.9:5173");
  });

  it("开始打字之后清单收起（它内联排在框下面，留着会把行高顶来顶去）", () => {
    storedUrl = "";
    localStorage.setItem("novel-reader-recent-urls", JSON.stringify(["http://192.168.1.9:5173"]));
    render(<UsernameLogin localUsers={["甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} />);
    openConfig();
    fireEvent.focus(urlInput());
    expect(screen.getByText("http://192.168.1.9:5173")).toBeInTheDocument();
    fireEvent.change(urlInput(), { target: { value: "192.168.1.20" } });
    expect(screen.queryByText("http://192.168.1.9:5173")).toBeNull();
  });

  it("composeServerUrl 是真实实现（这档判的是界面接线，不许连拼接一起 mock 掉）", () => {
    expect(api.composeServerUrl("192.168.1.100", "http")).toBe("http://192.168.1.100:5173");
    expect(api.composeServerUrl("192.168.1.100", "https")).toBe("https://192.168.1.100:8443");
  });
});
