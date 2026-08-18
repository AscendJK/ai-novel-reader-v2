/**
 * logger 模块测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ragLog, onRagLog, log, warn, error } from "../logger";

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