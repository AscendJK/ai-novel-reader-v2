import { describe, it, expect } from "vitest";
import { findParagraphByCharIndex, mapProgressToParagraph } from "../tts-manager";

/**
 * 测试段落追踪的核心逻辑：
 * 从 prepareTextForTTS 生成的 paragraphBreaks 和 paragraphIndices
 * 与字符位置映射的正确性（Web Speech onboundary 与 ZipVoice 时间估算共用）。
 */

describe("段落追踪 - 字符位置映射", () => {
  const breaks = [0, 12, 25]; // 三个段落的起始字符位置

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

describe("段落追踪 - 时间估算映射（ZipVoice 音频进度）", () => {
  const breaks = [0, 100, 200];
  const indices = [0, 1, 2];
  const textLength = 300;

  it("进度 0 映射到第一个段落", () => {
    expect(mapProgressToParagraph(0, textLength, breaks, indices)).toBe(0);
  });

  it("进度 1/3 映射到第二段起点", () => {
    // 0.33 × 300 = 100 字符 = 第二段起点 → 段落 1
    expect(mapProgressToParagraph(1 / 3, textLength, breaks, indices)).toBe(1);
  });

  it("进度 1/2 映射到第二段", () => {
    // 0.5 × 300 = 150 字符 → 段落 1
    expect(mapProgressToParagraph(0.5, textLength, breaks, indices)).toBe(1);
  });

  it("进度 2/3 映射到第三段起点", () => {
    // 0.67 × 300 = 200 字符 = 第三段起点 → 段落 2
    expect(mapProgressToParagraph(2 / 3, textLength, breaks, indices)).toBe(2);
  });

  it("进度 1 映射到最后一段", () => {
    expect(mapProgressToParagraph(1, textLength, breaks, indices)).toBe(2);
  });

  it("进度越界时 clamp（不越界报错）", () => {
    expect(mapProgressToParagraph(-1, textLength, breaks, indices)).toBe(0);
    expect(mapProgressToParagraph(2, textLength, breaks, indices)).toBe(2);
  });

  it("与 Web Speech 语速估算换算一致", () => {
    // 校准语速 250 字/秒，1 秒后：charPos=250 → 段落 2
    // 换算为进度：250 / 300
    const charPos = 250;
    const progress = charPos / textLength;
    expect(mapProgressToParagraph(progress, textLength, breaks, indices)).toBe(2);
    // 0.3 秒 × 250 = 75 字符 → 段落 0
    expect(mapProgressToParagraph(75 / textLength, textLength, breaks, indices)).toBe(0);
  });

  it("空 breaks/indices 返回 null（不追踪）", () => {
    expect(mapProgressToParagraph(0.5, textLength, [], [])).toBeNull();
  });
});

describe("段落追踪 - 多段 chunk（合并组）进度映射", () => {
  it("三段 chunk：进度均匀推进时逐段高亮", () => {
    // 模拟 prepareTextForTTS 合并组：三段各 20 字，breaks=[0,20,40]，总 60 字
    const breaks = [0, 20, 40];
    const indices = [3, 4, 5]; // 原始段落索引 3/4/5
    expect(mapProgressToParagraph(0, 60, breaks, indices)).toBe(3);
    expect(mapProgressToParagraph(0.3, 60, breaks, indices)).toBe(3);
    expect(mapProgressToParagraph(0.4, 60, breaks, indices)).toBe(4);
    expect(mapProgressToParagraph(0.6, 60, breaks, indices)).toBe(4);
    expect(mapProgressToParagraph(0.7, 60, breaks, indices)).toBe(5);
    expect(mapProgressToParagraph(1, 60, breaks, indices)).toBe(5);
  });
});
