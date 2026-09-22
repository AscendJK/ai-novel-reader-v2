/**
 * AI 任务队列内核判据（AI 任务全局化 批次 1）
 *
 * 这批契约之所以住在模块层而不是组件里，是因为"折叠 AI 面板"今天会杀掉六个 agent
 * 的在飞任务（实测：本章总结/批量总结/全书总览/图谱/地图/问答全断）。要做成
 * "同书串行、异书并行、任务不随面板卸载而死"，调度权就必须离开 React 实例。
 * 下面九条就是这个内核的全部不变量，逐条对应一种会白烧用户 API 额度的坏法。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { runAiTask, cancelTask, cancelAllAiTasks, type AiTaskContext } from "../ai-task-queue";
import { getAiRunning } from "../../lib/ai-state";
import { useAiTaskStore } from "../../stores/ai-task-store";

/** 手动放行的 body：这样才拿得到"什么时候真的开始跑"这个事实 */
function makeGate() {
  const started: string[] = [];
  const resolvers: Array<(v: unknown) => void> = [];
  const bodies = async (name: string) => {
    started.push(name);
    return new Promise((resolve) => resolvers.push(resolve));
  };
  const release = () => resolvers.shift()?.(null);
  return { started, bodies, release, pending: () => resolvers.length };
}

const BOOK_A = "novel-A";
const BOOK_B = "novel-B";

beforeEach(() => {
  cancelAllAiTasks();
  expect(useAiTaskStore.getState().tasks).toEqual([]);
});

describe("同书串行", () => {
  it("同一本书的第二个任务排队，前一个跑完才开始", async () => {
    const g = makeGate();
    const first = runAiTask({ novelId: BOOK_A, name: "总结本章", type: "chapter" }, () => g.bodies("1"));
    const second = runAiTask({ novelId: BOOK_A, name: "全书总览", type: "global" }, () => g.bodies("2"));
    // 等一轮微任务，让排队的活儿有机会开始（不该开始）
    await Promise.resolve();
    expect(g.started).toEqual(["1"]);
    expect(g.pending()).toBe(1);

    g.release();
    await first;
    await Promise.resolve();
    expect(g.started).toEqual(["1", "2"]);

    g.release();
    await second;
    expect(useAiTaskStore.getState().tasks).toEqual([]);
  });

  it("连点三次按发起顺序排队，且界面上只有一个是 running", async () => {
    const g = makeGate();
    const runs = [
      runAiTask({ novelId: BOOK_A, name: "一", type: "chapter" }, () => g.bodies("1")),
      runAiTask({ novelId: BOOK_A, name: "二", type: "chapter" }, () => g.bodies("2")),
      runAiTask({ novelId: BOOK_A, name: "三", type: "chapter" }, () => g.bodies("3")),
    ];
    await Promise.resolve();
    const tasks = useAiTaskStore.getState().tasks;
    expect(tasks.map((t) => t.status)).toEqual(["running", "queued", "queued"]);
    expect(tasks.map((t) => t.name)).toEqual(["一", "二", "三"]);
    // 排队中的那两条必须有个能显示的文案，否则用户只看到按钮灰着、不知道在等什么
    expect(tasks[1].message).toContain("一");

    for (let i = 0; i < 2; i++) {
      g.release();
      await new Promise((r) => setTimeout(r, 0));
    }
    g.release();
    await Promise.all(runs);
  });
});

describe("异书并行", () => {
  it("不同书的任务同时在跑，互不排队", async () => {
    const g = makeGate();
    const a = runAiTask({ novelId: BOOK_A, name: "A 的总结", type: "chapter" }, () => g.bodies("A"));
    const b = runAiTask({ novelId: BOOK_B, name: "B 的总结", type: "chapter" }, () => g.bodies("B"));
    await Promise.resolve();
    expect(g.started.sort()).toEqual(["A", "B"]);
    expect(useAiTaskStore.getState().tasks.filter((t) => t.status === "running")).toHaveLength(2);

    g.release();
    g.release();
    await Promise.all([a, b]);
  });

  it("取消一本书的任务不影响另一本书在跑的活儿", async () => {
    const seen: Record<string, AiTaskContext> = {};
    const a = runAiTask({ novelId: BOOK_A, name: "A", type: "chapter" }, (ctx) => {
      seen[BOOK_A] = ctx;
      return new Promise(() => {});
    });
    const b = runAiTask({ novelId: BOOK_B, name: "B", type: "map" }, (ctx) => {
      seen[BOOK_B] = ctx;
      return new Promise(() => {});
    });
    await Promise.resolve();
    cancelTask(seen[BOOK_B].id);
    expect(seen[BOOK_B].signal.aborted).toBe(true);
    expect(seen[BOOK_A].signal.aborted).toBe(false);
    // A 那本的台账一个字都没被动过
    expect(useAiTaskStore.getState().tasks.filter((t) => t.novelId === BOOK_A).map((t) => t.name)).toEqual(["A"]);
    void a; void b;
  });
});

