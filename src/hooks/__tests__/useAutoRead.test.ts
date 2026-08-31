/**
 * useAutoRead — 自动阅读 hook 测试
 * 覆盖：分页定时翻页 / 滚动 rAF 持续滚动（速度可调）/ 终点停止、
 * 用户干扰停止（点击/滑动/按键）、TTS 互斥、卸载清理。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ── Mock TTS store：可控 playing（互斥测试用）──
const h = vi.hoisted(() => {
  const state = { playing: false };
  return { state };
});

vi.mock("@/stores/tts-store", () => ({
  useTTSStore: { getState: () => ({ playing: h.state.playing }) },
}));

import { useAutoRead, type UseAutoReadOptions } from "../useAutoRead";

// ── 手动 stub requestAnimationFrame：可控逐帧推进 ──
let rafCb: ((ts: number) => void) | null = null;
let rafIdCounter = 0;
const rafStubs = {
  requestAnimationFrame: (cb: (ts: number) => void) => { rafCb = cb; return ++rafIdCounter; },
  cancelAnimationFrame: vi.fn(),
};

/** 推进 N 帧（每帧时间戳递增）；返回当前滚动位置 */
function runFrames(frameTimes: number[]) {
  act(() => {
    for (const t of frameTimes) {
      const cb = rafCb;
      rafCb = null;
      cb?.(t);
    }
  });
}

function makeScrollEl() {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 500, configurable: true });
  el.scrollTop = 0;
  return el as HTMLDivElement;
}

function setup(overrides: Partial<UseAutoReadOptions> = {}) {
  const onNextPage = vi.fn();
  const isAtEnd = vi.fn(() => false);
  const onStop = vi.fn();
  const scrollEl = makeScrollEl();
  const contentEl = document.createElement("div");
  const scrollRef = { current: scrollEl };
  const contentRef = { current: contentEl as unknown as HTMLElement };

  const hook = renderHook(
    (props: UseAutoReadOptions) => useAutoRead(props),
    {
      initialProps: {
        enabled: true,
        intervalSec: 8,
        speedLinesPerSec: 2,
        lineHeightPx: 30, // 行高 30px：2 行/秒 = 60px/秒
        paginated: true,
        scrollRef: scrollRef as React.RefObject<HTMLDivElement | null>,
        contentRef: contentRef as React.RefObject<HTMLElement | null>,
        onNextPage,
        isAtEnd,
        onStop,
        ...overrides,
      },
    }
  );
  return { hook, onNextPage, isAtEnd, onStop, scrollEl, contentEl, scrollRef, contentRef };
}

