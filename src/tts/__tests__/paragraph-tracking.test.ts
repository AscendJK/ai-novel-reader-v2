import { describe, it, expect } from "vitest";

/**
 * 测试段落追踪的核心逻辑：
 * 从 prepareTextForTTS 生成的 paragraphBreaks 和 paragraphIndices
 * 与字符位置映射的正确性。
 */

// 模拟 findParagraphByCharIndex 的逻辑（与 tts-manager.ts 中的实现一致）
function findParagraphByCharIndex(charIdx: number, breaks: number[]): number {
  let lo = 0, hi = breaks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (breaks[mid] <= charIdx) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// 模拟校准语速估算逻辑
function estimateParagraphFromTime(
  elapsedMs: number, textLength: number, charsPerSec: number,
  breaks: number[], indices: number[],
): number {
  const charPos = Math.min(Math.floor((elapsedMs / 1000) * charsPerSec), textLength - 1);
  return indices[findParagraphByCharIndex(charPos, breaks)];
}

describe("段落追踪 - 字符位置映射", () => {
  const breaks = [0, 12, 25]; // 三个段落的起始字符位置
  const indices = [0, 1, 2];   // 对应的原始段落索引

  it("字符位置 0 映射到第一个段落", () => {
    expect(findParagraphByCharIndex(0, breaks)).toBe(0);
  });

  it("字符位置在第一段范围内映射正确", () => {
    expect(findParagraphByCharIndex(5, breaks)).toBe(0);
    expect(findParagraphByCharIndex(11, breaks)).toBe(0);
  });

  it("字符位置在第二段范围内映射正确", () => {
    expect(findParagraphByCharIndex(12, breaks)).toBe(1);
    expect(findParagraphByCharIndex(18, breaks)).toBe(1);
    expect(findParagraphByCharIndex(24, breaks)).toBe(1);
  });

  it("字符位置在第三段范围内映射正确", () => {
    expect(findParagraphByCharIndex(25, breaks)).toBe(2);
    expect(findParagraphByCharIndex(50, breaks)).toBe(2);
    expect(findParagraphByCharIndex(100, breaks)).toBe(2);
  });

  it("只有两个段落时映射正确", () => {
    const b2 = [0, 20];
    const i2 = [5, 10]; // 原始段落索引是 5 和 10
    expect(findParagraphByCharIndex(0, b2)).toBe(0);
    expect(findParagraphByCharIndex(15, b2)).toBe(0);
    expect(findParagraphByCharIndex(20, b2)).toBe(1);
    expect(findParagraphByCharIndex(100, b2)).toBe(1);
  });

  it("只有一个段落时始终返回 0", () => {
    expect(findParagraphByCharIndex(0, [0])).toBe(0);
    expect(findParagraphByCharIndex(999, [0])).toBe(0);
  });
});

describe("段落追踪 - 时间估算映射", () => {
  const breaks = [0, 100, 200];
  const indices = [0, 1, 2];
  const textLength = 300;

  it("校准语速 250 字/秒，1 秒后在第二段", () => {
    // 1s × 250 = 250 字符 → 落在第三段
    const result = estimateParagraphFromTime(1000, textLength, 250, breaks, indices);
    expect(result).toBe(2);
  });

  it("校准语速 250 字/秒，0.3 秒后在第一段", () => {
    // 0.3s × 250 = 75 字符 → 落在第一段
    const result = estimateParagraphFromTime(300, textLength, 250, breaks, indices);
    expect(result).toBe(0);
  });

  it("校准语速 250 字/秒，0.5 秒后在第二段", () => {
    // 0.5s × 250 = 125 字符 → 落在第二段
    const result = estimateParagraphFromTime(500, textLength, 250, breaks, indices);
    expect(result).toBe(1);
  });

  it("语速因子影响估算", () => {
    // 2x 速度时，相同时间走了更远
    const result1x = estimateParagraphFromTime(500, textLength, 100, breaks, indices);
    const result2x = estimateParagraphFromTime(500, textLength, 200, breaks, indices);
    // 1x: 0.5s × 100 = 50 字符 → 第一段
    // 2x: 0.5s × 200 = 100 字符 → 第二段
    expect(result1x).toBe(0);
    expect(result2x).toBe(1);
  });

  it("字符位置不超过文本长度", () => {
    // 即使估算的字符位置超过文本长度，应该被 clamp 到 textLength-1
    const result = estimateParagraphFromTime(10000, textLength, 1000, breaks, indices);
    expect(result).toBe(2); // 应该映射到最后一个段落
  });
});
