/**
 * text-utils 测试
 */

import { describe, it, expect } from "vitest";
import { estimateReadingTime, formatCharCount, sliceTextByTokens } from "../text-utils";

describe("estimateReadingTime", () => {
  it("应该返回 '< 1 分钟'（很少的字符）", () => {
    expect(estimateReadingTime(100)).toBe("1 分钟");
  });

  it("应该返回分钟数", () => {
    expect(estimateReadingTime(1000)).toBe("2 分钟");
  });

  it("应该返回小时和分钟", () => {
    expect(estimateReadingTime(300000)).toContain("小时");
  });

  it("应该处理 0 字符", () => {
    expect(estimateReadingTime(0)).toBe("< 1 分钟");
  });

  it("应该正确计算 500 字符", () => {
    expect(estimateReadingTime(500)).toBe("1 分钟");
  });

  it("应该正确计算 10000 字符", () => {
    expect(estimateReadingTime(10000)).toBe("20 分钟");
  });
});

describe("formatCharCount", () => {
  it("应该返回字数（< 1000）", () => {
    expect(formatCharCount(500)).toBe("500 字");
  });

  it("应该返回千字（1000-9999）", () => {
    expect(formatCharCount(5000)).toBe("5.0 千字");
  });

  it("应该返回万字（>= 10000）", () => {
    expect(formatCharCount(50000)).toBe("5.0 万字");
  });

  it("应该处理 0 字符", () => {
    expect(formatCharCount(0)).toBe("0 字");
  });

  it("应该处理 999 字符", () => {
    expect(formatCharCount(999)).toBe("999 字");
  });

  it("应该处理 1000 字符", () => {
    expect(formatCharCount(1000)).toBe("1.0 千字");
  });

  it("应该处理 10000 字符", () => {
    expect(formatCharCount(10000)).toBe("1.0 万字");
  });
});

describe("sliceTextByTokens", () => {
  it("应该返回原始文本（不需要截断）", () => {
    const text = "短文本";
    const result = sliceTextByTokens(text, 1000);
    expect(result).toBe(text);
  });

  it("应该截断过长的文本", () => {
    const text = "很长的文本".repeat(10000);
    const result = sliceTextByTokens(text, 100);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain("[文本因Token限制被截断...]");
  });

  it("应该保留截断通知", () => {
    const text = "很长的文本".repeat(10000);
    const result = sliceTextByTokens(text, 100);
    expect(result.endsWith("[文本因Token限制被截断...]")).toBe(true);
  });

  it("应该处理空字符串", () => {
    const result = sliceTextByTokens("", 1000);
    expect(result).toBe("");
  });

  it("应该正确计算截断点", () => {
    const text = "a".repeat(100); // 100 个字符
    const result = sliceTextByTokens(text, 50); // maxChars = 50 * 1.5 = 75
    expect(result.length).toBeLessThanOrEqual(75 + 30); // 30 是通知的长度
  });
});
