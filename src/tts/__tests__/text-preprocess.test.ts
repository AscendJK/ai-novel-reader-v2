import { describe, it, expect } from "vitest";
import { prepareTextForTTS } from "../text-preprocess";

describe("prepareTextForTTS", () => {
  it("空内容返回空数组", () => {
    expect(prepareTextForTTS("")).toEqual([]);
    expect(prepareTextForTTS("   ")).toEqual([]);
    expect(prepareTextForTTS(null as any)).toEqual([]);
  });

  it("单段落不合并", () => {
    const result = prepareTextForTTS("这是一段测试文本，用来验证段落处理逻辑。");
    expect(result.length).toBe(1);
    expect(result[0].paragraphIndices).toEqual([0]);
    expect(result[0].paragraphBreaks).toEqual([0]);
  });

  it("过短段落被过滤（< 5 字）", () => {
    const result = prepareTextForTTS("短。\n这是一个正常的段落内容。");
    expect(result.length).toBe(1);
    expect(result[0].paragraphIndices).toEqual([1]);
  });

  it("相邻短段落被合并", () => {
    const result = prepareTextForTTS(
      "第一段内容大约有三十个字符左右。\n第二段内容也大约有三十个字符左右。"
    );
    expect(result.length).toBe(1);
    expect(result[0].paragraphIndices).toEqual([0, 1]);
    expect(result[0].paragraphBreaks.length).toBe(2);
  });

  it("足够长的段落不合并（合计 > 150 字）", () => {
    // 每段需要清理后超过 80 字，合计才 > 150
    const longP1 = "这是第一段非常非常长的内容用来测试段落合并的阈值判断逻辑是否正确。这段文字必须足够长才能确保两个段落合计超过一百五十个字符的合并限制阈值标准。我们来仔细数一数字数是不是真的够长了。";
    const longP2 = "这是第二段非常非常长的内容也用来测试段落合并的阈值判断逻辑是否正确。这段文字也必须足够长才能确保两个段落合计超过一百五十个字符的合并限制阈值标准。我们来仔细数一数字数。";
    const result = prepareTextForTTS(`${longP1}\n${longP2}`);
    expect(result.length).toBe(2);
    expect(result[0].paragraphIndices).toEqual([0]);
    expect(result[1].paragraphIndices).toEqual([1]);
  });

  it("超长单段落按句子拆分", () => {
    const longText = "这是用来测试超长段落拆分的句子内容。".repeat(20);
    const result = prepareTextForTTS(longText);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.text.length).toBeLessThanOrEqual(350);
    }
  });

  it("合并段落的 paragraphBreaks 记录分割点", () => {
    // 使用足够长的段落以确保合并后 breaks 有多个值
    const p1 = "这是第一段内容用来测试段落合并后的分割点记录功能。";
    const p2 = "这是第二段内容用来测试段落合并后的分割点记录功能。";
    const result = prepareTextForTTS(`${p1}\n${p2}`);
    // 两段合并（合计 < 150）
    expect(result.length).toBe(1);
    const chunk = result[0];
    // paragraphBreaks 应该有两个值：[0, 第二段起始位置]
    expect(chunk.paragraphBreaks.length).toBe(2);
    expect(chunk.paragraphBreaks[0]).toBe(0);
    expect(chunk.paragraphBreaks[1]).toBeGreaterThan(0);
    expect(chunk.paragraphBreaks[1]).toBeLessThan(chunk.text.length);
  });

  it("HTML 标签被清除", () => {
    const result = prepareTextForTTS("<p>这是段落内容</p>\n<b>加粗文字</b>");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].text).not.toContain("<p>");
    expect(result[0].text).not.toContain("</p>");
  });

  it("引号替换为逗号", () => {
    const result = prepareTextForTTS('"你好"说他，"再见"说她。');
    expect(result.length).toBe(1);
    expect(result[0].text).not.toContain('"');
    expect(result[0].text).not.toContain('"');
  });

  it("多个 chunk 的 paragraphIndices 递增", () => {
    const p1 = "第一段内容大约有一百个字符左右，用来测试长段落的处理逻辑是否正确运行。这是一段比较长的内容。";
    const p2 = "第二段内容大约有一百个字符左右，用来验证分段功能的正确性运行。这是另一段比较长的内容。";
    const p3 = "第三段内容大约有一百个字符左右，确保多段落处理没有问题运行。这是第三段比较长的内容。";
    const result = prepareTextForTTS(`${p1}\n${p2}\n${p3}`);
    for (const chunk of result) {
      expect(chunk.paragraphIndices.length).toBeGreaterThan(0);
      for (let j = 1; j < chunk.paragraphIndices.length; j++) {
        expect(chunk.paragraphIndices[j]).toBeGreaterThan(chunk.paragraphIndices[j - 1]);
      }
    }
  });
});
