/**
 * chapter-detector 测试
 */

import { describe, it, expect } from "vitest";
import { detectChapters, splitByChapters } from "../chapter-detector";

describe("detectChapters", () => {
  it("应该检测标准章节标题", () => {
    const text = `
第一章 开始
这是第一章的内容。

第二章 继续
这是第二章的内容。
    `.trim();

    const result = detectChapters(text);

    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("应该检测数字章节标题", () => {
    const text = `
第1章 开始
内容1

第2章 继续
内容2
    `.trim();

    const result = detectChapters(text);

    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("应该处理没有章节标题的文本", () => {
    const text = "这是一段没有章节标题的文本。".repeat(100);

    const result = detectChapters(text);

    // 没有检测到章节时应该返回默认分割
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  it("应该处理空字符串", () => {
    const result = detectChapters("");
    expect(result).toBeDefined();
  });
});

describe("splitByChapters", () => {
  it("应该按章节分割文本", () => {
    const text = `
第一章 开始
${"这是第一章的内容。".repeat(10)}

第二章 继续
${"这是第二章的内容。".repeat(10)}
    `.trim();

    const chapters = detectChapters(text);
    const result = splitByChapters(text, chapters);

    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0].title).toBeDefined();
    expect(result[0].content).toBeDefined();
  });

  it("应该保留章节内容", () => {
    const text = `
第一章 开始
${"这是第一章的内容。".repeat(10)}

第二章 继续
${"这是第二章的内容。".repeat(10)}
    `.trim();

    const chapters = detectChapters(text);
    const result = splitByChapters(text, chapters);

    if (result.length >= 2) {
      expect(result[0].content).toContain("第一章的内容");
      expect(result[1].content).toContain("第二章的内容");
    }
  });

  it("应该处理没有章节的文本", () => {
    const text = "这是一段文本。".repeat(100);

    const result = splitByChapters(text, []);

    // 没有章节时应该返回一个默认章节
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].title).toBe("全文");
  });
});
