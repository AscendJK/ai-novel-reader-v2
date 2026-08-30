/**
 * 恢复被错误转码的文件（lexicon-zh.txt / tokens.txt）
 * 损坏过程：原始 UTF-8 字节 → 按 GBK 解码成乱码字符串 → 按 UTF-8 编码保存。
 * 恢复：当前字节 → UTF-8 解码 → 乱码字符串 → GBK 编码 → 原始 UTF-8 字节。
 * （中文 UTF-8 三字节在 GBK 中为双字，往返基本无损；含 ASCII 的序列部分可恢复）
 */
const fs = require("fs");
const path = require("path");

const base = path.join(__dirname, "..", "server", "data", "tts-cache", "model");
const files = [
  { name: "lexicon-zh.txt.bak-乱码", out: "lexicon-zh.txt.recovered" },
  { name: "tokens.txt.bak-687", out: "tokens.txt.recovered" },
];
for (const { name, out } of files) {
  const p = path.join(base, name);
  const buf = fs.readFileSync(p);
  try {
    const utf8Str = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const recovered = Buffer.from(utf8Str, "gbk");
    const outPath = path.join(base, out);
    fs.writeFileSync(outPath, recovered);
    const preview = recovered.toString("utf8").split("\n").slice(0, 8);
    console.log(`=== ${name}: ${buf.length} bytes → 恢复 ${recovered.length} bytes ===`);
    for (const line of preview) console.log("   ", JSON.stringify(line.slice(0, 60)));
  } catch (e) {
    console.log(`=== ${name} 恢复失败: ${e.message} ===`);
  }
}
