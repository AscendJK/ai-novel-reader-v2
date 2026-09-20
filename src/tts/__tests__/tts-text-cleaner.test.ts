/**
 * 服务端 TTS 输入清洗（批次 G：把 routes/rag.js 里唯一那段纯逻辑挪出来锁住）
 *
 * 这段白名单是"朗读乱读"的第一道防线：Kokoro 词表外的字符不会被跳过，espeak-ng 会把
 * 它们硬拼成一串怪音——音色、语速都正常，内容却是胡话，界面上完全看不出输入有问题。
 * 原先它埋在 1400 行的路由文件里，那条文件在测试环境里 import 一次就会去清真实的
 * server/data/tts-temp 缓存目录，所以从来没人给它写过用例。
 */
import { describe, it, expect } from "vitest";

// @ts-expect-error - 后端 JS 模块无类型声明
const cleaner = await import("../../../server/lib/tts-text-cleaner.mjs");
const { cleanTtsText } = cleaner as { cleanTtsText: (raw: string) => string };

const U = (c: number) => String.fromCharCode(c);

describe("cleanTtsText：词表外字符换成空格而不是删掉", () => {
  it("假名、emoji、罗马数字、带圈字符各自换成一个空格", () => {
    expect(cleanTtsText("ひ")).toBe(" ");
    expect(cleanTtsText("Ⅴ")).toBe(" ");
    expect(cleanTtsText("①")).toBe(" ");
    expect(cleanTtsText("→")).toBe(" ");
    expect(cleanTtsText("©")).toBe(" ");
  });

  it("BMP 内清洗必须逐位等长：朗读进度按字符位置对齐，删字符会让高亮错位", () => {
    const src = "正常中文，测试。々〇・→①";
    expect(cleanTtsText(src)).toHaveLength(src.length);
    expect(cleanTtsText(src)).toBe("正常中文，测试。" + " ".repeat(5));
  });

  it("合法代理对（emoji）塌成一个空格，且清洗后不再含任何代理项", () => {
    const out = cleanTtsText(U(0xd83d) + U(0xde00));
    expect(out).toBe(" ");
    expect(/[\uD800-\uDFFF]/.test(out)).toBe(false);
  });
});

describe("cleanTtsText：能读的字不许被误伤", () => {
  it("常用中文、中文标点、ASCII 原样保留", () => {
    const src = "令狐冲说：「你在练剑？」Hello, world! 123 — …";
    expect(cleanTtsText(src)).toBe(src);
  });

  it("全角字母映射回 ASCII（实测逐字乱读），全角数字却原样保留（有正确读音）", () => {
    expect(cleanTtsText("ＡＢＣａｂｃ")).toBe("ABCabc");
    expect(cleanTtsText("０１２３４５６７８９")).toBe("０１２３４５６７８９");
  });

  it("全角空格换成半角；换行与制表符按白名单规则变成空格（词表外只放行可打印字符）", () => {
    expect(cleanTtsText(`${U(0x3000)}中`)).toBe(" 中");
    expect(cleanTtsText("a\nb\tc")).toBe("a b c");
  });
});

describe("cleanTtsText：孤立代理项必须消失", () => {
  it("未配对的高/低代理项被删除（带进 Python 会让 pybind11 直接报参数错误）", () => {
    expect(cleanTtsText(`a${U(0xd800)}b`)).toBe("ab");
    expect(cleanTtsText(U(0xdc00))).toBe("");
    expect(cleanTtsText(`${U(0xd800)}${U(0xd800)}${U(0xd800)}`)).toBe("");
  });

  it("夹在合法代理对中间的孤立项不能被误判成配对", () => {
    const out = cleanTtsText(U(0xd83d) + U(0xd83d) + U(0xde00));
    expect(/[\uD800-\uDFFF]/.test(out)).toBe(false);
  });
});

describe("cleanTtsText：清洗幂等", () => {
  it("对 1200 个 BMP 码位逐个清洗，再洗一次结果不变", () => {
    const all = Array.from({ length: 0x10000 }, (_, i) => U(i)).join("");
    const once = cleanTtsText(all);
    expect(cleanTtsText(once)).toBe(once);
  });

  it("白名单边界码位：只放行实测能读的那几个", () => {
    // 0x3005 々 在词表外（会被读成怪音），0x3001 、与 0x3002 。在词表内
    expect(cleanTtsText("、。")).toBe("、。");
    expect(cleanTtsText("々")).toBe(" ");
    // 半角片假名 ｱ 与假名 ｱ 同理：词表外
    expect(cleanTtsText("ｱ")).toBe(" ");
  });
});
