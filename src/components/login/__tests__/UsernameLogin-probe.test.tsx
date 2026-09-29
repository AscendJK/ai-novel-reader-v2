/**
 * 探测失败的原因要真的分开上屏（方案 A，制作人 09-29 拍「按你的建议，做方案A先」）。
 *
 * 为什么单独钉组件这一层：`probeServer` 分得再细，最后那一段还是 `UsernameLogin` 的一行 `<p>`
 * 与一枚 badge（三段链路的最后一段，同 `UsernameLogin-error.test.tsx` 讲的那个道理）。
 * 这一档拿**两种相反的原因**各取一次样：只取一种会被"写死成一句话"骗过去。
 *
 * 文案本身来自产品那份表（`PROBE_FAILURE_TEXT` 用真实实现，不另抄一遍），
 * 这样"类别与文案同源"这一格才判得住。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const probeResult = vi.fn(async () => ({ ok: false, reason: "mixed-content" }) as {
  ok: boolean;
  reason: string | null;
});

vi.mock("@/lib/api-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    getServerUrl: () => "https://192.168.1.10:8443",
    setServerUrl: vi.fn(),
    detectAndSetServerUrl: vi.fn(async (u: string) => u),
    probeServer: () => probeResult(),
  };
});

const { UsernameLogin } = await import("@/components/login/UsernameLogin");
const { PROBE_FAILURE_TEXT } = await import("@/lib/api-client");

const OLD_GENERIC = "无法连接到服务器，请检查地址是否正确";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  probeResult.mockClear();
  probeResult.mockResolvedValue({ ok: false, reason: "mixed-content" });
});
afterEach(cleanup);

/** 挂载时那发探测（`useEffect` 里 setTimeout 0）跑完之后，状态行上那一枚以「●」开头的徽标 */
async function badge() {
  await waitFor(() => expect(probeResult).toHaveBeenCalled());
  const el = Array.from(document.querySelectorAll("span")).find((s) => s.textContent?.trim().startsWith("●"));
  return el?.textContent ?? null;
}

describe("两种原因上两种不同的话", () => {
  it("混合内容 → badge 说的是「需 HTTPS」，旧那句笼统的话不许再出现", async () => {
    render(
      <UsernameLogin localUsers={["老用户甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} error={null} />
    );
    expect(await badge(), `mixed-content 那一类应该有它自己的话：${PROBE_FAILURE_TEXT["mixed-content"].badge}`)
      .toContain(PROBE_FAILURE_TEXT["mixed-content"].badge);
    expect(screen.queryByText(OLD_GENERIC), "既然知道是混合内容，就不许再让人去改地址").toBeNull();
  });

  it("换成超时 → badge 与红字都换一套，不许跟上一条撞同一句", async () => {
    probeResult.mockResolvedValue({ ok: false, reason: "timeout" });
    render(
      <UsernameLogin localUsers={["老用户甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} error={null} />
    );
    expect(await badge()).toContain(PROBE_FAILURE_TEXT["timeout"].badge);
    expect(screen.queryByText(PROBE_FAILURE_TEXT["mixed-content"].badge)).toBeNull();
  });

  it("打开「配置」之后那句长话跟着原因走", async () => {
    render(
      <UsernameLogin localUsers={["老用户甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} error={null} />
    );
    await waitFor(() => expect(probeResult).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "更改" }));
    expect(await screen.findByText(PROBE_FAILURE_TEXT["mixed-content"].note)).toBeInTheDocument();

    cleanup();
    probeResult.mockClear();
    probeResult.mockResolvedValue({ ok: false, reason: "local-network-blocked" });
    render(
      <UsernameLogin localUsers={["老用户甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} error={null} />
    );
    await waitFor(() => expect(probeResult).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "更改" }));
    expect(await screen.findByText(PROBE_FAILURE_TEXT["local-network-blocked"].note)).toBeInTheDocument();
    expect(screen.queryByText(PROBE_FAILURE_TEXT["mixed-content"].note)).toBeNull();
  });

  it("探测成功 → 一行红字都不该长出来", async () => {
    probeResult.mockResolvedValue({ ok: true, reason: null });
    render(
      <UsernameLogin localUsers={["老用户甲"]} onLogin={vi.fn(async () => {})} onDelete={vi.fn()} error={null} />
    );
    await waitFor(() => expect(probeResult).toHaveBeenCalled());
    expect(document.querySelectorAll("p.text-destructive")).toHaveLength(0);
    expect(screen.queryByText(PROBE_FAILURE_TEXT["unreachable"].note)).toBeNull();
  });
});
