import type { ParseResult, ParserOptions } from "./types";
import { detectChapters, splitByChapters } from "./chapter-detector";

function detectEncoding(bytes: Uint8Array): string {
  // BOM detection
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "UTF-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "UTF-16LE";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "UTF-16BE";

  // UTF-16 无 BOM 兜底：UTF-16 编码的文本（含 ASCII 段落）每两个字节就有一个
  // 0x00 高位字节，而 UTF-8/GBK 正常中文文本几乎不含 0x00。在 BOM 检测之后、
  // UTF-8/GBK 打分之前判断，避免无 BOM 的 UTF-16 文件被误判成 UTF-8（全文乱码）
  let zeros = 0;
  let zerosEven = 0;
  const zLen = Math.min(bytes.length, 1024);
  for (let i = 0; i < zLen; i++) {
    if (bytes[i] === 0) {
      zeros++;
      if (i % 2 === 0) zerosEven++;
    }
  }
  if (zeros > zLen * 0.1) {
    // 0x00 集中在偶数位 → 高位字节在前 → BE；否则 LE
    return zerosEven > zeros / 2 ? "UTF-16BE" : "UTF-16LE";
  }

  // 启发式打分：采样窗口不能太小——GBK 文件常以长英文版权页/序言开头，
  // 前 500 字节几乎全 ASCII（utf8/gbk 同分），会被误判成 UTF-8，正文全乱码
  let utf8Score = 0;
  let gbkScore = 0;
  const len = Math.min(bytes.length, 65536);

  for (let i = 0; i < len; i++) {
    const b = bytes[i];
    // ASCII range
    if (b < 0x80) {
      utf8Score++;
      gbkScore++;
    }
    // Multi-byte UTF-8 sequences
    else if (b >= 0xc0 && b < 0xfe) {
      const seqLen = b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
      let valid = true;
      for (let j = 1; j < seqLen && i + j < len; j++) {
        if ((bytes[i + j] & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
      }
      if (valid) {
        utf8Score += seqLen;
        i += seqLen - 1;
      } else {
        gbkScore++;
      }
    }
    // GBK high bytes (0x81-0xFE): lead byte must be 0x81-0xFE, trail byte 0x40-0xFE
    else if (b >= 0x81 && b <= 0xFE) {
      if (i + 1 < len) {
        const trail = bytes[i + 1];
        if (trail >= 0x40 && trail <= 0xFE) { gbkScore++; i++; }
      }
    }
  }

  // 只有 ASCII 字符时默认为 UTF-8
  if (utf8Score === 0 && gbkScore === 0) return "UTF-8";
  // 当命中 GBK 模式的比例显著时，更倾向于 GBK（避免纯 ASCII 段落误判）
  // GBK 双字节序列通常比 UTF-8 多字节序列更可靠（因为 UTF-8 有严格的 follow byte 校验）
  const gbkRatio = gbkScore / Math.max(1, utf8Score + gbkScore);
  return gbkRatio > 0.15 ? "GBK" : "UTF-8";
}

export async function parseTxt(file: File, options?: ParserOptions): Promise<ParseResult> {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const encoding = options?.encoding || detectEncoding(bytes);

  const decoder = new TextDecoder(encoding);
  const text = decoder.decode(bytes);

  // Normalize line endings
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const detected = detectChapters(normalized);
  const chapters = splitByChapters(normalized, detected);

  // Extract potential title from filename or first meaningful line
  let title = file.name.replace(/\.[^.]+$/, "");
  let author: string | undefined;

  // Try to find title/author from first few lines
  const firstLines = normalized.slice(0, 500).split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of firstLines) {
    if (line.startsWith("书名") || line.startsWith("标题") || line.startsWith("《")) {
      title = line.replace(/^(书名|标题)[：:]\s*/, "").replace(/^《/, "").replace(/》$/, "");
    }
    if (line.startsWith("作者")) {
      author = line.replace(/^作者[：:]\s*/, "");
    }
  }

  return {
    title,
    author,
    chapters,
    totalChars: normalized.length,
  };
}
