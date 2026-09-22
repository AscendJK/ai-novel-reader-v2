/**
 * useScreenWakeLock — 屏幕唤醒锁 hook 测试
 * 覆盖：激活请求 / 停用释放 / 页面回前台重新请求 / 不支持静默降级 / 卸载释放
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScreenWakeLock, wakeLockRecords, onWakeLockEvent } from "../useScreenWakeLock";

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
    renderHook(() => useScreenWakeLock(true, "基本-请求"));
    expect(requestMock).toHaveBeenCalledWith("screen");
  });

  it("active=false 时不请求", () => {
    renderHook(() => useScreenWakeLock(false, "基本-不请求"));
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("active true→false 时释放锁", async () => {
    const { rerender } = renderHook(({ on }: { on: boolean }) => useScreenWakeLock(on, "基本-开关"), {
      initialProps: { on: true },
    });
    expect(sentinel.release).not.toHaveBeenCalled();
    rerender({ on: false });
    await act(async () => {}); // 让 wakeLock.request 的 .then 微任务执行（disposed 分支释放）
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it("页面切后台（浏览器强制释放锁）后回到前台时重新请求", async () => {
    renderHook(() => useScreenWakeLock(true, "基本-后台"));
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
    expect(() => renderHook(() => useScreenWakeLock(true, "基本-不支持"))).not.toThrow();
  });

  it("卸载时释放锁", async () => {
    const { unmount } = renderHook(() => useScreenWakeLock(true, "基本-卸载"));
    expect(sentinel.release).not.toHaveBeenCalled();
    unmount();
    await act(async () => {}); // 微任务：.then 里 disposed → 释放刚获取的锁
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  // ── 可取证：息屏保活是移动端朗读的头号疑点，而"锁到底有没有拿到"以前看不见 ──

  const recordOf = (label: string) => wakeLockRecords().find((r) => r.label === label);

  it("申请到手要留下记录：持有中、没有拒绝原因", async () => {
    const { unmount } = renderHook(() => useScreenWakeLock(true, "取证-到手"));
    await act(async () => {});
    expect(recordOf("取证-到手")?.held).toBe(true);
    expect(recordOf("取证-到手")?.lastError ?? "").toBe("");
    unmount();
  });

  it("被系统释放要记下时刻，并把这一句推给时间线订阅者", async () => {
    const lines: string[] = [];
    const offListen = onWakeLockEvent((l) => lines.push(l));
    const { unmount } = renderHook(() => useScreenWakeLock(true, "取证-收锁"));
    await act(async () => {});
    const before = Date.now();
    act(() => { sentinel._trigger("release"); });

    const rec = recordOf("取证-收锁");
    expect(rec?.lastReleasedAt ?? 0).toBeGreaterThanOrEqual(before - 1000);
    // 认"已放开"这件事本身：标签名里也可能带"释放"两字，拿它当特征会连"到手"那行一起放过
    expect(lines.some((l) => l.includes("唤醒锁[取证-收锁]") && l.includes("已放开")), `时间线里没这一句：${lines.join(" | ")}`).toBe(true);
    offListen();
    unmount();
  });

  it("取消订阅之后不再往时间线里推", async () => {
    const lines: string[] = [];
    const offListen = onWakeLockEvent((l) => lines.push(l));
    offListen();
    const { unmount } = renderHook(() => useScreenWakeLock(true, "取证-退订"));
    await act(async () => {});
    act(() => { sentinel._trigger("release"); });
    expect(lines.filter((l) => l.includes("取证-退订"))).toEqual([]);
    unmount();
  });

  it("申请被拒时记下原因：静默降级不许降级成「看不出为什么没锁」", async () => {
    const denied = Object.assign(new Error("wake lock denied"), { name: "NotAllowedError" });
    requestMock.mockRejectedValueOnce(denied);
    renderHook(() => useScreenWakeLock(true, "取证-被拒"));
    await act(async () => {});

    expect(recordOf("取证-被拒")?.held).toBe(false);
    expect(recordOf("取证-被拒")?.lastError).toContain("NotAllowedError");
  });

  it("两条锁各记各的：自动阅读那条释放，不许把朗读显示成未持有", async () => {
    const reading = renderHook(() => useScreenWakeLock(true, "取证-朗读"));
    const autoRead = renderHook(() => useScreenWakeLock(true, "取证-自动阅读"));
    await act(async () => {});
    autoRead.unmount(); // 只放掉自动阅读这一把
    await act(async () => {});

    expect(recordOf("取证-朗读")?.held, "记录被两个调用方共用了一把，谁释放都算在对方头上").toBe(true);
    expect(recordOf("取证-自动阅读")?.held).toBe(false);
    reading.unmount();
  });
});
