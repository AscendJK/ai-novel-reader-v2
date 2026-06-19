/**
 * BaseAgent 抽象类
 * 封装 Agent 的公共逻辑，减少重复代码
 */

import type { Agent, AgentContext, AgentResult } from "./types";
import type { AIProvider } from "@/api/types";
import type { TokenBudget } from "@/api/token-manager";
import type { Novel } from "@/parsers/types";
import { prepareAgentContext, formatAgentError } from "./utils";
import { normalizeError, getUserFriendlyMessage } from "@/lib/error-handler";

/** Agent 运行环境 */
export interface AgentEnvironment {
  novel: Novel;
  provider: AIProvider;
  budget: TokenBudget;
}

/**
 * BaseAgent 抽象类
 *
 * 提供以下公共功能：
 * - 环境准备（加载小说、获取 Provider、Token 预算）
 * - 错误处理
 * - 统一的执行流程
 *
 * 子类只需实现 `execute` 方法
 */
export abstract class BaseAgent implements Agent {
  abstract name: string;
  abstract description: string;

  /**
   * 执行 Agent 任务（子类必须实现）
   * @param context Agent 上下文
   * @param env 运行环境
   * @returns Agent 结果
   */
  protected abstract execute(context: AgentContext, env: AgentEnvironment): Promise<AgentResult>;

  /**
   * 运行 Agent（公共入口）
   * 自动处理环境准备和错误捕获
   */
  async run(context: AgentContext): Promise<AgentResult> {
    // 准备运行环境
    const env = await this.prepareEnvironment(context);
    if (!env.success) {
      return { success: false, error: env.error };
    }

    try {
      return await this.execute(context, env);
    } catch (err) {
      return this.handleError(err);
    }
  }

  /**
   * 准备运行环境
   * 当 preRetrieved 已有内容时，只加载章节目录不加载内容（减少内存占用）
   * 子类可覆写此方法强制加载全书内容（如 SummarizerAgent）
   */
  protected async prepareEnvironment(context: AgentContext): Promise<
    | { success: true; novel: Novel; provider: AIProvider; budget: TokenBudget }
    | { success: false; error: string }
  > {
    const hasRetrieved = !!context.preRetrieved && context.preRetrieved.length >= 100;
    return prepareAgentContext(context, { loadAllContent: hasRetrieved ? false : undefined });
  }

  /**
   * 处理错误（使用统一错误处理）
   */
  protected handleError(err: unknown): AgentResult {
    const appError = normalizeError(err);
    const userMessage = getUserFriendlyMessage(appError);
    console.error(`[Agent:${this.name}] Error:`, appError.code, appError.message);

    return { success: false, error: userMessage };
  }
}

/**
 * 创建简单的 Agent（不需要类继承）
 * 适用于简单的 Agent 实现
 */
export function createSimpleAgent(
  name: string,
  description: string,
  execute: (context: AgentContext, env: AgentEnvironment) => Promise<AgentResult>
): Agent {
  return {
    name,
    description,
    async run(context: AgentContext): Promise<AgentResult> {
      const hasRetrieved = !!context.preRetrieved && context.preRetrieved.length >= 100;
      const envResult = await prepareAgentContext(context, { loadAllContent: hasRetrieved ? false : undefined });
      if (!envResult.success) {
        return { success: false, error: envResult.error };
      }

      try {
        return await execute(context, envResult);
      } catch (err) {
        const appError = normalizeError(err);
        const userMessage = getUserFriendlyMessage(appError);
        console.error(`[Agent:${name}] Error:`, appError.code, appError.message);
        return { success: false, error: userMessage };
      }
    },
  };
}
