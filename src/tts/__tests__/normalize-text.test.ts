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

  it("删除孤立代理项（无效 Unicode，损坏的小说源数据）", () => {
    // \udcad / \udc82 是孤立代理项，pybind11 无法编码会导致服务端推理报错
    expect(normalizeText("湖北省\udcad汉市等多个地区\udc82")).toBe("湖北省汉市等多个地区");
    // 正常 emoji（合法代理对）不会被误删：保留后按 emoji 规则转空格
    expect(normalizeText("新年好\uD83C\uDF89再见")).toBe("新年好 再见");
    // 孤立高代理项（后无低代理项）→ 直接删除不留空格；孤立低代理项（前无高代理项）→ 删除
    expect(normalizeText("a\ud800b\udc00c")).toBe("abc");
    // 合法补充平面字符（U+10000，合法代理对）→ 保留
    expect(normalizeText("字\uD800\uDC00符")).toBe("字\uD800\uDC00符");
  });

  it("删除 U+FFFD 替换字符（�，损坏标记，Kokoro 读成怪音）", () => {
    expect(normalizeText("湖北省\uFFFD汉市等多个地区\uFFFD")).toBe("湖北省汉市等多个地区");
    // 与孤立代理项混合（用户实际报错场景）
    expect(normalizeText("湖北省\uFFFD\udcad\uFFFD汉市等多个地区\uFFFD\udc82")).toBe("湖北省汉市等多个地区");
    // 正常文本不受影响
    expect(normalizeText("湖北省武汉市等多个地区出现疫情。")).toBe("湖北省武汉市等多个地区出现疫情。");
  });

  it("中文引号替换为逗号后语句仍然可读", () => {
    const input = "他说：“今天的天气真好。”她又说：‘明天见。’";
    expect(normalizeText(input)).toBe("他说：今天的天气真好。她又说：明天见。");
  });
});
