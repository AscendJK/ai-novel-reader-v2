// 章节标题模式（已锚定行首）。
// 未锚定的 `第X章` 会把"第三卷里……"这类叙述整行误判为章节标题，导致章节
// 在任意叙事行被切开；但仅锚定行首仍会命中"第三章的内容早就写完了"——
// 用否定前瞻排除标题词后紧跟虚词的行（全角冒号/顿号是常见标题格式
// 「第三章：风云」「第十二章、初入江湖」，必须放行）。真正的章节标题
// 后面是空格、标题文字、括号后缀或行尾（"第十二章"单独成行也是合法标题）。
//
// 排除集的两处修正（R-56）：
// - 补全角/半角逗号：「第三章，他说完就走了」是叙述句，旧字符类漏了 ， 于是整行
//   被当成标题，章节在叙事中间被乱切。
// - 去掉 （）《》：「第十二章（上）」「第八章（大结局）」「第一章《开始》」都是
//   真实标题写法，旧写法把它们误杀成"非章节"。
const CHAPTER_TITLE_RE =
  /^第[零一二三四五六七八九十百千万0-9两]{1,12}[章节回卷篇集](?![的了吗呢吧啊在里中之时后前后与和跟被把让向从对给用以之其此该，,。！？；"''])/;

const CHAPTER_EN_RE = /^chapter\s+\d+/i;

// "1. 标题" / "1、标题"（整行匹配；旧正则同样要求整行，这里补充年份排除）
const NUMBERED_TITLE_RE = /^(\d{1,5})[.、．]\s*(\S.*)$/;

const PLAIN_NUMBER_PATTERN = /^\s*(\d+)[.、．\s]+(.+)$/;

/**
 * 编号行是否像"标题"而不是"叙述句"（R-56）。
 * 章节标题极少先天的句读：带逗号/句号的行（"5. 他来了，然后走了。"、
 * "3 天后，他回来了。"）是正文。纯数字回退还额外限长度——它的分隔符可以是
 * 一个空格，误判面比显式 ".、" 大得多。
 */
const PROSE_PUNCTUATION = /[，。！？；、,]/;
function looksLikeProse(content: string): boolean {
  return PROSE_PUNCTUATION.test(content);
}

function isNumberedTitle(line: string): boolean {
  const m = NUMBERED_TITLE_RE.exec(line);
  if (!m) return false;
  const num = parseInt(m[1], 10);
  if (num > 100000) return false;
  // 常见纪年段（1900-2100）几乎必是年份（"2007. 他出生于……"）而非章节序号；
  // 千章以上超长连载用此段编号的概率远低于正文出现年份的概率
  if (num >= 1900 && num <= 2100) return false;
  const content = m[2];
  if (content.length < 2 || content.length > 50) return false;
  // 防误判：排除常见对话/非章节开头模式
  if (/^[""'']/.test(content) || /^[：:]/.test(content)) return false;
  if (/^[还但而并且因所于或与及]/.test(content)) return false;
  if (looksLikeProse(content)) return false;
  return true;
}

export interface DetectedChapter {
  title: string;
  startIndex: number;
}

export function detectChapters(text: string): DetectedChapter[] {
  const lines = text.split(/\r?\n/);
  const chapters: DetectedChapter[] = [];
  let charOffset = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const lineStart = charOffset;

    if (!line || line.length > 120) {
      charOffset += rawLine.length + 1;
      continue;
    }

    let matched = false;
    if (CHAPTER_TITLE_RE.test(line) || CHAPTER_EN_RE.test(line)) {
      chapters.push({ title: line, startIndex: lineStart });
      matched = true;
    }

    if (!matched && isNumberedTitle(line)) {
      chapters.push({ title: line, startIndex: lineStart });
      matched = true;
    }

    if (!matched) {
      const plainMatch = PLAIN_NUMBER_PATTERN.exec(line);
      if (plainMatch) {
        const num = parseInt(plainMatch[1], 10);
        // 四位数字基本是年份，不是章节序号
        if (num >= 1 && num <= 100000 && !(num >= 1000 && num <= 2100) && plainMatch[2].length >= 2) {
          // 防误判：排除常见对话/非章节开头模式
          const content = plainMatch[2];
          const isDialogue = /^[""'']/.test(content) || /^[：:]/.test(content);
          const isContinuation = /^[还但而并且因所于或与及]/.test(content);
          const isNegative = /^[0-9]+$/.test(content); // 纯数字后缀
          // 分隔符允许是"一个空格"，所以这条回退路径的误判面比显式 ".、" 大得多：
          // "3 天后，他回来了" 之类叙述行必须靠句读与长度上限挡掉（R-56）
          const isProse = looksLikeProse(content) || line.length > 20;
          if (!isDialogue && !isContinuation && !isNegative && !isProse) {
            chapters.push({ title: line, startIndex: lineStart });
          }
        }
      }
    }

    charOffset += rawLine.length + 1;
  }

  return chapters;
}

/** 正文短于这个字数的章节并入上一章。旧实现直接丢弃，短序章/仅标题的楔子/
 *  诗体章节会永久消失且用户无感（round 2 R-10） */
const MIN_STANDALONE_CHAPTER_CHARS = 50;

export function splitByChapters(text: string, detected: DetectedChapter[]): { title: string; content: string }[] {
  if (detected.length === 0) {
    return [{ title: "全文", content: text }];
  }

  const result: { title: string; content: string }[] = [];

  // 开头文本：够长就单独成"前言/简介"，否则挂到第一章正文前面——两种情况都
  // 不能丢字。旧实现里 ≤100 字的开头直接不要了。
  let pendingPrefix = "";
  const preamble = text.slice(0, detected[0].startIndex).trim();
  if (preamble.length > 100) {
    result.push({ title: "前言/简介", content: preamble });
  } else {
    pendingPrefix = preamble;
  }

  // 按"原始区间"记账（不含 trim 掉的首尾空白），所以正常情况下恒为 0
  let coveredChars = detected[0].startIndex;
  for (let i = 0; i < detected.length; i++) {
    const current = detected[i];
    const next = detected[i + 1];
    const raw = text.slice(current.startIndex, next ? next.startIndex : undefined);
    coveredChars += raw.length;
    const content = (pendingPrefix ? `${pendingPrefix}\n\n` : "") + raw.trim();
    pendingPrefix = "";

    if (!content) continue;

    // content 从标题行的位置切起，已自带标题行，并入时不用再补一次标题
    const prev = result[result.length - 1];
    if (prev && content.length < MIN_STANDALONE_CHAPTER_CHARS) {
      prev.content += `\n\n${content}`;
    } else {
      result.push({ title: current.title, content });
    }
  }

  // 覆盖率对账：分割是连续切片，任何缺口都只可能是实现退化造成的静默丢内容
  // （本轮 R-10 就是这么漏掉整章的）。留一行日志，避免下次又要靠人工审查发现。
  const stripped = text.length - coveredChars;
  if (stripped > 0) {
    console.warn(`[parser] 章节分割未覆盖 ${stripped} 字符（不在任何切片区间内），请检查章节识别`);
  }

  return result;
}