describe("取消与槽位回收", () => {
  it("排队中被取消：body 一次都不跑，promise 以 null 收尾", async () => {
    const g = makeGate();
    const first = runAiTask({ novelId: BOOK_A, name: "一", type: "chapter" }, () => g.bodies("1"));
    const second = runAiTask({ novelId: BOOK_A, name: "二", type: "global" }, () => g.bodies("2"));
    await Promise.resolve();
    const queuedId = useAiTaskStore.getState().tasks[1].id;

    cancelTask(queuedId);
    expect(await second).toBeNull();
    g.release();
    await first;

    expect(g.started).toEqual(["1"]);
    expect(useAiTaskStore.getState().tasks).toEqual([]);
  });

  it("body 抛错也必须释放同书槽位（否则一次失败永久卡死这本书）", async () => {
    const boom = new Error("厂商 500");
    const failed = runAiTask({ novelId: BOOK_A, name: "会挂", type: "chapter" }, async () => {
      throw boom;
    });
    await expect(failed).rejects.toBe(boom);
    expect(useAiTaskStore.getState().tasks).toEqual([]);

    let started = false;
    const next = runAiTask({ novelId: BOOK_A, name: "下一个", type: "chapter" }, async () => {
      started = true;
      return "ok";
    });
    expect(await next).toBe("ok");
    expect(started).toBe(true);
  });

  it("在飞的 body 不响应 abort 时，cancelAll 仍要立刻把运行态清零", async () => {
    // 这条钉的是"锁不泄漏"：同步链把 getAiRunning 当门控，一个赖着不走的 body
    // 不能让 AI 运行态永久挂在 true（症状是"按钮全灰、界面显示已同步却永不再上传"）
    const hanging = runAiTask({ novelId: BOOK_A, name: "赖着不走", type: "chapter" }, (ctx) => {
      return new Promise((resolve) => {
        ctx.signal.addEventListener("abort", () => setTimeout(() => resolve("迟到的结果"), 50));
      });
    });
    await Promise.resolve();
    expect(getAiRunning()).toBe(true);

    cancelAllAiTasks();
    expect(getAiRunning()).toBe(false);
    expect(useAiTaskStore.getState().tasks).toEqual([]);

    // body 之后照样落地，但不能把已经清空的状态又写回去
    await hanging;
    expect(getAiRunning()).toBe(false);
    expect(useAiTaskStore.getState().tasks).toEqual([]);
  });
});

describe("运行态是派生值，不是谁都能写的布尔", () => {
  it("queued 与 running 都算「有 AI 活儿」，收尾后自动回落", async () => {
    const g = makeGate();
    expect(getAiRunning()).toBe(false);
    const first = runAiTask({ novelId: BOOK_A, name: "一", type: "chapter" }, () => g.bodies("1"));
    expect(getAiRunning()).toBe(true);
    const second = runAiTask({ novelId: BOOK_B, name: "二", type: "chapter" }, () => g.bodies("2"));
    g.release();
    await first;
    expect(getAiRunning()).toBe(true);
    g.release();
    await second;
    expect(getAiRunning()).toBe(false);
  });

  it("任务结束后的 status/progress 写入是空操作，不会凭空复活条目", async () => {
    const seen: Record<string, AiTaskContext> = {};
    const done = runAiTask({ novelId: BOOK_A, name: "一", type: "chapter" }, async (ctx) => {
      seen[BOOK_A] = ctx;
      ctx.status("正在总结第 1/3 章");
      ctx.progress({ current: 1, total: 3 });
      return null;
    });
    await done;
    expect(useAiTaskStore.getState().tasks).toEqual([]);
    seen[BOOK_A].status("迟到的文案");
    seen[BOOK_A].progress({ current: 3, total: 3 });
    expect(useAiTaskStore.getState().tasks).toEqual([]);
  });
});
