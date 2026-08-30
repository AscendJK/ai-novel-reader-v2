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
    // 合法补充平面字符（U+10000，合法代理对）：不在 Kokoro 词表，会被硬拼成
    // 怪音乱读 → 白名单过滤转空格（保留停顿）
    expect(normalizeText("字\uD800\uDC00符")).toBe("字 符");
  });

  it("白名单过滤：CJK 兼容汉字/扩展 A/假名/々〇 等词表外字符转空格（防乱读）", () => {
    // CJK 兼容汉字（F900 区，实测逐字乱读 1.7s）
    expect(normalizeText("他叫\uF92C君。")).toBe("他叫 君。");
    // CJK 扩展 A（3400 区，实测乱读 1.4s）
    expect(normalizeText("大雪纷飞\u3400。")).toBe("大雪纷飞 。");
    // 假名（实测乱读 1.4s/字；开头假名转空格后被 trim）
    expect(normalizeText("こんにちは世界")).toBe("世界");
    // 々 〇（实测乱读 2.1s；〇 导致"二〇二四年"读成怪音）
    expect(normalizeText("二〇二四年")).toBe("二 二四年");
    expect(normalizeText("明々後日")).toBe("明 後日");
    // 带圈字符（实测乱读 1.4-2.6s）
    expect(normalizeText("第㊀章")).toBe("第 章");
    // 罗马数字 / 上标（实测乱读）
    expect(normalizeText("第Ⅻ章")).toBe("第 章");
    // ©®¤¨¬± 等 Latin-1 符号（实测读成英文符号名/怪音；句首空格被 trim）
    expect(normalizeText("©2024 版权所有")).toBe("2024 版权所有");
    // 数学/箭头符号（句首空格被 trim）
    expect(normalizeText("∑x→y")).toBe("x y");
    // 欧元等货币符号
    expect(normalizeText("价格€100")).toBe("价格 100");
  });

  it("白名单过滤：全角字母映射回 ASCII（实测全角字母逐字乱读）", () => {
    expect(normalizeText("ｆｕｃｋ")).toBe("fuck");
    expect(normalizeText("ＡＢＣ")).toBe("ABC");
    // 全角数字保留（espeak 读中文数字正常，"３８"读"三十八"）
    expect(normalizeText("他今年３８了")).toBe("他今年３８了");
  });

  it("白名单过滤：正常文本不受影响（中文/英文/数字/标点）", () => {
    expect(normalizeText("她推开窗，看见外面下起了大雪。It is 37.5°C！")).toBe("她推开窗，看见外面下起了大雪。It is 37.5°C！");
    expect(normalizeText("三·国演义")).toBe("三 国演义"); // · 按装饰符号规则转空格（既有语义）
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
