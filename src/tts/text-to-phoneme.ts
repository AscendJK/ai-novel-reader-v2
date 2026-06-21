/**
 * 中文文本转音素（Bopomofo 注音）
 * 用于 Kokoro v1.1-zh TTS 模型输入预处理
 *
 * 转换流程：中文文本 → pinyin-pro 拼音 → Bopomofo + 特殊 token
 * 映射规则与 misaki v1.1 一致（韵母使用模型词汇表中的特殊 token）
 */

import { pinyin } from "pinyin-pro";

// ── 声母映射 ──────────────────────────────────────────────
const INITIAL_MAP: Record<string, string> = {
  b: "ㄅ", p: "ㄆ", m: "ㄇ", f: "ㄈ",
  d: "ㄉ", t: "ㄊ", n: "ㄋ", l: "ㄌ",
  g: "ㄍ", k: "ㄎ", h: "ㄏ",
  j: "ㄐ", q: "ㄑ", x: "ㄒ",
  zh: "ㄓ", ch: "ㄔ", sh: "ㄕ", r: "ㄖ",
  z: "ㄗ", c: "ㄘ", s: "ㄙ",
  ng: "ㄋ", // "嗯" 的 ng 声母，映射到 ㄋ（近似）
};

// ── 韵母映射（含 Kokoro v1.1 特殊 token）──────────────────
// 部分韵母使用模型词汇表中的中文字符 token（如 压、言、阳 等），
// 这些是 misaki v1.1 定义的映射，模型训练时使用的就是这些 token。
const FINAL_MAP: Record<string, string> = {
  // 基本韵母
  a: "ㄚ", o: "ㄛ", e: "ㄜ", i: "ㄧ", u: "ㄨ",
  ai: "ㄞ", ei: "ㄟ", ao: "ㄠ", ou: "ㄡ",
  an: "ㄢ", en: "ㄣ", ang: "ㄤ", eng: "ㄥ", er: "ㄦ",
  // 特殊元音（z/c/s 后和 zh/ch/sh/r 后的 i）
  ii: "ㄭ",   // z/c/s 后的 i
  iii: "十",  // zh/ch/sh/r 后的 i
  // 含 i 介音
  ia: "压", ie: "ㄝ", iao: "要", iou: "又",
  ian: "言", in: "阴", iang: "阳", ing: "应", iong: "用",
  // 含 u 介音
  ua: "穵", uo: "我", uai: "外", uei: "为",
  uan: "万", uen: "文", uang: "王", ueng: "瓮",
  ong: "中",
  // 含 ü 韵母
  v: "ㄩ", ve: "月", van: "元", vn: "云",
};

// ── 拼音解析 ──────────────────────────────────────────────

interface PinyinParsed {
  base: string;  // 不含声调的拼音（已规范化 ü→v）
  tone: string;  // 声调数字 1-5
}

/**
 * 解析带数字声调的拼音字符串
 * 输入: "ni3", "zhong1", "lü4", "hao3"
 */
function parsePinyin(py: string): PinyinParsed | null {
  const m = py.match(/^([a-züv:]+)([0-5])$/i);
  if (!m) return null;
  return {
    base: m[1].toLowerCase().replace(/u:/g, "v").replace(/ü/g, "v"),
    tone: m[2] === "0" ? "5" : m[2],
  };
}

/**
 * 从拼音 base 中分离声母和韵母
 */
function splitInitialFinal(base: string): { initial: string; final: string } {
  // zh, ch, sh, ng 优先匹配（ng 是特殊声母，如"嗯"）
  for (const init of ["zh", "ch", "sh", "ng"]) {
    if (base.startsWith(init)) {
      return { initial: init, final: base.slice(init.length) };
    }
  }
  // 单字母声母
  const first = base[0];
  if (INITIAL_MAP[first]) {
    return { initial: first, final: base.slice(1) };
  }
  // 零声母：y/w 开头的处理
  // 注意：yu 必须在 y 之前匹配（yuan→van, yue→ve, yun→vn）
  if (base.startsWith("yi")) return { initial: "", final: base.replace(/^yi/, "i") };
  if (base.startsWith("yu")) return { initial: "", final: base.replace(/^yu/, "v") };
  if (base.startsWith("y"))  return { initial: "", final: `i${base.slice(1)}` };
  if (base.startsWith("wu")) return { initial: "", final: base.replace(/^wu/, "u") };
  if (base.startsWith("w"))  return { initial: "", final: `u${base.slice(1)}` };
  return { initial: "", final: base };
}

// ── 韵母规范化 ─────────────────────────────────────────────

