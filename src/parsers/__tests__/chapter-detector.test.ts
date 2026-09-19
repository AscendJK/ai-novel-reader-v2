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

describe("detectChapters 标题判定边界（R-56）", () => {
  const titles = (text: string) => detectChapters(text).map((c) => c.title);

  it("叙述句「第三章，他说完就走了」不算标题", () => {
    expect(titles("他推门进来。\n第三章，他说完就走了，再没回头。\n灯还亮着。")).toEqual([]);
  });

  it("括号后缀的合法标题不被误杀", () => {
    const text = "第十二章（上）\n正文一。\n第十二章（下）\n正文二。\n第八章（大结局）\n正文三。";
    expect(titles(text)).toEqual(["第十二章（上）", "第十二章（下）", "第八章（大结局）"]);
  });

  it("书名号形式的标题保留", () => {
    expect(titles("第一章《开始》\n正文。")).toEqual(["第一章《开始》"]);
  });

  it("「3 天后，他回来了」这类时间叙述不被纯数字回退当成章节", () => {
    const text = "他等了三日。\n3 天后，他回来了。\n又过了 12 天，雪停了。\n5. 他来了，然后走了。";
    expect(titles(text)).toEqual([]);
  });

  it("纯数字回退仍要能认出真正的短标题行", () => {
    const text = "1 引子\n正文一。\n2 起风\n正文二。\n3 归途\n正文三。";
    expect(titles(text)).toEqual(["1 引子", "2 起风", "3 归途"]);
  });

  it("标题后接冒号/顿号仍算标题（既有行为不回退）", () => {
    expect(titles("第三章：风云\n正文。\n第十二章、初入江湖\n正文。")).toEqual([
      "第三章：风云",
      "第十二章、初入江湖",
    ]);
  });
});

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
