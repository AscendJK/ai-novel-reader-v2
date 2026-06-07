/**
 * agents/utils 测试
 */

import { describe, it, expect } from "vitest";
import {
  sampleChapterContent,
  splitTextIntoSegments,
  findKeyParagraphs,
  formatAgentError,
} from "../utils";

describe("sampleChapterContent", () => {
  it("应该返回原始内容（如果不超过限制）", () => {
    const content = "这是一段短文本";
    const result = sampleChapterContent(content, 1000);
    expect(result).toBe(content);
  });

  it("应该截断过长的内容", () => {
    const content = "很长的文本".repeat(1000);
    const result = sampleChapterContent(content, 100);
    expect(result.length).toBeLessThanOrEqual(150); // 包含头部说明
  });

  it("应该保留关键段落", () => {
    const paragraphs = [
      "第一章 开始",
      "这是一个突然的转折点。",
      "中间的内容",
      "最后的结局",
    ];
    const content = paragraphs.join("\n\n");
    const result = sampleChapterContent(content, 100);
    expect(result).toContain("突然");
  });
});

describe("splitTextIntoSegments", () => {
  it("应该返回原始文本（如果不长）", () => {
    const text = "短文本";
    const result = splitTextIntoSegments(text, 1000);
    expect(result).toEqual([text]);
  });

  it("应该将长文本分成多段", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `段落 ${i + 1}: ${"内容".repeat(50)}`);
    const text = paragraphs.join("\n\n");
    const result = splitTextIntoSegments(text, 200);
    expect(result.length).toBeGreaterThan(1);
  });

  it("每段应该不超过最大长度", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `段落 ${i + 1}: ${"内容".repeat(50)}`);
    const text = paragraphs.join("\n\n");
    const maxChars = 200;
    const result = splitTextIntoSegments(text, maxChars);
    // 允许一些误差，因为段落不能分割
    result.forEach(segment => {
      expect(segment.length).toBeLessThanOrEqual(maxChars + 100);
    });
  });
});

describe("formatAgentError", () => {
  it("应该格式化 Error 对象", () => {
    const error = new Error("测试错误");
    const result = formatAgentError(error);
    expect(result).toBe("测试错误");
  });

  it("应该处理字符串错误（返回未知错误）", () => {
    const result = formatAgentError("字符串错误");
    expect(result).toBe("未知错误");
  });

  it("应该处理 null 错误", () => {
    const result = formatAgentError(null);
    expect(result).toBe("未知错误");
  });

  it("应该处理 undefined 错误", () => {
    const result = formatAgentError(undefined);
    expect(result).toBe("未知错误");
  });
});
