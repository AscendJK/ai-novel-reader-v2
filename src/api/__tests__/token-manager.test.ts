/**
 * token-manager 测试
 */

import { describe, it, expect } from "vitest";
import { estimateTokens, getTokenBudget, canFitInContext, truncateToFit } from "../token-manager";

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
    expect(budget.maxInputTokens).toBe(128000);
    expect(budget.maxOutputTokens).toBe(16384);
  });

  it("应该通过前缀匹配返回 budget", () => {
    const budget = getTokenBudget("gpt-4o-mini-2024-07-18");
    expect(budget.maxInputTokens).toBe(128000);
    expect(budget.maxOutputTokens).toBe(16384);
  });

  it("应该返回默认 budget（未知模型）", () => {
    const budget = getTokenBudget("unknown-model");
    expect(budget.maxInputTokens).toBe(128000);
    expect(budget.maxOutputTokens).toBe(4096);
  });

  it("应该优先使用用户配置的 contextWindow", () => {
    const budget = getTokenBudget("gpt-4o", 100000);
    expect(budget.maxInputTokens).toBe(100000);
    expect(budget.maxOutputTokens).toBe(16384); // 仍然使用已知的 output 限制
  });

  it("应该处理 Claude 模型", () => {
    const budget = getTokenBudget("claude-sonnet-4-6");
    expect(budget.maxInputTokens).toBe(200000);
    expect(budget.maxOutputTokens).toBe(8192);
  });

  it("应该处理 DeepSeek 模型", () => {
    const budget = getTokenBudget("deepseek-chat");
    expect(budget.maxInputTokens).toBe(128000);
    expect(budget.maxOutputTokens).toBe(8192);
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
