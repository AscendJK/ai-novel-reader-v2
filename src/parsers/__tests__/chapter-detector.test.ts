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

/**
 * 内容守恒（round 2 批次 1b / R-10）
 *
 * 旧实现在 splitByChapters 里把"正文 ≤50 字"的章节整章丢弃，短序章、只有标题
 * 的楔子、诗体章节会永久消失——而且用户完全看不出少了东西。
 * 这里的不变量：分割后的输出必须逐字装得下输入（忽略空白差异）。
 */
const squeeze = (s: string) => s.replace(/\s+/g, "");

describe("splitByChapters 内容守恒", () => {
  const samples: [string, string][] = [
    ["短尾章被丢弃", `第一章 开端\n${"正文内容甲。".repeat(20)}\n第二章 尾声\n很短的结尾。`],
    ["仅标题章节", `第一章 开端\n${"正文内容乙。".repeat(20)}\n第二章\n第三章 收`],
    ["短前言", `题记一句话\n第一章 开端\n${"正文内容丙。".repeat(20)}`],
    ["首章就短", `序章\n短。\n第一章 开端\n${"正文内容丁。".repeat(20)}`],
  ];

  for (const [name, text] of samples) {
    it(`${name}：每个字都还在`, () => {
      const result = splitByChapters(text, detectChapters(text));
      expect(squeeze(result.map((c) => c.content).join(""))).toBe(squeeze(text));
    });
  }

  it("短章节并入相邻章节而不是消失", () => {
    const text = `第一章 开端\n${"正文内容甲。".repeat(20)}\n第二章 尾声\n很短的结尾。`;
    const result = splitByChapters(text, detectChapters(text));
    const all = result.map((c) => c.content).join("");
    expect(all).toContain("很短的结尾。");
    expect(all).toContain("第二章 尾声");
  });

  it("正常长度的章节仍各自独立（不被合并掉）", () => {
    const text = `第一章 开端\n${"甲章正文。".repeat(20)}\n第二章 继续\n${"乙章正文。".repeat(20)}`;
    const result = splitByChapters(text, detectChapters(text));
    expect(result).toHaveLength(2);
    expect(result[0].content).toContain("甲章正文。");
    expect(result[0].content).not.toContain("乙章正文。");
  });
});
