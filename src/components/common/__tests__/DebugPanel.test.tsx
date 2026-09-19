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

import { DebugPanel } from "../DebugPanel";
import { DEVICE_CHECKLIST } from "@/lib/device-check";

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
});
