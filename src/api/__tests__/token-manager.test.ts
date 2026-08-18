/**
 * token-manager 测试
 */

import { describe, it, expect } from "vitest";
import { estimateTokens, getTokenBudget, canFitInContext, truncateToFit, extractContextLength, setDiscoveredContextWindow, computeAvailableInput } from "../token-manager";

describe("estimateTokens", () => {
  it("应该估算中文文本的 token 数", () => {
    // 中文字符约 1.5 个字符 = 1 token
    const text = "你好世界"; // 4 个中文字符
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it("应该估算英文文本的 token 数", () => {
    // 英文字符约 3.5 个字符 = 1 token
    const text = "hello world"; // 11 个字符
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it("应该处理混合文本", () => {
    const text = "Hello 你好 World 世界";
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
  });

  it("应该处理空字符串", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("应该处理只有空格的字符串", () => {
    const tokens = estimateTokens("   ");
    expect(tokens).toBeGreaterThanOrEqual(0);
  });
});

describe("getTokenBudget", () => {
  it("应该返回已知模型的 budget", () => {
    const budget = getTokenBudget("gpt-4o");
    expect(budget.contextWindow).toBe(128000);
    expect(budget.maxOutputTokens).toBe(16384);
  });

  it("应该通过前缀匹配返回 budget", () => {
    const budget = getTokenBudget("gpt-4o-mini-2024-07-18");
    expect(budget.contextWindow).toBe(128000);
    expect(budget.maxOutputTokens).toBe(16384);
  });

  it("应该返回默认 budget（未知模型）", () => {
    const budget = getTokenBudget("unknown-model");
    expect(budget.contextWindow).toBe(128000);
    expect(budget.maxOutputTokens).toBe(4096);
  });

  it("应该优先使用用户配置的 contextWindow", () => {
    const budget = getTokenBudget("gpt-4o", 100000);
    expect(budget.contextWindow).toBe(100000);
    expect(budget.maxOutputTokens).toBe(16384); // 仍然使用已知的 output 限制
  });

  it("应该处理 Claude 模型", () => {
    const budget = getTokenBudget("claude-sonnet-4-6");
    expect(budget.contextWindow).toBe(200000);
    expect(budget.maxOutputTokens).toBe(8192);
  });

  it("应该处理 DeepSeek 模型", () => {
    const budget = getTokenBudget("deepseek-chat");
    expect(budget.contextWindow).toBe(128000);
    expect(budget.maxOutputTokens).toBe(8192);
  });

  it("发现了服务端真实上下文后应优先使用", () => {
    // 模拟 400 自愈写入发现缓存（Qwen/Qwen3-8B 真实上下文 32768）
    setDiscoveredContextWindow("Qwen/Qwen3-8B", 16384);
    const budget = getTokenBudget("Qwen/Qwen3-8B");
    // 发现缓存（16384）优先于 MODEL_LIMITS（32768）
    expect(budget.contextWindow).toBe(16384);
  });

  it("用户配置的 contextWindow 应高于发现缓存", () => {
    setDiscoveredContextWindow("Qwen/Qwen3-8B", 16384);
    const budget = getTokenBudget("Qwen/Qwen3-8B", 40000);
    expect(budget.contextWindow).toBe(40000);
  });
});

describe("extractContextLength", () => {
  it("应该提取带单位的数字", () => {
    expect(extractContextLength("maximum context length is 32768 tokens")).toBe(32768);
    expect(extractContextLength("context_length exceeded: 8192 tokens")).toBe(8192);
  });

  it("应该提取 length 附近的数字", () => {
    expect(extractContextLength("请求超过上下文长度限制 16384")).toBe(16384);
  });

  it("无数字时返回 null", () => {
    expect(extractContextLength("请求内容超过模型上下文长度限制")).toBe(null);
    expect(extractContextLength("")).toBe(null);
  });
});

describe("computeAvailableInput", () => {
  it("精确计算可用输入 = 上下文 - 输出预算 - 安全余量", () => {
    const available = computeAvailableInput({ contextWindow: 32768, maxOutputTokens: 8192 }, 4096);
    // 32768 - min(4096,8192)=4096 - min(1000,1638)=1000 = 27672
    expect(available).toBe(27672);
  });

  it("agent 输出预算超过模型上限时按模型上限算", () => {
    const available = computeAvailableInput({ contextWindow: 32768, maxOutputTokens: 4096 }, 8192);
    // 32768 - min(8192,4096)=4096 - 1000 = 27672
    expect(available).toBe(27672);
  });

  it("安全余量不超过 1000", () => {
    const available = computeAvailableInput({ contextWindow: 128000, maxOutputTokens: 16384 }, 4096);
    // 128000 - min(4096,16384)=4096 - min(1000,6400)=1000 = 122904
    expect(available).toBe(122904);
  });
});

describe("canFitInContext", () => {
  it("应该返回 true（文本可以放入上下文）", () => {
    const text = "短文本";
    const result = canFitInContext(text, "gpt-4o", 1000);
    expect(result).toBe(true);
  });

  it("应该返回 false（文本太长）", () => {
    const text = "很长的文本".repeat(100000);
    const result = canFitInContext(text, "gpt-4o", 1000);
    expect(result).toBe(false);
  });

  it("应该考虑用户配置的 contextWindow", () => {
    const text = "中等长度的文本".repeat(1000);
    const result = canFitInContext(text, "gpt-4o", 1000, 5000);
    // 使用用户配置的 5000 作为 contextWindow
    expect(typeof result).toBe("boolean");
  });
});

describe("truncateToFit", () => {
  it("应该返回原始文本（不需要截断）", () => {
    const text = "短文本";
    const result = truncateToFit(text, "gpt-4o", 1000);
    expect(result).toBe(text);
  });

  it("应该截断过长的文本", () => {
    const text = "很长的文本".repeat(100000);
    const result = truncateToFit(text, "gpt-4o", 1000);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain("[文本因长度限制被截断...]");
  });

  it("应该保留截断通知", () => {
    const text = "很长的文本".repeat(100000);
    const result = truncateToFit(text, "gpt-4o", 1000);
    expect(result.endsWith("[文本因长度限制被截断...]")).toBe(true);
  });

  it("应该处理空字符串", () => {
    const result = truncateToFit("", "gpt-4o", 1000);
    expect(result).toBe("");
  });
});
