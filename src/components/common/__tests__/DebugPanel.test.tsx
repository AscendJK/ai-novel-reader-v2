/**
 * DebugPanel 的渲染与自检页交互测试
 *
 * 关注三件事：手机上是否真的能开（宽度分支）、自检页的事实/清单是否渲染并可勾选持久化、
 * 导出的文本框内容是否就是报告（iOS 上剪贴板常被拒，这条是兜底路径）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

vi.mock("@/stores/novel-store", () => ({
  useNovelStore: (sel: (s: { currentNovel: null }) => unknown) => sel({ currentNovel: null }),
}));
vi.mock("@/stores/rag-store", () => ({
  useRAGStore: (sel: (s: { engine: string }) => unknown) => sel({ engine: "tfidf" }),
}));
vi.mock("@/rag/index", () => ({ getBGEMeta: () => null }));
vi.mock("@/rag/engines", () => ({ getEngineDisplayName: (e: string) => e }));
vi.mock("@/tts/tts-manager", () => ({
  getActiveTTSManager: () => ({ describeRuntime: () => "engine=zipvoice chunk=3/12 缓冲池=2段" }),
}));
// 真实 collectFacts 要做 IndexedDB 实写探测，机器负载高时会超过 waitFor 默认 1s → 整条
// 用例偶发变红。它本身在 device-check.test.ts 里有用例，这里只需要"事实能渲染进面板"。
vi.mock("@/lib/device-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/device-check")>();
  return {
    ...actual,
    collectFacts: async () => [
      { label: "crossOriginIsolated", value: "false", level: "warn" as const },
      { label: "IndexedDB 可写", value: "可以", level: "ok" as const },
    ],
  };
});

import { DebugPanel } from "../DebugPanel";
import { DEVICE_CHECKLIST } from "@/lib/device-check";
import { appendDebugLog } from "@/lib/debug-store";

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, writable: true, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 700, writable: true, configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  // jsdom 没实现 scrollIntoView（真实浏览器都有）；面板自动滚到底会撞上它
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DebugPanel", () => {
  it("手机上以近全屏抽屉呈现（旧的 !isMobile 门槛会让它根本不渲染）", () => {
    setViewport(390);
    const { container } = render(<DebugPanel />);
    const panel = container.firstElementChild as HTMLElement;
    expect(panel).toBeTruthy();
    // 390 视口 → 面板占 390-16
    expect(panel.style.width).toBe("374px");
  });

  it("桌面视口保留可拖拽浮层的默认尺寸", () => {
    setViewport(1400);
    const { container } = render(<DebugPanel />);
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.style.width).toBe("420px");
  });

  it("切到真机自检：刷新事实 → 展示运行时；清单可勾选并落 localStorage", async () => {
    setViewport(1400);
    render(<DebugPanel />);
    fireEvent.click(screen.getByRole("button", { name: "真机自检" }));

    // 朗读运行时快照（每 2 秒刷一次的初值）
    await waitFor(() => expect(screen.getByText(/engine=zipvoice/)).toBeTruthy());

    // 环境事实由 collectFacts 提供，至少要有 COI 那行（label 与整行都含该词，故用 getAll）
    await waitFor(() => expect(screen.getAllByText(/crossOriginIsolated/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/IndexedDB 可写/).length).toBeGreaterThan(0);

    const first = DEVICE_CHECKLIST[0];
    const box = screen.getByLabelText(first.title) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(
      JSON.parse(localStorage.getItem("novel-reader-device-check") || "{}")[first.id]
    ).toBe(true));
  });

  it("导出走 navigator.share；没有分享时退回剪贴板", async () => {
    setViewport(1400);
    const share = vi.fn(async () => undefined);
    Object.assign(navigator, { share, clipboard: { writeText: vi.fn(async () => undefined) } });
    render(<DebugPanel />);
    fireEvent.click(screen.getByRole("button", { name: "真机自检" }));
    fireEvent.click(screen.getByRole("button", { name: "导出报告" }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(await screen.findByText(/已调起系统分享/)).toBeTruthy();
  });

  it("无剪贴板权限时提示手动复制，并给出可全选的文本框", async () => {
    setViewport(1400);
    // navigator 在同一文件的用例间是共享的：显式撤掉上一个用例装的 share
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true, writable: true });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => { throw new Error("NotAllowedError"); }) },
      configurable: true,
    });
    render(<DebugPanel />);
    fireEvent.click(screen.getByRole("button", { name: "真机自检" }));
    fireEvent.click(screen.getByRole("button", { name: "导出报告" }));
    expect(await screen.findByText(/手动复制/)).toBeTruthy();
    const box = screen.getByLabelText("自检报告纯文本（可手动全选复制）") as HTMLTextAreaElement;
    expect(box.value).toContain("【环境事实】");
    expect(box.value).toContain("【手动清单】");
  });

  /**
   * 09-28 在真 Chromium 上量到的坏法（一次性台架，读数抄在下面）：
   * 真鼠标点顶栏那排按钮 → `pointerdown→button` 之后 `pointerup→div`、`mouseup→div`、
   * `click→div`，页面不换；同一枚按钮用手指 tap 或键盘 Enter 都能换页。
   * 成因是拖拽把手在 pointerdown 上无条件 `setPointerCapture`：指针被把手收走，
   * click 就改派给把手，按钮自己的 onClick 收不到。
   *
   * **jsdom 看不见这种坏法**——上面几条用的 `fireEvent.click` 直接派发 click、不走指针链
   * （这就是为什么这一档全绿而浏览器里点不动）。所以这里只能显式判 `setPointerCapture`
   * 这个调用本身，浏览器层另配一条真鼠标的（e2e 的 P 组）。
   *
   * 刀账：
   * - Z10 摘掉 `closest("button, …")` 豁免 → jsdom 红 1（"按在按钮上不许捕获"）；
   *   同一刀打进浏览器层 P1 红 1，红在第 74 行那条 `aria-pressed`（真鼠标点不动）
   * - Z11 把手一律豁免（`|| true` 早退，谁都不捕获）→ jsdom 红 1（"空白处仍要捕获"）；
   *   浏览器层 P1 红 1，红在第 91 行的位移断言（面板拖不动）
   */
  describe("顶栏那排按钮不许被拖拽把手吃掉", () => {
    const captureSpy = () => {
      const spy = vi.fn();
      Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { value: spy, configurable: true, writable: true });
      return spy;
    };
    afterEach(() => {
      delete (HTMLElement.prototype as unknown as { setPointerCapture?: unknown }).setPointerCapture;
    });

    it("按在按钮上：不捕获指针（捕获会把这一次点击改派给把手）", () => {
      setViewport(1400);
      const spy = captureSpy();
      render(<DebugPanel />);
      fireEvent.pointerDown(screen.getByRole("button", { name: "真机自检" }), { pointerId: 7 });
      expect(spy, "按下按钮的同时把指针捕获到把手 → 这次点击永远到不了按钮").not.toHaveBeenCalled();
    });

    it("按在把手的空白处：仍然要捕获（不然面板就拖不动了，两个相反的值都得钉住）", () => {
      setViewport(1400);
      const spy = captureSpy();
      const { container } = render(<DebugPanel />);
      const handle = container.querySelector("[data-debug-handle]") as HTMLElement;
      expect(handle, "把手那一层没了，这条保护格等于没判").toBeTruthy();
      fireEvent.pointerDown(handle, { pointerId: 8 });
      expect(spy, "把手空白处不再捕获指针 → 面板拖不动").toHaveBeenCalled();
    });

    it("导出的时间线里每一行都以时刻开头（store 加的那枚要活着走到报告里）", async () => {
      setViewport(1400);
      let shared = "";
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: vi.fn(async (d: { text?: string }) => { shared = d.text ?? ""; }),
      });
      render(<DebugPanel />);
      fireEvent.click(screen.getByRole("button", { name: "真机自检" }));
      appendDebugLog("朗读现场 engine=server chunk=1/9 缓冲池=2段");
      fireEvent.click(screen.getByRole("button", { name: "导出报告" }));
      await waitFor(() => expect(navigator.share).toHaveBeenCalled());
      const row = shared.split("\n").find((l) => l.includes("朗读现场"));
      expect(row, `导出里没有现场行：${shared.slice(-200)}`).toBeTruthy();
      expect(/^\[\d{2}:\d{2}:\d{2}\] /.test(row ?? ""), `现场行开头没有时刻，两行相减算不出时长：${row}`).toBe(true);
    });
  });
});