describe("useAutoRead", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.state.playing = false;
    rafCb = null;
    rafIdCounter = 0;
    rafStubs.cancelAnimationFrame.mockClear();
    vi.stubGlobal("requestAnimationFrame", rafStubs.requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", rafStubs.cancelAnimationFrame);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── 分页模式 ──
  it("分页模式：开启后立即翻页一次，之后按间隔定时翻页", () => {
    const { hook, onNextPage } = setup();
    expect(onNextPage).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(8000); });
    expect(onNextPage).toHaveBeenCalledTimes(2);
    act(() => { vi.advanceTimersByTime(8000); });
    expect(onNextPage).toHaveBeenCalledTimes(3);
    hook.unmount();
  });

  it("分页模式：最后一章末页 → 停止并回调 end，不再翻页", () => {
    const { hook, onNextPage, onStop } = setup({ isAtEnd: () => true });
    expect(onStop).toHaveBeenCalledWith("end");
    expect(onNextPage).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(8000); });
    expect(onNextPage).not.toHaveBeenCalled();
    hook.unmount();
  });

  // ── 滚动模式（rAF 持续滚动）──
  it("滚动模式：正文持续匀速滑动（速度 = 行/秒 × 行高）", () => {
    const { hook, scrollEl } = setup({ paginated: false });
    // 第一帧初始化 lastTs（无位移）；随后 2 行/秒 × 30px × 1s = 60px/秒
    runFrames([0, 1000, 2000, 3000]);
    expect(scrollEl.scrollTop).toBe(2 * 30 * 3);
    hook.unmount();
  });

  it("滚动模式：速度可调（1 行/秒 vs 4 行/秒）", () => {
    const { hook: hook1, scrollEl: el1 } = setup({ paginated: false, speedLinesPerSec: 1 });
    runFrames([0, 2000]); // 1 行/秒 × 30px × 2s = 60px
    expect(el1.scrollTop).toBe(60);
    hook1.unmount();

    const { hook: hook2, scrollEl: el2 } = setup({ paginated: false, speedLinesPerSec: 4 });
    runFrames([0, 1000]); // 4 行/秒 × 30px × 1s = 120px
    expect(el2.scrollTop).toBe(120);
    hook2.unmount();
  });

  it("滚动模式：滚动到底 → 停止并回调 end，不再滚动", () => {
    const { hook, scrollEl, onStop } = setup({ paginated: false });
    scrollEl.scrollTop = 2000 - 500 - 4; // 距底 4px（容差内）
    runFrames([0, 16]);
    expect(onStop).toHaveBeenCalledWith("end");
    const callsAfterEnd = scrollEl.scrollTop;
    runFrames([32, 48]); // 已停止：不再滚动
    expect(scrollEl.scrollTop).toBe(callsAfterEnd);
    expect(rafStubs.cancelAnimationFrame).toHaveBeenCalled();
    hook.unmount();
  });

  // ── 用户干扰 ──
  it("用户点击正文 → 停止（user）", () => {
    const { hook, contentEl, onStop } = setup({ paginated: false });
    act(() => { contentEl.dispatchEvent(new Event("pointerdown")); });
    expect(onStop).toHaveBeenCalledWith("user");
    hook.unmount();
  });

  it("用户滚轮滑动正文 → 停止（user）", () => {
    const { hook, contentEl, onStop } = setup();
    act(() => { contentEl.dispatchEvent(new Event("wheel")); });
    expect(onStop).toHaveBeenCalledWith("user");
    hook.unmount();
  });

  it("翻页类按键 → 停止（user）", () => {
    const { hook, onStop } = setup();
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); });
    expect(onStop).toHaveBeenCalledWith("user");
    hook.unmount();
  });

  // ── TTS 互斥 ──
  it("TTS 朗读中 → 分页 tick 停止（user）", () => {
    const { hook, onStop, onNextPage } = setup();
    h.state.playing = true;
    act(() => { vi.advanceTimersByTime(8000); });
    expect(onStop).toHaveBeenCalledWith("user");
    expect(onNextPage).toHaveBeenCalledTimes(1); // 只有开启时那一次
    hook.unmount();
  });

  it("TTS 朗读中 → 滚动 rAF 停止（user）", () => {
    const { hook, onStop, scrollEl } = setup({ paginated: false });
    h.state.playing = true;
    runFrames([0, 1000]);
    expect(onStop).toHaveBeenCalledWith("user");
    expect(scrollEl.scrollTop).toBe(0); // 未滚动
    hook.unmount();
  });

  // ── 生命周期 ──
  it("停止后重新开启（enabled false→true）：定时器重建", () => {
    const onNextPage = vi.fn();
    const onStop = vi.fn();
    const scrollRef = { current: makeScrollEl() } as React.RefObject<HTMLDivElement | null>;
    const contentRef = { current: document.createElement("div") } as React.RefObject<HTMLElement | null>;
    const base = {
      intervalSec: 8,
      speedLinesPerSec: 2,
      lineHeightPx: 30,
      paginated: true,
      scrollRef,
      contentRef,
      onNextPage,
      isAtEnd: () => false,
      onStop,
    };
    const { hook } = setup({ enabled: false, ...base });
    expect(onNextPage).not.toHaveBeenCalled();

    hook.rerender({ enabled: true, ...base });
    expect(onNextPage).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(8000); });
    expect(onNextPage).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("卸载时停止 rAF 循环", () => {
    const { hook, scrollEl } = setup({ paginated: false });
    hook.unmount();
    expect(rafStubs.cancelAnimationFrame).toHaveBeenCalled();
    const after = scrollEl.scrollTop;
    runFrames([1000]); // 已卸载：不再滚动
    expect(scrollEl.scrollTop).toBe(after);
  });
});
