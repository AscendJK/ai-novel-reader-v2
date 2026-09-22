/**
 * ai-state 测试：运行态是任务队列的派生值，不是谁都能写的布尔
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { getAiRunning, onAiRunningChange } from "../ai-state";
import { runAiTask, cancelAllAiTasks } from "../ai-task-queue";
import { useAiTaskStore } from "@/stores/ai-task-store";

afterEach(() => cancelAllAiTasks());
/** 挂住不放的任务：这样才看得见"运行态什么时候翻起来、什么时候落下去" */
function hold(novelId: string) {
  let finish!: () => void;
  const gate = new Promise<null>((resolve) => { finish = () => resolve(null); });
  const promise = runAiTask({ novelId, name: "占位", type: "chapter" }, async () => gate);
  return { promise, finish: () => finish() };
}

describe("ai-state", () => {
  it("没有任务时为 false", () => {
    expect(getAiRunning()).toBe(false);
  });

  it("在飞的任务让它为 true，任务收尾自动回落", () => {
    const a = hold("novel-A");
    expect(getAiRunning()).toBe(true);
    a.finish();
    return a.promise.then(() => {
      expect(getAiRunning()).toBe(false);
    });
  });

  it("排队中的任务同样算有活儿（它迟早要发请求）", () => {
    const first = hold("novel-A");
    runAiTask({ novelId: "novel-A", name: "排队的", type: "global" }, async () => null);
    expect(useAiTaskStore.getState().tasks.map((t) => t.status)).toEqual(["running", "queued"]);
    first.finish();
    return first.promise.then(() => {
      expect(getAiRunning()).toBe(true);
      cancelAllAiTasks();
      expect(getAiRunning()).toBe(false);
    });
  });

  it("运行态翻回 false 之后没人能再把它写脏：迟到的状态写入是空操作", async () => {
    const seen: Record<string, { status: (m: string) => void }> = {};
    const done = runAiTask({ novelId: "novel-迟到", name: "一", type: "chapter" }, async (ctx) => {
      seen["novel-迟到"] = ctx;
      return null;
    });
    await done;
    expect(getAiRunning()).toBe(false);
    seen["novel-迟到"].status("迟到的文案");
    expect(useAiTaskStore.getState().tasks).toEqual([]);
    expect(getAiRunning()).toBe(false);
  });

  it("onAiRunningChange 只在真的翻转时回调，取消订阅后不再收", () => {
    const listener = vi.fn();
    const unsubscribe = onAiRunningChange(listener);
    const a = hold("novel-A");
    // 同一条队列内部的加减条目不该被当成一次"运行态变化"重复通知
    const b = hold("novel-B");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(true);
    a.finish();
    b.finish();
    return Promise.all([a.promise, b.promise]).then(() => {
      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenLastCalledWith(false);
      unsubscribe();
      const c = hold("novel-A");
      expect(listener).toHaveBeenCalledTimes(2);
      c.finish();
      return c.promise;
    });
  });
});
