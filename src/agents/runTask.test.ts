/**
 * runTask 纯逻辑层 — 深度测试
 * 扩展 Agent 任务编排与 API 错误格式化的边界用例
 */
import { describe, it, expect, vi } from "vitest";
import type { Agent, AgentContext, AgentResult } from "./types";
import { runAgentTask, formatAPIError } from "./runTask";
import { APIError, type APIErrorCode } from "@/api/error-handler";

function makeHooks() {
  return {
    onStart: vi.fn(), onStatus: vi.fn(), onError: vi.fn(), onDone: vi.fn(), onPush: vi.fn(),
  };
}

function makeAgent(result: Partial<AgentResult> & { reject?: boolean }): Agent {
  const fail = result.reject;
  const run = vi.fn(async () => {
    if (fail) throw new Error("boom");
    return result as AgentResult;
  });
  return { name: "t", taskType: "chapter", description: "d", run } as unknown as Agent;
}

function makeContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    novelId: "novel-1",
    chapterId: "ch-1",
    chapterContent: "内容",
    chapterTitle: "第一章",
    chapterIndex: 0,
    allChapters: [{ id: "ch-1", title: "第一章", index: 0 }],
    ...overrides,
  } as unknown as AgentContext;
}

describe("runAgentTask", () => {
  async function call(opts: Partial<Parameters<typeof runAgentTask>[1]> = {}) {
    const hooks = makeHooks();
    const out = await runAgentTask(hooks, Object.assign({
      taskName: "任务",
      agent: makeAgent({ success: true }) as never,
      context: makeContext(),
      errorMessage: "失败",
    }, opts) as never);
    return { hooks, out };
  }

  it("成功时调用 onStart/onDone/onPush", async () => {
    const { hooks } = await call();
    expect(hooks.onStart).toHaveBeenCalledWith("任务", "chapter");
    expect(hooks.onDone).toHaveBeenCalledOnce();
    expect(hooks.onPush).toHaveBeenCalledOnce();
  });

  it("成功且 returnData 时返回 data", async () => {
    const { out } = await call({ agent: makeAgent({ success: true, data: { result: "ok" } }), returnData: true });
    expect(out).toEqual({ result: "ok" });
  });

  it("returnData=false 时返回 undefined", async () => {
    const { out } = await call({ returnData: false });
    expect(out).toBeUndefined();
  });

  it("失败返回 null 且调用 onError", async () => {
    const { hooks, out } = await call({ agent: makeAgent({ success: false, error: "x" }), returnData: true });
    expect(out).toBeNull();
    expect(hooks.onError).toHaveBeenCalledWith("x");
  });

  it("异常被 formatAPIError 处理并调用 onError", async () => {
    const { hooks, out } = await call({ agent: makeAgent({ reject: true } as never), returnData: true });
    expect(out).toBeNull();
    expect(hooks.onError).toHaveBeenCalledWith("boom");
  });

  it("agent.run 被调用时传入正确的 context", async () => {
    const agent = makeAgent({ success: true });
    await call({ agent: agent as never, context: makeContext({ chapterIds: ["ch-42"] }) });
    expect(agent.run).toHaveBeenCalledWith(
      expect.objectContaining({ chapterIds: ["ch-42"] })
    );
  });

  it("onSuccess 回调在成功时被调用", async () => {
    const onSuccess = vi.fn(async () => {});
    await call({ onSuccess });
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("onSuccess 抛出异常时不会影响主流程", async () => {
    const onSuccess = vi.fn(async () => { throw new Error("save failed"); });
    const { hooks, out } = await call({ onSuccess, returnData: true });
    expect(out).toBeNull();
    expect(hooks.onError).toHaveBeenCalledWith("save failed");
  });

  it("agent.run 返回 null 时视为失败", async () => {
    const agent = makeAgent({ success: false });
    const { hooks } = await call({ agent: agent as never });
    expect(hooks.onError).toHaveBeenCalled();
  });

  it("taskType 优先于 agent.taskType 和 taskName", async () => {
    const hooks = makeHooks();
    const agent = makeAgent({ success: true });
    await runAgentTask(hooks, {
      taskName: "任务名",
      taskType: "custom-type",
      agent: agent as never,
      context: makeContext(),
      errorMessage: "失败",
    } as never);
    expect(hooks.onStart).toHaveBeenCalledWith("任务名", "custom-type");
  });

  it("没有 taskType 时使用 agent.taskType", async () => {
    const hooks = makeHooks();
    const agent = { ...makeAgent({ success: true }), taskType: "agent-type" };
    await runAgentTask(hooks, {
      taskName: "任务名",
      agent: agent as never,
      context: makeContext(),
      errorMessage: "失败",
    } as never);
    expect(hooks.onStart).toHaveBeenCalledWith("任务名", "agent-type");
  });
});

describe("formatAPIError", () => {
  it("映射 context_length", () => {
    expect(formatAPIError(new APIError("msg", "context_length"))).toContain("上下文超限");
  });

  it("映射 auth", () => {
    expect(formatAPIError(new APIError("msg", "auth"))).toContain("认证失败");
  });

  it("映射 quota_exceeded", () => {
    expect(formatAPIError(new APIError("msg", "quota_exceeded"))).toContain("额度用尽");
  });

  it("映射 rate_limit", () => {
    expect(formatAPIError(new APIError("msg", "rate_limit"))).toContain("频率限制");
  });

  it("映射 network", () => {
    expect(formatAPIError(new APIError("msg", "network"))).toContain("网络错误");
  });

  it("未知 APIError code 返回 [code] message", () => {
    expect(formatAPIError(new APIError("自定义错误", "unknown_code" as APIErrorCode))).toBe("[unknown_code] 自定义错误");
  });

  it("普通 Error 返回 message", () => {
    expect(formatAPIError(new Error("普通"))).toBe("普通");
  });

  it("字符串错误返回 '未知错误'", () => {
    expect(formatAPIError("string error")).toBe("未知错误");
  });

  it("null 返回 '未知错误'", () => {
    expect(formatAPIError(null)).toBe("未知错误");
  });

  it("undefined 返回 '未知错误'", () => {
    expect(formatAPIError(undefined)).toBe("未知错误");
  });

  it("APIError 同时有 apiCode 和 code 时优先用 apiCode", () => {
    const err = new APIError("msg", "context_length");
    expect(formatAPIError(err)).toContain("上下文超限");
  });
});

/**
 * 取消 ≠ 失败（round 2 批次 3 / round 1 遗留）
 *
 * 旧实现把 AbortError 一路当失败：章节循环会把"总结生成失败: aborted"当成
 * 正文写进数据库，用户还会看到红色错误提示。
 */
describe("runAgentTask 的取消语义", () => {
  const abortError = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

  it("agent 抛出 AbortError 时静默收尾，不报错误", async () => {
    const hooks = makeHooks();
    const agent = {
      name: "t", taskType: "chapter", description: "d",
      run: vi.fn(async () => { throw abortError(); }),
    } as unknown as Agent;
    const out = await runAgentTask(hooks, {
      taskName: "任务", agent, context: makeContext(), errorMessage: "失败",
    } as never);
    expect(out).toBeUndefined();
    expect(hooks.onError).not.toHaveBeenCalled();
    expect(hooks.onDone).toHaveBeenCalledOnce();
  });

  it("signal 已中止时普通错误也按取消处理（不再弹错误）", async () => {
    const controller = new AbortController();
    controller.abort();
    const hooks = makeHooks();
    const agent = {
      name: "t", taskType: "chapter", description: "d",
      run: vi.fn(async () => { throw new Error("请求超时"); }),
    } as unknown as Agent;
    await runAgentTask(hooks, {
      taskName: "任务", agent, context: makeContext({ signal: controller.signal }), errorMessage: "失败",
    } as never);
    expect(hooks.onError).not.toHaveBeenCalled();
  });

  it("cancelled 结果仍然保存部分成果且不报错误", async () => {
    const hooks = makeHooks();
    const onSuccess = vi.fn();
    const agent = makeAgent({ success: true, data: { summaries: [1, 2] }, cancelled: true });
    const out = await runAgentTask(hooks, {
      taskName: "任务", agent, context: makeContext(), errorMessage: "失败", onSuccess, returnData: true,
    } as never);
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(hooks.onError).not.toHaveBeenCalled();
    expect(out).toEqual({ summaries: [1, 2] });
  });

  it("result.error 写着已取消时不算失败", async () => {
    const hooks = makeHooks();
    const agent = makeAgent({ success: false, error: "已取消", cancelled: true });
    await runAgentTask(hooks, {
      taskName: "任务", agent, context: makeContext(), errorMessage: "失败",
    } as never);
    expect(hooks.onError).not.toHaveBeenCalled();
  });

  it("真实失败仍然照报（不能被取消判定吞掉）", async () => {
    const hooks = makeHooks();
    const agent = makeAgent({ success: false, error: "[rate_limit] 请求频率过高" });
    await runAgentTask(hooks, {
      taskName: "任务", agent, context: makeContext(), errorMessage: "失败",
    } as never);
    expect(hooks.onError).toHaveBeenCalledWith("[rate_limit] 请求频率过高");
  });

  it("普通网络失败不被误判为取消", async () => {
    const hooks = makeHooks();
    const agent = {
      name: "t", taskType: "chapter", description: "d",
      run: vi.fn(async () => { throw new APIError("Failed to fetch", "network"); }),
    } as unknown as Agent;
    await runAgentTask(hooks, {
      taskName: "任务", agent, context: makeContext(), errorMessage: "失败",
    } as never);
    expect(hooks.onError).toHaveBeenCalledOnce();
  });
});