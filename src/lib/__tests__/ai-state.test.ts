/**
 * ai-state 模块测试
 */
import { describe, it, expect, vi } from "vitest";
import { getAiRunning, setAiRunning, onAiRunningChange } from "../ai-state";

describe("ai-state", () => {
  it("初始状态为 false", () => {
    expect(getAiRunning()).toBe(false);
  });

  it("setAiRunning(true) 后 getAiRunning 返回 true", () => {
    setAiRunning(true);
    expect(getAiRunning()).toBe(true);
  });

  it("setAiRunning(false) 后 getAiRunning 返回 false", () => {
    setAiRunning(true);
    setAiRunning(false);
    expect(getAiRunning()).toBe(false);
  });

  it("onAiRunningChange 监听状态变化", () => {
    const listener = vi.fn();
    const unsubscribe = onAiRunningChange(listener);
    setAiRunning(true);
    expect(listener).toHaveBeenCalledWith(true);
    unsubscribe();
  });

  it("onAiRunningChange 返回取消订阅函数", () => {
    const listener = vi.fn();
    const unsubscribe = onAiRunningChange(listener);
    unsubscribe();
    setAiRunning(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("多个监听器都收到通知", () => {
    const a = vi.fn();
    const b = vi.fn();
    onAiRunningChange(a);
    onAiRunningChange(b);
    setAiRunning(true);
    expect(a).toHaveBeenCalledWith(true);
    expect(b).toHaveBeenCalledWith(true);
  });

  it("setAiRunning 相同值也会触发通知", () => {
    const listener = vi.fn();
    onAiRunningChange(listener);
    setAiRunning(false); // 初始就是 false
    expect(listener).toHaveBeenCalledWith(false);
  });
});