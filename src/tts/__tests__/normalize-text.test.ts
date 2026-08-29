import { describe, it, expect } from "vitest";
import { normalizeText } from "../zipvoice-engine";

describe("normalizeText（OOV 字符清洗）", () => {
  it("删除中文引号（词表 OOV 字符）", () => {
    expect(normalizeText("她说：“你好。”")).toBe("她说：你好。");
    expect(normalizeText("‘单引号’内容")).toBe("单引号内容");
  });

  it("删除英文引号", () => {
    expect(normalizeText('He said "hi"')).toBe("He said hi");
  });

  it("删除书名号/括号类装饰符号", () => {
    expect(normalizeText("《红楼梦》很好看")).toBe("红楼梦很好看");
    expect(normalizeText("【重要】通知")).toBe("重要通知");
    expect(normalizeText("「甲」和『乙』")).toBe("甲和乙");
  });

  it("省略号/破折号/间隔号转为空格", () => {
    expect(normalizeText("他……走了")).toBe("他 走了");
    expect(normalizeText("一二三——四")).toBe("一二三 四");
    expect(normalizeText("艾米莉·勃朗特")).toBe("艾米莉 勃朗特");
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

  it("中文引号删除后语句仍然可读", () => {
    const input = "他说：“今天的天气真好。”她又说：‘明天见。’";
    expect(normalizeText(input)).toBe("他说：今天的天气真好。她又说：明天见。");
  });
});