/** 韵母缩写 → 完整形式（与 misaki 一致） */
function normalizeFinal(f: string): string {
  if (f === "iu") return "iou";
  if (f === "ui") return "uei";
  if (f === "un") return "uen";
  return f;
}

// ── 单音节转换 ─────────────────────────────────────────────

/**
 * 将单个拼音音节转换为 Bopomofo + 声调数字
 * 输入: "ni3" → 输出: "ㄋㄧ3"
 * 输入: "shi4" → 输出: "ㄕ十4"
 * 输入: "zi4" → 输出: "ㄗㄭ4"
 */
function pinyinSyllableToBopomofo(py: string): string {
  const parsed = parsePinyin(py);
  if (!parsed) return py;

  let { initial, final } = splitInitialFinal(parsed.base);

  // j/q/x 后的 ü 写作 u，需要还原为 v
  if (["j", "q", "x"].includes(initial) && final.startsWith("u")) {
    final = `v${final.slice(1)}`;
  }

  // 韵母规范化
  final = normalizeFinal(final);

  // 特殊元音：z/c/s 后的 i → ii，zh/ch/sh/r 后的 i → iii
  if (["z", "c", "s"].includes(initial) && final === "i") {
    final = "ii";
  } else if (["zh", "ch", "sh", "r"].includes(initial) && final === "i") {
    final = "iii";
  }

  const initialBopomofo = INITIAL_MAP[initial] ?? "";
  const finalBopomofo = FINAL_MAP[final];

  // 纯声母（如"嗯" ng4，无韵母）
  if (!final) {
    return `${initialBopomofo}${parsed.tone}`;
  }

  if (!finalBopomofo) {
    console.warn("[TTS] 未知韵母:", final, "原始拼音:", py);
    return py;
  }

  return `${initialBopomofo}${finalBopomofo}${parsed.tone}`;
}

// ── 声调变调（第三声连续变调）──────────────────────────────

// pinyin-pro 已处理："一"/"不" 变调、助词轻声
// 此处只处理 pinyin-pro 未处理的：连续三声变调

/** 检测 Bopomofo 音节是否为三声 */
function isThirdTone(syl: string): boolean {
  return syl.endsWith("3");
}

/**
 * 对一组音节应用连续三声变调规则
 * 两个连续三声 → 前一个变二声
 * 三个连续三声 → 根据分词情况变调（简化处理：前两个变二声）
 */
function applyThirdToneSandhi(syllables: string[]): string[] {
  const result = [...syllables];
  for (let i = 0; i < result.length - 1; i++) {
    if (isThirdTone(result[i]) && isThirdTone(result[i + 1])) {
      result[i] = result[i].slice(0, -1) + "2";
    }
  }
  return result;
}

// ── 主入口 ─────────────────────────────────────────────────

/**
 * 将中文文本转换为 Bopomofo 音素序列
 * 中英文之间自动插入空格，避免 tokenizer 断词错误
 *
 * @example
 * textToPhoneme("你好") → "ㄋㄧ2ㄏㄠ3"  （三声变调）
 * textToPhoneme("吃饭") → "ㄔ十1ㄈㄢ4"
 * textToPhoneme("Hello你好") → "Hello ㄋㄧ2ㄏㄠ3"
 */
export function textToPhoneme(text: string): string {
  if (!text) return "";

  // 获取每个字的拼音（带数字声调）
  // pinyin-pro 会自动处理 "一"/"不" 变调和助词轻声
  const pinyinArr = pinyin(text, { type: "array", toneType: "num" });

  // 转换为 Bopomofo，同时记录每段是中文还是非中文
  const segments: Array<{ text: string; isZh: boolean }> = [];

  for (let i = 0; i < pinyinArr.length; i++) {
    const py = pinyinArr[i];
    const origChar = text[i];

    // 判断是否为中文拼音（pinyin-pro 对非中文字符返回原字符）
    const isZh = py !== origChar && !!py;

    const converted = isZh ? pinyinSyllableToBopomofo(py) : (origChar || "");

    // 连续同类字符合并到同一段
    if (segments.length > 0 && segments[segments.length - 1].isZh === isZh) {
      segments[segments.length - 1].text += converted;
    } else {
      segments.push({ text: converted, isZh });
    }
  }

  // 中文段应用三声变调
  const result = segments.map((seg) => {
    if (!seg.isZh) return seg.text;
    // 按音节分割（每个音节 = 非数字字符 + 一个声调数字）
    const syllables = seg.text.match(/[^0-9]+[0-9]/g) || [seg.text];
    const adjusted = applyThirdToneSandhi(syllables);
    return adjusted.join("");
  });

  // 中英文段之间加空格
  return result
    .filter((s) => s.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
