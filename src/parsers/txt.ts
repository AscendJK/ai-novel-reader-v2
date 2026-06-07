import type { ParseResult, ParserOptions } from "./types";
import { detectChapters, splitByChapters } from "./chapter-detector";

function detectEncoding(bytes: Uint8Array): string {
  // BOM detection
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "UTF-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "UTF-16LE";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "UTF-16BE";

  // Simple heuristic: check if first 100 bytes look like UTF-8
  let utf8Score = 0;
  let gbkScore = 0;
  const len = Math.min(bytes.length, 500);

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

  return utf8Score >= gbkScore ? "UTF-8" : "GBK";
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
