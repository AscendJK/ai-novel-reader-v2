/**
 * 登录界面上那行红字（`UsernameLogin.tsx` 的 `error` prop）
 *
 * 为什么单独钉这一格：2026-09-27 之前它是一次**死通道**——`AppLayout` 自己 `useState(null)`
 * 却没有 setter，于是服务端说"用户名需 2-30 个字符"也只能靠系统弹窗递出去（真后端台架上
 * 撞红过：租户名 43 字符，`signIn` 只听见一个弹层，界面上什么都没有）。
 * 修完之后链路是三段：hook 报原因（`useSyncOrchestration-identity.test.ts` 判）→ 外壳递成
 * `error` prop（`AppLayout-shell.test.tsx` 判）→ **这一格判最后那一段：递进来了屏上真有这句话**。
 * 三段缺一段都是"用户看不见原因"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/lib/api-client", () => ({
  getServerUrl: () => "https://192.168.1.5:8443",
  setServerUrl: vi.fn(),
  detectAndSetServerUrl: vi.fn(async (u: string) => u),
  probeServer: vi.fn(async () => ({ ok: true, reason: null })),
}));

const { UsernameLogin } = await import("@/components/login/UsernameLogin");

const users = ["老用户甲"];

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(cleanup);

describe("被拒之后那句原因要真的在屏上", () => {
  it("有原因 → 那句话说的是什么就是什么（不是一句笼统的「登录失败」）", () => {
    render(
      <UsernameLogin localUsers={users} onLogin={vi.fn(async () => {})} onDelete={vi.fn()}
        error="用户名需 2-30 个字符" />
    );
    expect(screen.getByText("用户名需 2-30 个字符"),
      "服务端给的原因原样递到用户眼前，才谈得上「改一下名字重来」").toBeInTheDocument();
  });

  it("没有原因 → 不许凭空长出一行红字", () => {
    render(
      <UsernameLogin localUsers={users} onLogin={vi.fn(async () => {})} onDelete={vi.fn()}
        error={null} />
    );
    expect(screen.queryByText("用户名需 2-30 个字符")).toBeNull();
    expect(document.querySelectorAll("p.text-destructive"), "没失败却凭空长出一行红字＝骗用户").toHaveLength(0);
  });
});
