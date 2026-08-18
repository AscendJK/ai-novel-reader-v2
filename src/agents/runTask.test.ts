/**
 * runTask 纯逻辑层测试
 * Agent 任务编排与 API 错误格式化，全部无 DOM 依赖。
 */

import { describe, it, expect, vi } from "vitest";
import type { Agent, AgentResult } from "./types";
import { runAgentTask, formatAPIError } from "./runTask";
import { APIError } from "@/api/error-handler";

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

describe("runAgentTask", () => {
  async function call(opts: Partial<Parameters<typeof runAgentTask>[1]>) {
    const hooks = makeHooks();
    const out = await runAgentTask(hooks, Object.assign({
      taskName: "任务", agent: makeAgent({ success: true }) as never, context: {} as never,
      errorMessage: "失败",
    }, opts) as never);
    return { hooks, out };
  }

  it("成功且 returnData 时返回 data", async () => {
    const { hooks, out } = await call({ agent: makeAgent({ success: true, data: 42 }), returnData: true });
    expect(out).toBe(42);
    expect(hooks.onStart).toHaveBeenCalled();
    expect(hooks.onDone).toHaveBeenCalledOnce(); expect(hooks.onPush).toHaveBeenCalledOnce();
  });
  it("失败返回 null 且调用 onError", async () => {
    const { hooks, out } = await call({ agent: makeAgent({ success: false, error: "x" }), returnData: true });
    expect(out).toBeNull();
    expect(hooks.onError).toHaveBeenCalledWith("x");
  });
  it("异常被 formatAPIError 处理", async () => {
    const { hooks, out } = await call({ agent: makeAgent({ reject: true } as never), returnData: true });
    expect(out).toBeNull();
    expect(hooks.onError).toHaveBeenCalledWith("boom");
  });
});

describe("formatAPIError", () => {
  it("映射 context_length", () => {
    expect(formatAPIError(new APIError("msg", "context_length"))).toContain("上下文超限");
  });
  it("普通 Error 返回 message", () => {
    expect(formatAPIError(new Error("普通"))).toBe("普通");
  });
});