import type { Novel } from "./types";

export { type Novel, type Chapter, type ParseResult, type ParserOptions } from "./types";

function uuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    try { return crypto.randomUUID(); } catch { /* fall through */ }
  }
  // Fallback for environments without crypto.randomUUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function createNovel(parseResult: import("./types").ParseResult, fileName: string, fileFormat: "txt" | "epub"): Novel {
  const novelId = uuid();
  return {
    id: novelId,
    title: fileName.replace(/\.[^.]+$/, "").replace(/^《/, "").replace(/》$/, ""),
    author: parseResult.author,
    fileName,
    fileFormat,
    totalChars: parseResult.totalChars,
    chapters: parseResult.chapters.map((ch, i) => ({
      id: uuid(),
      novelId,
      index: i,
      title: ch.title || `第${i + 1}章`,
      content: ch.content,
      startOffset: 0,
      endOffset: ch.content.length,
    })),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export { uuid };
