/**
 * TTS 输入清洗（从 server/routes/rag.js 抽出，只为让它能被用例看着）
 *
 * 这段规则是"朗读乱读"的唯一防线：Kokoro 词表外字符不会被跳过，espeak-ng 会把它们
 * 硬拼成一串怪音——症状是音色和语速都正常、内容却是胡话，界面上完全看不出输入有问题。
 * 与 server/tts-worker.py 的白名单保持一致。
 */

// 保留字符白名单（实测校准，Kokoro fp32 v1.0 + espeak-ng）：只放行能正确朗读的字符，
// 其余替换为空格。典型乱读字符：U+FFFD、CJK 兼容汉字（F900 区）、CJK 扩展 A（3400 区）、
// 全角字母、假名、々〇〆〰・、带圈字符、罗马数字、emoji、©®¤¨¬± 等 Latin-1 符号、
// 数学/箭头符号。
export const TTS_KEEP_RE =
  /^[\u0020-\u007E\u00A2\u00A3\u00A5-\u00A7\u00AA\u00B0\u00B5-\u00B7\u00BA\u00C0-\u00FF\u2013\u2014\u2018-\u201D\u2022\u2026\u2027\u203B\u3001\u3002\u3008-\u3011\u3014\u3015\u301C\u303F\uFF01-\uFF19\uFF1A-\uFF1F\uFF3B-\uFF40\uFF5B-\uFF5E\u4E00-\u9FFF]$/u;

/**
 * 清洗 TTS 输入文本（服务端兜底，防御直接调 API 的客户端）：
 * 1. 孤立代理项（未配对的 \uD800-\uDFFF，损坏的小说源数据；Python pybind11 无法编码会报参数错误）
 * 2. 词表外字符（U+FFFD、CJK 兼容/扩展、假名、emoji 等）→ 空格（否则 espeak-ng 硬拼怪音乱读）
 * 3. 全角字母 Ａ-Ｚ ａ-ｚ → 映射回 ASCII（实测全角字母逐字乱读，映射后正常）
 */
export function cleanTtsText(rawText) {
  const text = rawText
    // 删除孤立代理项（合法代理对如 emoji 保留，稍后按白名单处理）
    .replace(/[\uD800-\uDFFF]/g, (m, offset, str) => {
      const code = m.charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = str.charCodeAt(offset + 1);
        return next >= 0xdc00 && next <= 0xdfff ? m : "";
      }
      const prev = str.charCodeAt(offset - 1);
      return prev >= 0xd800 && prev <= 0xdbff ? m : "";
    })
    // 全角字母 → ASCII（乱读修复）
    .replace(/[\uFF21-\uFF3A\uFF41-\uFF5A]/g, (m) => String.fromCharCode(m.charCodeAt(0) - 0xfee0));
  let out = "";
  for (const ch of text) {
    if (ch === "\u3000") {
      out += " "; // 全角空格 → 半角
    } else if (TTS_KEEP_RE.test(ch)) {
      out += ch;
    } else {
      out += " "; // 词表外 → 空格（防乱读）
    }
  }
  return out;
}
