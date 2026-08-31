/**
 * useScreenWakeLock — 屏幕唤醒锁 hook 测试
 * 覆盖：激活请求 / 停用释放 / 页面回前台重新请求 / 不支持静默降级 / 卸载释放
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScreenWakeLock } from "../useScreenWakeLock";

/** 模拟 WakeLockSentinel：release 会触发自身的 release 事件（同浏览器行为） */
function makeSentinel() {
  const listeners = new Map<string, () => void>();
  const release = vi.fn().mockImplementation(() => {
    listeners.get("release")?.();
    return Promise.resolve();
  });
  return {
    release,
    addEventListener: vi.fn((type: string, fn: () => void) => { listeners.set(type, fn); }),
    _trigger: (type: string) => listeners.get(type)?.(),
  };
}

type Sentinel = ReturnType<typeof makeSentinel>;

describe("useScreenWakeLock", () => {
  let requestMock: ReturnType<typeof vi.fn>;
  let sentinel: Sentinel;

  beforeEach(() => {
    sentinel = makeSentinel();
    requestMock = vi.fn().mockResolvedValue(sentinel);
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: requestMock },
    });
  });

  afterEach(() => {
    delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
  });

  it("active=true 时请求屏幕唤醒锁", () => {
    renderHook(() => useScreenWakeLock(true));
    expect(requestMock).toHaveBeenCalledWith("screen");
  });

  it("active=false 时不请求", () => {
    renderHook(() => useScreenWakeLock(false));
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("active true→false 时释放锁", async () => {
    const { rerender } = renderHook(({ on }: { on: boolean }) => useScreenWakeLock(on), {
      initialProps: { on: true },
    });
    expect(sentinel.release).not.toHaveBeenCalled();
    rerender({ on: false });
    await act(async () => {}); // 让 wakeLock.request 的 .then 微任务执行（disposed 分支释放）
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it("页面切后台（浏览器强制释放锁）后回到前台时重新请求", async () => {
    renderHook(() => useScreenWakeLock(true));
    expect(requestMock).toHaveBeenCalledTimes(1);
    await act(async () => {}); // 等锁获取完成（lock 赋值 + release 监听注册）

    // 切后台：浏览器释放锁（触发 release 事件），页面不可见时不应重新请求
    act(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      sentinel._trigger("release");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(requestMock).toHaveBeenCalledTimes(1);

    // 回前台：仍激活且无锁 → 重新请求
    act(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("浏览器不支持 wakeLock 时静默降级，不抛错", () => {
    delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
    expect(() => renderHook(() => useScreenWakeLock(true))).not.toThrow();
  });

  it("卸载时释放锁", async () => {
    const { unmount } = renderHook(() => useScreenWakeLock(true));
    expect(sentinel.release).not.toHaveBeenCalled();
    unmount();
    await act(async () => {}); // 微任务：.then 里 disposed → 释放刚获取的锁
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });
});
