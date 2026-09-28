/**
 * logger 模块测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ragLog, onRagLog, log, warn, error, installConsoleCapture } from "../logger";

describe("ragLog", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("调用 console.log 输出日志", () => {
    ragLog("测试消息");
    expect(console.log).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[RAG"));
  });

  it("日志包含中文时间戳前缀", () => {
    ragLog("测试消息");
    const call = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call).toMatch(/^\[RAG \d{1,2}:\d{2}:\d{2}\]/);
  });

  it("日志中包含原始消息", () => {
    ragLog("自定义消息 ABC");
    const call = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call).toContain("自定义消息 ABC");
  });

  it("通知已注册的监听器", () => {
    const listener = vi.fn();
    const unsubscribe = onRagLog(listener);
    ragLog("通知测试");
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.stringContaining("通知测试"));
    unsubscribe();
  });

  it("unsubscribe 后不再通知", () => {
    const listener = vi.fn();
    const unsubscribe = onRagLog(listener);
    unsubscribe();
    ragLog("取消后");
    expect(listener).not.toHaveBeenCalled();
  });

  it("监听器抛出异常时不会影响其他监听器", () => {
    const badListener = vi.fn(() => { throw new Error("bad"); });
    const goodListener = vi.fn();
    onRagLog(badListener);
    onRagLog(goodListener);
    expect(() => ragLog("异常测试")).not.toThrow();
    expect(goodListener).toHaveBeenCalledOnce();
  });

  it("多个监听器都收到通知", () => {
    const a = vi.fn();
    const b = vi.fn();
    onRagLog(a);
    onRagLog(b);
    ragLog("多监听器");
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });
});

describe("log / warn / error", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("log 调用 console.log 带 [App] 前缀", () => {
    log("应用消息");
    expect(console.log).toHaveBeenCalledWith("[App] 应用消息");
  });

  it("log 传递额外参数", () => {
    log("数据", { a: 1 }, 42);
    expect(console.log).toHaveBeenCalledWith("[App] 数据", { a: 1 }, 42);
  });

  it("warn 调用 console.warn", () => {
    warn("警告消息");
    expect(console.warn).toHaveBeenCalledWith("[App] 警告消息");
  });

  it("error 调用 console.error", () => {
    error("错误消息");
    expect(console.error).toHaveBeenCalledWith("[App] 错误消息");
  });
});
describe("installConsoleCapture（应用内日志转发）", () => {
  // 安装顺序有讲究：install 时会 bind 当前的 console.xxx，所以先换成 spy 再安装，
  // 既不让真实输出刷屏，又能观察到"原函数确实被调用"
  function withCapturedConsole() {
    const spies = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const originals = { log: console.log, warn: console.warn, error: console.error };
    console.log = spies.log; console.warn = spies.warn; console.error = spies.error;
    const uninstall = installConsoleCapture();
    const seen: string[] = [];
    const off = onRagLog((m) => { seen.push(m); });
    const restore = () => {
      off(); uninstall();
      console.log = originals.log; console.warn = originals.warn; console.error = originals.error;
    };
    return { spies, seen, restore };
  }

  it("既有 console.log 调用被转发给监听器，且原输出照常", () => {
    const { spies, seen, restore } = withCapturedConsole();
    try {
      console.log("同步开始", { a: 1 });
      expect(spies.log).toHaveBeenCalledWith("同步开始", { a: 1 });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("同步开始");
      expect(seen[0]).toMatch(/ LOG\]/);
    } finally { restore(); }
  });

  /**
   * 转写行首那一枚时刻必须与 `clockStamp` 同源（24 小时制、零填充）。
   *
   * 这一格是"唯一出处"搬家的另一半边：`logger.ts` 原来自己写 `toLocaleTimeString("zh-CN")`，
   * 看着无害，但它和 `debug-store.ts` 那枚不带 locale 的拼在一起，同一份真机自检报告里就
   * 同时出现 `[15:59:32 WARN]` 与 `[3:59:32 PM] 引擎切换`——拿相邻两行算停摆长度会多出 12 小时。
   */
  it("转写行首是 24 小时制的时刻，且 ragLog 那种带标签的行不会被再贴一枚", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 28, 15, 59, 32));
    const { seen, restore } = withCapturedConsole();
    try {
      console.warn("同步中");
      expect(seen[0], `行首不是那一把钟：${seen[0]}`).toBe("[15:59:32 WARN] 同步中");
      ragLog("建库开始");
      expect(seen[1]).toMatch(/^\[RAG 15:59:32\] /);
      // store 那一边认这两种行首，不会再贴第二枚（判据在 debug-store.test.ts，这里只钉形状）
      expect(seen[1].match(/\d{2}:\d{2}:\d{2}/g)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  it("warn/error 也转发并带级别；Error 与循环对象不会抛异常", () => {
    const { seen, restore } = withCapturedConsole();
    try {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      console.warn("警告", circular);
      console.error("失败", new Error("boom"));
      expect(seen.some((l) => / WARN\]/.test(l) && l.includes("[object Object]"))).toBe(true);
      expect(seen.some((l) => / ERROR\]/.test(l) && l.includes("boom"))).toBe(true);
    } finally { restore(); }
  });

  it("ragLog 自身的输出不被双份转发", () => {
    const { seen, restore } = withCapturedConsole();
    try {
      ragLog("只应出现一次");
      expect(seen.filter((l) => l.includes("只应出现一次"))).toHaveLength(1);
    } finally { restore(); }
  });

  it("重复安装不叠加包装（同一条日志不会被转发两次）", () => {
    const { seen, restore } = withCapturedConsole();
    try {
      const second = installConsoleCapture();     // 第二次应为 no-op
      console.log("一条消息");
      expect(seen.filter((l) => l.includes("一条消息"))).toHaveLength(1);
      second();
    } finally { restore(); }
  });
});
