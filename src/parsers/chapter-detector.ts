// 章节标题模式（已锚定行首）。
// 未锚定的 `第X章` 会把"第三卷里……"这类叙述整行误判为章节标题，导致章节
// 在任意叙事行被切开；但仅锚定行首仍会命中"第三章的内容早就写完了"——
// 用否定前瞻排除标题词后紧跟虚词的行（全角冒号/顿号是常见标题格式
// 「第三章：风云」「第十二章、初入江湖」，必须放行）。真正的章节标题
// 后面是空格、标题文字或行尾（"第十二章"单独成行也是合法标题）。
const CHAPTER_TITLE_RE =
  /^第[零一二三四五六七八九十百千万0-9两]{1,12}[章节回卷篇集](?![的了吗呢吧啊在里中之时后前后与和跟被把让向从对给用以之其此该。！？；""''（）《》])/;

const CHAPTER_EN_RE = /^chapter\s+\d+/i;

// "1. 标题" / "1、标题"（整行匹配；旧正则同样要求整行，这里补充年份排除）
const NUMBERED_TITLE_RE = /^(\d{1,5})[.、．]\s*(\S.*)$/;

const PLAIN_NUMBER_PATTERN = /^\s*(\d+)[.、．\s]+(.+)$/;

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
          if (!isDialogue && !isContinuation && !isNegative) {
            chapters.push({ title: line, startIndex: lineStart });
          }
        }
      }
    }

    charOffset += rawLine.length + 1;
  }

  return chapters;
}

export function splitByChapters(text: string, detected: DetectedChapter[]): { title: string; content: string }[] {
  if (detected.length === 0) {
    return [{ title: "全文", content: text }];
  }

  const result: { title: string; content: string }[] = [];

  for (let i = 0; i < detected.length; i++) {
    const current = detected[i];
    const next = detected[i + 1];
    const content = text.slice(current.startIndex, next ? next.startIndex : undefined).trim();
    if (content.length > 50) {
      result.push({ title: current.title, content });
    }
  }

  // Include text before the first chapter if significant
  if (detected.length > 0 && detected[0].startIndex > 100) {
    const preamble = text.slice(0, detected[0].startIndex).trim();
    if (preamble.length > 100) {
      result.unshift({ title: "前言/简介", content: preamble });
    }
  }

  return result;
}
