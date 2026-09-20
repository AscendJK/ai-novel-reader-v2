import type { ParseResult, ParserOptions } from "./types";
import { detectChapters, splitByChapters } from "./chapter-detector";

function isCjkHighByte(b: number): boolean {
  // 中文字符在 UTF-16 里的高位字节只会是这几处：0x30 中文标点、0x4E–0x9F CJK、0xFF 全角
  return b === 0x30 || b === 0xff || (b >= 0x4e && b <= 0x9f);
}

/** 非空白字符里中文（含中文标点/全角）的占比 */
function cjkShare(s: string): number {
  let total = 0;
  let cjk = 0;
  for (const ch of s) {
    if (total >= 2000) break;
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    total++;
    if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3000 && c <= 0x303f) ||
      (c >= 0xff00 && c <= 0xffef)
    ) {
      cjk++;
    }
  }
  return total ? cjk / total : 0;
}

/**
 * 无 BOM 的纯中文 UTF-16 用 0x00 分布判不出来：“剑”=U+5251 → 字节 51 52，一个 0 都没有。
 * 换判据：CJK 高位字节必定密集出现在**其中一列**（LE 在奇列、BE 在偶列），另一列是低字节，
 * 分布均匀。实测中文 UTF-16 = 93%/29%，而英文为主的 GBK/Big5 两列都是 ~72%（'N'–'z' 撞进
 * 同一区间）——所以只看单列达标会误伤英文书，必须同时要求两列拉开 2 倍差距。
 */
function detectUtf16ByParity(bytes: Uint8Array): string | null {
  const len = Math.min(bytes.length, 4096);
  if (len < 64) return null;
  let evenHit = 0;
  let oddHit = 0;
  let evenN = 0;
  let oddN = 0;
  for (let i = 0; i < len; i += 2) {
    evenN++;
    if (isCjkHighByte(bytes[i])) evenHit++;
  }
  for (let i = 1; i < len; i += 2) {
    oddN++;
    if (isCjkHighByte(bytes[i])) oddHit++;
  }
  const even = evenHit / Math.max(1, evenN);
  const odd = oddHit / Math.max(1, oddN);
  const high = Math.max(even, odd);
  if (high < 0.55 || Math.min(even, odd) > high * 0.5) return null;
  const label = odd > even ? "UTF-16LE" : "UTF-16BE";
  // 奇偶偏置只是必要条件：再确认按它解出来确实是一片中文
  const decoded = decodeWith(bytes.subarray(0, len), label);
  if (decoded === null || cjkShare(decoded) < 0.5) return null;
  return label;
}

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

  const byParity = detectUtf16ByParity(bytes);
  if (byParity) return byParity;

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

/** 用指定编码解码；浏览器不支持该标签时返回 null（不抛异常，交给调用方换候选） */
function decodeWith(bytes: Uint8Array, label: string, fatal = false): string | null {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 给解码结果打分：正确编码下中文落在 CJK 统一表意区与中文标点区；
 * 错码（GBK↔Big5 混用、UTF-8 当 Latin 读）会产出私用区、谚文、代理残片与替换字符。
 */
function scoreDecoded(s: string): number {
  let ok = 0;
  let bad = 0;
  let seen = 0;
  for (const ch of s) {
    if (seen++ > 4000) break;
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0xfffd) bad += 3;                                     // 替换字符
    else if (c >= 0xe000 && c <= 0xf8ff) bad += 2;                  // 私用区
    else if (c >= 0xac00 && c <= 0xd7ff) bad += 1;                  // 谚文：中文书里几乎不出现
    else if (c >= 0xd800 && c <= 0xdfff) bad += 3;                  // 孤立代理
    else if (c >= 0x4e00 && c <= 0x9fff) ok += 2;                   // CJK 统一表意
    else if (c >= 0x3000 && c <= 0x303f) ok += 2;                   // 中文标点
    else if (c >= 0xff00 && c <= 0xffef) ok += 1;                   // 全角
    else if (c === 0x0a || c === 0x20) ok += 1;
    else if (c >= 0x20 && c < 0x7f) ok += 0.5;                      // ASCII
    else ok += 0.1;
  }
  return ok - bad;
}

/**
 * 选编码。只在样本上比候选，选定后整份只解码一次（100MB 文件经不起三份副本）。
 *
 * 判据顺序有讲究：UTF-8 有严格的结构校验（follow byte 规则），能通过就一定是它；
 * 而 GBK/Big5 互为错码时都会解出"看起来像中文"的 mojibake，靠打分分不开
 * （实测 UTF-8 的中文按 GBK 解出的 浠撳 一类字照样落在 CJK 区，分数反而更高）。
 * 所以结构校验优先，只有它失败时才在 GBK/Big5 之间比可读性。
 */
function pickEncoding(bytes: Uint8Array): string {
  const sample = bytes.subarray(0, Math.min(bytes.length, 256 * 1024));
  const heuristic = detectEncoding(bytes);
  if (heuristic.startsWith("UTF-16")) return heuristic;          // 0x00 分布判出来的，别再猜
  if (decodeWith(sample, "UTF-8", true) !== null) return "UTF-8";

  let best = heuristic === "UTF-8" ? "GBK" : heuristic;
  let bestScore = -Infinity;
  for (const label of ["GBK", "Big5"]) {
    const decoded = decodeWith(sample, label);
    if (decoded === null) continue;
    const score = scoreDecoded(decoded);
    if (score > bestScore) { bestScore = score; best = label; }
  }
  return best;
}

export async function parseTxt(file: File, options?: ParserOptions): Promise<ParseResult> {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const requested = options?.encoding?.trim();

  let text: string | null;
  if (requested) {
    // 手动指定优先：这是繁体书被自动判成 GBK（整本乱码）时用户唯一的纠错入口
    text = decodeWith(bytes, requested);
    if (text === null) throw new Error(`浏览器不支持编码 ${requested}，请改用 UTF-8 / GBK / Big5`);
  } else {
    text = decodeWith(bytes, pickEncoding(bytes));
  }
  if (text === null) text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

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
