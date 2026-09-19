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

function asFile(bytes: Uint8Array<ArrayBuffer>, name: string): File {
  return new File([bytes], name, { type: "text/plain" });
}

const allText = (r: Awaited<ReturnType<typeof parseTxt>>) =>
  r.chapters.map((c) => `${c.title}\n${c.content}`).join("\n");

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
