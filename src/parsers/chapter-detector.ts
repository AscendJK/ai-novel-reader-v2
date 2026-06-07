const CHAPTER_PATTERNS = [
  /第[零一二三四五六七八九十百千万0-9]+[章节回卷篇集]/,
  /Chapter\s+\d+/i,
  /CHAPTER\s+\d+/,
  /^\s*\d+[\.、．]\s*[^\n]{1,50}$/m,     // "1. xxx" or "1、xxx"
  /^\s*第[零一二三四五六七八九十百千万0-9]+[章节]?\s+[^\n]{1,50}$/m,
];

const PLAIN_NUMBER_PATTERN = /^\s*(\d+)[\.、．\s]+(.+)$/;

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
    for (const pattern of CHAPTER_PATTERNS) {
      if (pattern.test(line)) {
        chapters.push({ title: line, startIndex: lineStart });
        matched = true;
        break;
      }
    }

    if (!matched) {
      const plainMatch = PLAIN_NUMBER_PATTERN.exec(line);
      if (plainMatch) {
        const num = parseInt(plainMatch[1], 10);
        if (num >= 1 && num <= 100000 && plainMatch[2].length >= 2) {
          chapters.push({ title: line, startIndex: lineStart });
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
