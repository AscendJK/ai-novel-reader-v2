/**
 * 登录页草稿（`UsernameLogin.tsx` 的 `login-draft`）
 *
 * 缘起：装成 PWA 之后首启会自刷一次去拿跨源隔离（实测 1.8 秒，见
 * `docs/e2e-real-deploy-plan-2026-09.md` 与 `e2e/specs-real` 的 R-B0）。登录页只有一个
 * 输入框，用户几乎必然在那一刷之前就开始打字 —— 刷完名字没了，症状是"我明明输了，
 * 按钮又灰回去"。开发态不注册 SW、不自刷，所以这形状只有真包上看得见。
 *
 * 这里钉的是"扛过那一刷"的机制本身（卸载重挂 == 刷新），真浏览器上那一刷归 R-B0 判。
 *
 * 钉不住的一半：登录**失败**之后草稿还在不在。组件分不清成败 —— `useSyncOrchestration.ts:419`
 * 的 `handleLogin` 把每条失败路径都 catch 掉了（包括"取消登录"）正常返回，`AppLayout.tsx:42`
 * 传下来的 `loginError` 又是写死的 `null`，所以 `await onLogin()` 一返回草稿必然被清。
 * 实测那一次刷新落在开机后约 1.8 秒、在用户点提交之前，所以"提交失败后名字丢了"这条
 * 不在那一刷的射程里，没写成判据（写了就是把产品做不到的事钉成期望）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const checkServerReachable = vi.fn(async () => true);
vi.mock("@/lib/api-client", () => ({
  getServerUrl: () => "https://192.168.1.5:8443",
  setServerUrl: vi.fn(),
  checkServerReachable: () => checkServerReachable(),
  detectAndSetServerUrl: vi.fn(async (u: string) => u),
}));

const { default: UsernameLogin } = await import("@/components/login/UsernameLogin").then((m) => ({ default: m.UsernameLogin }));

const users = ["老用户甲"];

function mount(onLogin = vi.fn(async () => {})) {
  render(<UsernameLogin localUsers={users} onLogin={onLogin} onDelete={vi.fn()} />);
  return onLogin;
}

async function typeNewUser() {
  await userEvent.selectOptions(screen.getByLabelText("选择用户"), "__new__");
  await userEvent.type(screen.getByPlaceholderText("输入用户名（2-30 字符）"), "新来的读者");
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  checkServerReachable.mockClear();
});
afterEach(cleanup);

describe("首启那一刷带不走的草稿", () => {
  it("敲过名字之后重新挂载（等于被刷一次），输入框里还是那三个字，按钮可用", async () => {
    mount();
    await typeNewUser();
    cleanup();
    mount();
    const input = screen.getByPlaceholderText("输入用户名（2-30 字符）");
    expect(input, "自刷之后还要用户重敲一遍").toHaveValue("新来的读者");
    expect(screen.getByLabelText("选择用户")).toHaveValue("__new__");
    expect(screen.getByText("创建并进入").closest("button"), "恢复了值却没恢复可提交状态").not.toBeDisabled();
  });

  it("草稿只活在 sessionStorage：下次开标签页不许凭空带出一个旧名字", async () => {
    mount();
    await typeNewUser();
    expect(localStorage.getItem("login-draft"), "写进了 localStorage = 跨会话复发").toBeNull();
    expect(sessionStorage.getItem("login-draft")).toContain("新来的读者");
  });

  it("登录成功就把草稿删掉（退回登录页时不该还挂着刚用过的那个）", async () => {
    const onLogin = mount();
    await typeNewUser();
    await userEvent.click(screen.getByText("创建并进入"));
    expect(onLogin).toHaveBeenCalledWith("新来的读者");
    await vi.waitFor(() => expect(sessionStorage.getItem("login-draft")).toBeNull());
  });

  it("敲过新名字又改回已有用户：草稿要清掉，别留下一个没人要的输入", async () => {
    mount();
    await typeNewUser();
    expect(sessionStorage.getItem("login-draft"), "这一步就该写出草稿").toContain("新来的读者");
    await userEvent.selectOptions(screen.getByLabelText("选择用户"), "老用户甲");
    expect(sessionStorage.getItem("login-draft"), "切回下拉里已有的用户，草稿就不该再挂着").toBeNull();
  });

  it("sessionStorage 写不进（隐私模式）：登录这条路照走通", async () => {
    // 说清楚这一条钉住了什么、钉不住什么：写失败被 effect 里的 catch 吞掉之后，
    // 行为上与"写成功"没有区别（下一次挂载就是没草稿），所以摘掉那个 catch 也不会红——
    // jsdom 把 effect 里的异常当成未处理事件报走，不影响后面的点击。
    // 这里只钉"草稿写不进去不能把登录一起拖死"这一半；那一半留给真机（Safari 隐私模式）。
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    try {
      const onLogin = mount();
      await typeNewUser();
      await userEvent.click(screen.getByText("创建并进入"));
      expect(onLogin).toHaveBeenCalledWith("新来的读者");
    } finally {
      set.mockRestore();
    }
  });

  it("草稿里塞了畸形 JSON 时按没草稿处理，页面照常渲染", async () => {
    sessionStorage.setItem("login-draft", "{不是 JSON");
    mount();
    expect(screen.getByText("AI 小说精读助手")).toBeInTheDocument();
    expect(screen.getByLabelText("选择用户")).toHaveValue("");
  });
});
