/**
 * TXT 编码识别与手动覆盖测试（批次 7c：R-57）
 *
 * 旧实现只有 GBK/UTF-8 两套启发式：繁体书（Big5）会被判成 GBK，整本解成形近
 * 错字/私用区乱码；而且 ParserOptions.encoding 没被上层暴露，用户没有纠错入口。
 */
import { describe, it, expect } from "vitest";
import { parseTxt } from "../txt";

const SAMPLE = "從前有一座城市，城裡住著一個寫書的人。\n第一章 城市與筆\n他每天清晨起床，寫下三行字。";
const SIMPLIFIED = "从前有一座城市，城里住着一个写书的人。\n第一章 开始\n他每天写下三行字。";

/** sample.encode("big5") */
const BIG5_BYTES = Uint8Array.from([
  177, 113, 171, 101, 166, 179, 164, 64, 174, 121, 171, 176, 165, 171, 161, 65,
  171, 176, 184, 204, 166, 237, 181, 219, 164, 64, 173, 211, 188, 103, 174, 209,
  170, 186, 164, 72, 161, 67, 10, 178, 196, 164, 64, 179, 185, 32, 171, 176, 165,
  171, 187, 80, 181, 167, 10, 165, 76, 168, 67, 164, 209, 178, 77, 177, 225, 176,
  95, 167, 201, 161, 65, 188, 103, 164, 85, 164, 84, 166, 230, 166, 114, 161, 67,
]);

/** sample.encode("gb2312") —— PowerShell [Text.Encoding]::GetEncoding(936) 实测产物 */
const GBK_BYTES = Uint8Array.from([
  180, 211, 199, 176, 211, 208, 210, 187, 215, 249, 179, 199, 202, 208, 163, 172, 179, 199, 192, 239, 215, 161, 215,
  197, 210, 187, 184, 246, 208, 180, 202, 233, 181, 196, 200, 203, 161, 163, 10, 181, 218, 210, 187, 213, 194, 32,
  191, 170, 202, 188, 10, 203, 251, 195, 191, 204, 236, 208, 180, 207, 194, 200, 253, 208, 208, 215, 214, 161, 163,
]);

/** 不借浏览器编码器，逐码元手写字节：这样 fixture 与断言不会各自漂移 */
function toUtf16Bytes(s: string, littleEndian: boolean): Uint8Array<ArrayBuffer> {
  const units = Array.from(s, (ch) => ch.codePointAt(0) ?? 0);
  const bytes = new Uint8Array(units.length * 2);
  const view = new DataView(bytes.buffer);
  units.forEach((u, i) => view.setUint16(i * 2, u, littleEndian));
  return bytes;
}

function asFile(bytes: Uint8Array<ArrayBuffer>, name: string): File {
  return new File([bytes], name, { type: "text/plain" });
}

const allText = (r: Awaited<ReturnType<typeof parseTxt>>) =>
  r.chapters.map((c) => `${c.title}\n${c.content}`).join("\n");

// 标题不能用来自证"没乱码"：解不出来时解析器会给默认标题"全文"，它自己就是中文
const allContent = (r: Awaited<ReturnType<typeof parseTxt>>) =>
  r.chapters.map((c) => c.content).join("\n");

describe("parseTxt 编码", () => {
  it("Big5 繁体书自动识别：标题正确、无替换字符", async () => {
    const r = await parseTxt(asFile(BIG5_BYTES, "big5-book.txt"));
    const text = allText(r);
    expect(text).toContain("第一章 城市與筆");
    expect(text).toContain("寫書的人");
    expect(text).not.toContain("\ufffd");
    // 逐字回对样本（BIG5_BYTES 就是 SAMPLE 的 big5 编码），防止 fixture 与断言漂移
    for (const line of SAMPLE.split("\n")) expect(text).toContain(line);
  });

  it("UTF-8 中文照旧解出（回归保护）", async () => {
    const r = await parseTxt(asFile(new TextEncoder().encode(SIMPLIFIED), "u.txt"));
    expect(allText(r)).toContain("写书的人");
  });

  // 纯中文的 UTF-16 文件两个字节里往往一个 0x00 都没有（剑=U+5251→51 52），
  // 旧兜底"每两字节有个 0x00"因此整个失效，文件掉进 GBK 打分解成形近乱码。
  it("UTF-16LE 纯中文无 BOM：解出原文而不是 GBK 形近乱码", async () => {
    const r = await parseTxt(asFile(toUtf16Bytes(SIMPLIFIED, true), "u16le.txt"));
    const text = allText(r);
    for (const line of SIMPLIFIED.split("\n")) expect(text).toContain(line);
    expect(text).not.toContain("\ufffd");
  });

  it("UTF-16BE 纯中文无 BOM：同上，且字节序不能搞反", async () => {
    const r = await parseTxt(asFile(toUtf16Bytes(SIMPLIFIED, false), "u16be.txt"));
    const text = allText(r);
    for (const line of SIMPLIFIED.split("\n")) expect(text).toContain(line);
    expect(text).not.toContain("\ufffd");
  });

  it("GBK 简体中文照旧解出（新的 UTF-16 判定不许把它抢走）", async () => {
    const r = await parseTxt(asFile(GBK_BYTES, "gbk-book.txt"));
    const text = allText(r);
    for (const line of SIMPLIFIED.split("\n")) expect(text).toContain(line);
    expect(text).not.toContain("\ufffd");
  });

  // 英文书的字节成对读进 UTF-16 会解出一堆"看着像中文"的假字（t/h → U+6874），
  // 所以奇偶偏置必须两列差不多时才拒绝判 UTF-16。
  it("纯英文 ASCII 书不被判成 UTF-16", async () => {
    const text =
      "Chapter 1. The letter arrived on a Tuesday, folded twice and sealed with red wax. " +
      "They rode through eleven towns and counted 214 miles on the map, 38 on the ground.";
    const bytes = Uint8Array.from(Array.from(text, (c) => c.charCodeAt(0)));
    const r = await parseTxt(asFile(bytes, "en.txt"));
    const out = allText(r);
    expect(out).toContain("sealed with red wax");
    expect(out).toContain("214 miles");
    expect(allContent(r)).not.toMatch(/[一-鿿]/);
  });

  it("纯英文但真是 UTF-16LE 编码的书照样解出（0x00 兜底那条路径）", async () => {
    const text = "Chapter 2. The inn at Green Ford charged 2 silver for a bed and 5 for the truth.";
    const r = await parseTxt(asFile(toUtf16Bytes(text, true), "en-u16.txt"));
    expect(allText(r)).toContain("Green Ford");
    expect(allContent(r)).not.toMatch(/[一-鿿]/);
  });

  it("options.encoding 生效：显式 big5 解出正确文本，显式错编码则解不出", async () => {
    const forced = await parseTxt(asFile(BIG5_BYTES, "g.txt"), { encoding: "big5" });
    expect(allText(forced)).toContain("第一章 城市與筆");
    // 同一批字节强制按 GBK 解：必然不是同一文本（证明这个入口真的透传到了解码器）
    const wrong = await parseTxt(asFile(BIG5_BYTES, "g.txt"), { encoding: "gbk" });
    expect(allText(wrong)).not.toContain("城市與筆");
  });

  it("浏览器不支持的编码标签给出可行动错误，而不是裸 TypeError", async () => {
    await expect(parseTxt(asFile(BIG5_BYTES, "g.txt"), { encoding: "not-a-real-encoding" }))
      .rejects.toThrow(/不支持编码/);
  });
});
