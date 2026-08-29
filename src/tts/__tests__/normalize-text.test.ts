import { describe, it, expect } from "vitest";
import { normalizeText } from "../zipvoice-engine";

describe("normalizeText（OOV 字符清洗）", () => {
  it("中文引号替换为逗号（保留停顿，与 prepareTextForTTS 一致）", () => {
    expect(normalizeText("她说：“你好。”")).toBe("她说：你好。");
    expect(normalizeText("‘单引号’内容")).toBe("，单引号，内容");
  });

  it("英文引号替换为逗号", () => {
    expect(normalizeText('He said "hi"')).toBe("He said ，hi，");
  });

  it("书名号/括号类装饰符号替换为逗号（保留停顿）；英文方括号删除", () => {
    expect(normalizeText("《红楼梦》很好看")).toBe("，红楼梦，很好看");
    expect(normalizeText("【重要】通知")).toBe("，重要，通知");
    expect(normalizeText("「甲」和『乙』")).toBe("，甲，和，乙，");
  });

  it("删除英文方括号（matcha 词表 OOV 字符，消除 Ignore OOV 警告）", () => {
    expect(normalizeText("[大家新年好]")).toBe("大家新年好");
    expect(normalizeText("收到[系统]提示")).toBe("收到系统提示");
  });

  it("连续标点清理：标点后紧跟的逗号删除", () => {
    expect(normalizeText("一二三——四")).toBe("一二三，四");
    expect(normalizeText("他说：“你好。”")).toBe("他说：你好。");
    expect(normalizeText("他说：‘明天见。’")).toBe("他说：明天见。");
  });

  it("压缩连续空白并去除首尾", () => {
    expect(normalizeText("  你好\u3000\u3000世界  ")).toBe("你好 世界");
    expect(normalizeText("a  b   c")).toBe("a b c");
  });

  it("保留句读标点（韵律控制）", () => {
    expect(normalizeText("你好，世界！这是一段。测试？")).toBe("你好，世界！这是一段。测试？");
  });

  it("空文本安全", () => {
    expect(normalizeText("")).toBe("");
    expect(normalizeText("   ")).toBe("");
  });

  it("中文引号替换为逗号后语句仍然可读", () => {
    const input = "他说：“今天的天气真好。”她又说：‘明天见。’";
    expect(normalizeText(input)).toBe("他说：今天的天气真好。她又说：明天见。");
  });
});
