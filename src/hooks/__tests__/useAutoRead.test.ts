/**
 * useAutoRead — 自动阅读 hook 测试
 * 覆盖：定时翻页/滚动、终点停止、用户干扰停止（点击/滑动/按键）、
 * TTS 互斥、卸载清理。
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

function makeScrollEl() {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 500, configurable: true });
  el.scrollTop = 0;
  el.scrollBy = vi.fn();
  return el as HTMLDivElement & { scrollBy: ReturnType<typeof vi.fn> };
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
        scrollStepPercent: 60,
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
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("分页模式：开启后立即翻页一次，之后按间隔定时翻页", () => {
    const { hook, onNextPage } = setup({ paginated: true, intervalSec: 8 });
    expect(onNextPage).toHaveBeenCalledTimes(1); // 开启即时反馈

    act(() => { vi.advanceTimersByTime(8000); });
    expect(onNextPage).toHaveBeenCalledTimes(2);

    act(() => { vi.advanceTimersByTime(16000); });
    expect(onNextPage).toHaveBeenCalledTimes(4);

    hook.unmount();
  });

  it("分页模式：最后一章末页 → 停止并回调 end", () => {
    const { onNextPage, onStop, hook } = setup({
      paginated: true,
      isAtEnd: () => true,
    });
    expect(onNextPage).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalledWith("end");
    hook.unmount();
  });

  it("滚动模式：按间隔平滑滚动视口高度 60%", () => {
    const { hook, scrollEl } = setup({ paginated: false, intervalSec: 5 });
    expect(scrollEl.scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollEl.scrollBy).toHaveBeenLastCalledWith({ top: 500 * 0.6, behavior: "smooth" });

    act(() => { vi.advanceTimersByTime(5000); });
    expect(scrollEl.scrollBy).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("滚动模式：滑动窗口可自定义（30% → 150px，100% → 500px）", () => {
    const { hook, scrollEl } = setup({ paginated: false, scrollStepPercent: 30 });
    expect(scrollEl.scrollBy).toHaveBeenLastCalledWith({ top: 500 * 0.3, behavior: "smooth" });
    hook.unmount();

    const { hook: hook2, scrollEl: el2 } = setup({ paginated: false, scrollStepPercent: 100 });
    expect(el2.scrollBy).toHaveBeenLastCalledWith({ top: 500, behavior: "smooth" });
    hook2.unmount();
  });

  it("滚动模式：滚动到底 → 停止并回调 end，不再滚动", () => {
    const { hook, scrollEl, onStop } = setup({ paginated: false, intervalSec: 8 });
    scrollEl.scrollTop = 2000 - 500 - 4; // 到底（容差 4px 内）

    act(() => { vi.advanceTimersByTime(8000); });
    expect(onStop).toHaveBeenCalledWith("end");

    const callsAfter = scrollEl.scrollBy.mock.calls.length;
    act(() => { vi.advanceTimersByTime(8000); });
    expect(scrollEl.scrollBy.mock.calls.length).toBe(callsAfter); // 停止后不再滚动
    hook.unmount();
  });

  it("用户点击正文 → 停止（user）", () => {
    const { hook, contentEl, onStop } = setup();
    act(() => { contentEl.dispatchEvent(new Event("pointerdown")); });
    expect(onStop).toHaveBeenCalledWith("user");
    hook.unmount();
  });

  it("用户滚轮正文 → 停止（user）", () => {
    const { hook, contentEl, onStop } = setup();
    act(() => { contentEl.dispatchEvent(new Event("wheel")); });
    expect(onStop).toHaveBeenCalledWith("user");
    hook.unmount();
  });

  it("用户按翻页/方向键 → 停止（user）", () => {
    const { hook, onStop } = setup();
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); });
    expect(onStop).toHaveBeenCalledWith("user");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" })); });
    expect(onStop).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("TTS 朗读中 tick → 停止（user）（互斥）", () => {
    const { hook, onStop } = setup({ intervalSec: 8 });
    h.state.playing = true;
    act(() => { vi.advanceTimersByTime(8000); });
    expect(onStop).toHaveBeenCalledWith("user");
    hook.unmount();
  });

  it("enabled=false 时：不翻页、不滚动、不监听", () => {
    const { hook, onNextPage, scrollEl, onStop } = setup({ enabled: false, paginated: false });
    expect(onNextPage).not.toHaveBeenCalled();
    expect(scrollEl.scrollBy).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(8000); });
    expect(onNextPage).not.toHaveBeenCalled();
    expect(scrollEl.scrollBy).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("卸载后清理定时器：不再翻页", () => {
    const { hook, onNextPage } = setup({ intervalSec: 8 });
    expect(onNextPage).toHaveBeenCalledTimes(1);
    hook.unmount();
    act(() => { vi.advanceTimersByTime(8000); });
    expect(onNextPage).toHaveBeenCalledTimes(1); // 不再增加
  });

  it("停止后重新开启（enabled false→true）：定时器重建", () => {
    const onNextPage = vi.fn();
    const onStop = vi.fn();
    const scrollRef = { current: makeScrollEl() } as React.RefObject<HTMLDivElement | null>;
    const contentRef = { current: document.createElement("div") } as React.RefObject<HTMLElement | null>;
    const base = {
      intervalSec: 8,
      scrollStepPercent: 60,
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
});
