/**
 * usePagination 测试
 * 通过 fake timers 控制 effect 中的异步流程
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePagination } from "../usePagination";

describe("usePagination result pages", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("未启用时返回空页", () => {
    const { result } = renderHook(() =>
      usePagination({
        paragraphs: ["段落1", "段落2"],
        fontSize: 16,
        lineHeight: 1.5,
        fontWeight: 400,
        fontFamily: "sans-serif",
        paragraphSpacing: 4,
        contentWidth: 400,
        contentHeight: 200,
        enabled: false,
      })
    );

    // 推进到 effect 执行（setTimeout + requestAnimationFrame）
    act(() => { vi.advanceTimersByTime(200); });

    expect(result.current.pages).toEqual([]);
    expect(result.current.totalPages).toBe(0);
  });

  it("空段落返回空页", () => {
    const { result } = renderHook(() =>
      usePagination({
        paragraphs: [],
        fontSize: 16,
        lineHeight: 1.5,
        fontWeight: 400,
        fontFamily: "sans-serif",
        paragraphSpacing: 4,
        contentWidth: 400,
        contentHeight: 200,
        enabled: true,
      })
    );

    act(() => { vi.advanceTimersByTime(200); });

    // measureRef.current 没有 children，doCalculate 返回空页
    expect(result.current.pages).toEqual([]);
  });

  it("无 contentWidth 时返回空页", () => {
    const { result } = renderHook(() =>
      usePagination({
        paragraphs: ["段落1"],
        fontSize: 16,
        lineHeight: 1.5,
        fontWeight: 400,
        fontFamily: "sans-serif",
        paragraphSpacing: 4,
        contentWidth: 0,
        contentHeight: 200,
        enabled: true,
      })
    );

    act(() => { vi.advanceTimersByTime(200); });

    // 无 contentWidth 时，effect 中的 check 会触发 setPages([])
    expect(result.current.pages).toEqual([]);
  });

  it("设置 DOM 后计算分页", () => {
    const { result } = renderHook(() =>
      usePagination({
        paragraphs: ["段落1", "段落2"],
        fontSize: 16,
        lineHeight: 1.5,
        fontWeight: 400,
        fontFamily: "sans-serif",
        paragraphSpacing: 4,
        contentWidth: 400,
        contentHeight: 200,
        enabled: true,
      })
    );

    // 手动设置 measureRef 的 DOM
    const container = document.createElement("div");
    const child1 = document.createElement("div");
    child1.getBoundingClientRect = vi.fn(() => ({
      top: 0, bottom: 30, height: 30, width: 400, left: 0, right: 400, x: 0, y: 0,
      toJSON: () => ({}),
    })) as unknown as () => DOMRect;

    const child2 = document.createElement("div");
    child2.getBoundingClientRect = vi.fn(() => ({
      top: 34, bottom: 64, height: 30, width: 400, left: 0, right: 400, x: 34, y: 0,
      toJSON: () => ({}),
    })) as unknown as () => DOMRect;

    container.appendChild(child1);
    container.appendChild(child2);
    result.current.measureRef.current = container;

    // 推进 timers 触发 doCalculate
    act(() => { vi.advanceTimersByTime(200); });

    // 两段都在一页内（第2段底部 64 < 200）
    expect(result.current.totalPages).toBe(1);
    expect(result.current.pages[0]).toEqual({ startIndex: 0, endIndex: 1 });
  });

  it("多段落自动分页", () => {
    const { result } = renderHook(() =>
      usePagination({
        paragraphs: ["段落1", "段落2", "段落3"],
        fontSize: 16,
        lineHeight: 1.5,
        fontWeight: 400,
        fontFamily: "sans-serif",
        paragraphSpacing: 4,
        contentWidth: 400,
        contentHeight: 100,
        enabled: true,
      })
    );

    const container = document.createElement("div");
    // 第1段：top=0, height=60 → 底部 60 < 100，第一页
    const child1 = document.createElement("div");
    child1.getBoundingClientRect = vi.fn(() => ({
      top: 0, bottom: 60, height: 60, width: 400, left: 0, right: 400, x: 0, y: 0,
      toJSON: () => ({}),
    })) as unknown as () => DOMRect;

    // 第2段：top=64, height=60 → 底部 124 > 100，分到下一页
    const child2 = document.createElement("div");
    child2.getBoundingClientRect = vi.fn(() => ({
      top: 64, bottom: 124, height: 60, width: 400, left: 0, right: 400, x: 64, y: 0,
      toJSON: () => ({}),
    })) as unknown as () => DOMRect;

    // 第3段：top=128, height=60
    // 第二页 pageBottom = 64 + 100 = 164
    // 第3段底部 188 > 164，分到第三页
    const child3 = document.createElement("div");
    child3.getBoundingClientRect = vi.fn(() => ({
      top: 128, bottom: 188, height: 60, width: 400, left: 0, right: 400, x: 128, y: 0,
      toJSON: () => ({}),
    })) as unknown as () => DOMRect;

    container.appendChild(child1);
    container.appendChild(child2);
    container.appendChild(child3);
    result.current.measureRef.current = container;

    act(() => { vi.advanceTimersByTime(200); });

    expect(result.current.totalPages).toBe(3);
    expect(result.current.pages[0]).toEqual({ startIndex: 0, endIndex: 0 });
    expect(result.current.pages[1]).toEqual({ startIndex: 1, endIndex: 1 });
    expect(result.current.pages[2]).toEqual({ startIndex: 2, endIndex: 2 });
  });

  it("单个段落超出一页（强制放在一页）", () => {
    const { result } = renderHook(() =>
      usePagination({
        paragraphs: ["很长的一段文字"],
        fontSize: 16,
        lineHeight: 1.5,
        fontWeight: 400,
        fontFamily: "sans-serif",
        paragraphSpacing: 4,
        contentWidth: 400,
        contentHeight: 50,
        enabled: true,
      })
    );

    const container = document.createElement("div");
    // 第1段高度 100 > 50，但只有一个段落，强制放在一页
    const child1 = document.createElement("div");
    child1.getBoundingClientRect = vi.fn(() => ({
      top: 0, bottom: 100, height: 100, width: 400, left: 0, right: 400, x: 0, y: 0,
      toJSON: () => ({}),
    })) as unknown as () => DOMRect;

    container.appendChild(child1);
    result.current.measureRef.current = container;

    act(() => { vi.advanceTimersByTime(200); });

    // 单个段落即使超出一页也强制放在一页
    expect(result.current.totalPages).toBe(1);
    expect(result.current.pages[0]).toEqual({ startIndex: 0, endIndex: 0 });
  });

  it("从 enabled=false 切换到 enabled=true 时开始计算", () => {
    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) =>
        usePagination({
          paragraphs: ["段落1"],
          fontSize: 16,
          lineHeight: 1.5,
          fontWeight: 400,
          fontFamily: "sans-serif",
          paragraphSpacing: 4,
          contentWidth: 400,
          contentHeight: 200,
          enabled: props.enabled,
        }),
      { initialProps: { enabled: false } }
    );

    // 初始：未启用，空页
    act(() => { vi.advanceTimersByTime(200); });
    expect(result.current.pages).toEqual([]);

    // 设置 DOM
    const container = document.createElement("div");
    const child = document.createElement("div");
    child.getBoundingClientRect = vi.fn(() => ({
      top: 0, bottom: 30, height: 30, width: 400, left: 0, right: 400, x: 0, y: 0,
      toJSON: () => ({}),
    })) as unknown as () => DOMRect;
    container.appendChild(child);
    result.current.measureRef.current = container;

    // 切换到 enabled=true
    rerender({ enabled: true });
    act(() => { vi.advanceTimersByTime(200); });

    expect(result.current.totalPages).toBe(1);
  });
});