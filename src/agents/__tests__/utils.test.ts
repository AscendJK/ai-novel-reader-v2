/**
 * agents/utils 测试
 */

import { describe, it, expect } from "vitest";
import {
  sampleChapterContent,
  splitTextIntoSegments,
  formatAgentError,
  sampleChapterTitles,
  isAbortError,
} from "../utils";
import { APIError } from "@/api/error-handler";

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

  it("选中的段落数有上限（防止超长节选）", () => {
    // 大量关键段落 + 足够的预算：修复前循环条件恒 false 会导致选中段落过多
    const paragraphs = Array.from({ length: 50 }, (_, i) => `第${i}段 这是一个突然的转折点。`);
    const content = paragraphs.join("\n\n");
    const result = sampleChapterContent(content, 5000);
    // 结果长度不应超过预算太多（有截断兜底，但选段应被限制）
    expect(result.length).toBeLessThanOrEqual(5100);
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

/**
 * 章节目录抽样与取消判定（round 2 批次 3 / R-40、取消语义）
 */
describe("sampleChapterTitles", () => {
  const titles = Array.from({ length: 1200 }, (_, i) => `第${i + 1}章 这是一个不算太短的章节标题`);

  it("预算充足时原样返回且不标记抽样", () => {
    const r = sampleChapterTitles(titles.slice(0, 5), 100000);
    expect(r.sampled).toBe(false);
    expect(r.text.split("\n")).toHaveLength(5);
  });

  it("超预算时抽样、含首尾并如实标注", () => {
    const r = sampleChapterTitles(titles, 400);
    expect(r.sampled).toBe(true);
    expect(r.kept).toBeGreaterThan(1);
    expect(r.kept).toBeLessThan(titles.length);
    expect(r.text.split("\n")[0]).toBe(titles[0]);
    expect(r.text).toContain(titles[titles.length - 1]);
    expect(r.text).toContain("等距抽样");
  });

  it("抽样结果确实落进预算（含标注行的容差）", () => {
    const r = sampleChapterTitles(titles, 400);
    // 标注行本身约 30 token，留 60 的余量给估算误差
    expect(r.text.length).toBeLessThan((400 + 60) * 2);
  });

  it("极端小预算与空列表都不崩", () => {
    expect(sampleChapterTitles([], 0).text).toBe("");
    const tiny = sampleChapterTitles(titles, 0);
    expect(tiny.text.length).toBeGreaterThan(0);
    expect(tiny.sampled).toBe(true);
  });
});

describe("isAbortError", () => {
  it("AbortError 与被中止的 signal 都判为取消", () => {
    expect(isAbortError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    const c = new AbortController();
    c.abort();
    expect(isAbortError(new Error("随便什么错误"), c.signal)).toBe(true);
  });

  it("普通失败不因措辞含「取消」被误判", () => {
    expect(isAbortError(new Error("Failed to fetch"))).toBe(false);
    expect(isAbortError(new APIError("请求频率过高，已被限流后取消排队", "rate_limit"))).toBe(false);
    expect(isAbortError("[rate_limit] 请求频率过高")).toBe(false);
  });

  it("字符串形式的取消措辞可识别", () => {
    expect(isAbortError("已取消")).toBe(true);
    expect(isAbortError("aborted")).toBe(true);
  });
});
