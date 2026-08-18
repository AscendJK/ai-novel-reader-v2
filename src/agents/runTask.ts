/**
 * runTask — Agent 任务编排的纯逻辑层（0 依赖 React）。
 *
 * 从 useSummarizer 中抽取。职责：驱动一个 Agent 从「开始」到「结束」，
 * 处理成功/失败/取消，并通过回调把状态变化通知给调用方（UI hook 或测试）。
 * 不持有 React state，因此可被多个 hook 与单测复用。
 */

import type { Agent, AgentContext, AgentResult, TaskTypeValue } from "./types";
import { APIError } from "@/api/error-handler";

/** UI 状态更新回调集合（由 React hook 注入） */
export interface TaskStatusHooks {
  /** 任务开始（name=展示名, type=任务类型标识） */
  onStart: (name: string, type?: string) => void;
  /** 更新进度/状态文案 */
  onStatus: (message: string) => void;
  /** 记录一条任务错误（已格式化为用户可读文案） */
  onError: (message: string) => void;
  /** 任务结束（无论成败） */
  onDone: () => void;
  /** 任务完成后立即同步一次（推送增量到服务器） */
  onPush: () => void;
}

export interface AgentTaskOptions {
  taskName: string;
  agent: Agent;
  context: AgentContext;
  errorMessage: string;
  /** 成功回调：保存结果到 DB 等副作用 */
  onSuccess?: (result: AgentResult) => Promise<void>;
  /** 是否返回 result.data */
  returnData?: boolean;
  /** 任务类型标识：优先用这个，其次 agent.taskType，最后回退 taskName */
  taskType?: TaskTypeValue;
}

/**
 * 将 APIError 映射为可读错误文案（纯函数，便于复用与测试）。
 */
export function formatAPIError(err: unknown): string {
  if (err instanceof APIError) {
    const code = err.apiCode || err.code;
    if (code === "context_length") return `[上下文超限] ${err.message}`;
    if (code === "auth") return `[认证失败] ${err.message}`;
    if (code === "quota_exceeded") return `[额度用尽] ${err.message}`;
    if (code === "rate_limit") return `[频率限制] ${err.message}`;
    if (code === "network") return `[网络错误] ${err.message}`;
    return `[${code}] ${err.message}`;
  }
  return err instanceof Error ? err.message : "未知错误";
}

/**
 * 执行单个 Agent 任务，负责完整生命周期与结果归约。
 *
 * @returns returnData 为 true 时返回 result.data（失败返回 null），否则返回 undefined
 */
export async function runAgentTask(
  hooks: TaskStatusHooks,
  options: AgentTaskOptions
): Promise<unknown> {
  const { taskName, agent, context, errorMessage, onSuccess, returnData, taskType } = options;
  hooks.onStart(taskName, taskType || agent.taskType);
  try {
    const result = await agent.run(context);
    if (result.success) {
      if (onSuccess) {
        hooks.onStatus("正在保存结果...");
        await onSuccess(result);
      }
      return returnData ? result.data : undefined;
    } else {
      hooks.onError(result.error || errorMessage);
      return returnData ? null : undefined;
    }
  } catch (err) {
    hooks.onError(formatAPIError(err));
    return returnData ? null : undefined;
  } finally {
    hooks.onDone();
    hooks.onPush();
  }
}