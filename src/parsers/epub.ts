import JSZip from "jszip";
import type { ParseResult } from "./types";
import { detectChapters, splitByChapters } from "./chapter-detector";

/**
 * zip bomb 上限：EPUB 就是 zip，几 MB 的压缩包可以声明几百 GB 的解压体积，
 * 浏览器会在解压途中被杀（iOS 尤其直接崩页面）。按中央目录里声明的
 * uncompressedSize 先拦一道；同时限制条目数（每个条目都会走一次路径解析）。
 */
const MAX_EPUB_DECOMPRESSED = 300 * 1024 * 1024;
const MAX_EPUB_ENTRIES = 5000;

export async function parseEpub(file: File): Promise<ParseResult> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const entries = Object.values(zip.files);
  if (entries.length > MAX_EPUB_ENTRIES) {
    throw new Error(`EPUB 条目过多（${entries.length} > ${MAX_EPUB_ENTRIES}），已拒绝解析`);
  }
  let declaredBytes = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    declaredBytes += (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  }
  if (declaredBytes > MAX_EPUB_DECOMPRESSED) {
    throw new Error(
      `EPUB 解压后体积过大（${(declaredBytes / 1048576).toFixed(0)}MB > ${(MAX_EPUB_DECOMPRESSED / 1048576).toFixed(0)}MB），已拒绝解析`
    );
  }

  // Find container.xml to locate the OPF file
  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) {
    throw new Error("无效的 EPUB 文件：找不到 container.xml");
  }

  const containerXml = await containerFile.async("string");
  const opfMatch = /full-path="([^"]+)"/.exec(containerXml);
  if (!opfMatch) {
    throw new Error("无效的 EPUB 文件：找不到 OPF 文件路径");
  }
  const opfPath = opfMatch[1];

  const opfDir = opfPath.includes("/") ? opfPath.replace(/\/[^/]+$/, "") + "/" : "";

  // Parse OPF for metadata and spine
  const opfFile = zip.file(opfPath);
  if (!opfFile) {
    throw new Error("无效的 EPUB 文件：找不到 OPF 文件");
  }

  const opfXml = await opfFile.async("string");

  // Extract title (supports dc:, dcterms:, dc11: prefixes and default namespace)
  let title = file.name.replace(/\.[^.]+$/, "");
  const titleMatch = /<(?:dc:|dcterms:|dc11:)?title[^>]*>([^<]+)<\/(?:dc:|dcterms:|dc11:)?title>/.exec(opfXml);
  if (titleMatch) title = titleMatch[1].trim();

  // Extract author (supports dc:, dcterms:, dc11: prefixes and default namespace)
  let author: string | undefined;
  const authorMatch = /<(?:dc:|dcterms:|dc11:)?creator[^>]*>([^<]+)<\/(?:dc:|dcterms:|dc11:)?creator>/.exec(opfXml);
  if (authorMatch) author = authorMatch[1].trim();

  // Extract spine itemrefs in order
  const spineMatch = /<spine[^>]*>([\s\S]*?)<\/spine>/.exec(opfXml);
  const idrefs: string[] = [];
  if (spineMatch) {
    const refMatches = spineMatch[1].matchAll(/idref="([^"]+)"/g);
    for (const m of refMatches) {
      idrefs.push(m[1]);
    }
  }

  // Map IDs to hrefs and media types.
  // 逐 <item> 标签解析并逐属性提取：OCF 规范不约束属性书写顺序，
  // 要求 id→href→media-type 顺序的正则会漏掉 href 写在 id 前面的合法
  // EPUB，spine 项被静默丢弃（章节缺失且无报错）
  const manifestItems = new Map<string, { href: string; mediaType: string }>();
  for (const itemTag of opfXml.matchAll(/<item\s[^>]*>/g)) {
    const tag = itemTag[0];
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    const mediaType = /\bmedia-type="([^"]+)"/.exec(tag)?.[1];
    if (id && href && mediaType) {
      manifestItems.set(id, { href, mediaType });
    }
  }

  // OCF 规范要求 href 百分号编码（文件名含空格/中文时必然出现），而 JSZip
  // 内部是解码后的路径；不解码会 zip.file 查不到 → 章节静默丢失
  const safeDecode = (s: string) => {
    try { return decodeURIComponent(s); } catch { return s; }
  };

  // Extract text from all spine items
  let fullText = "";
  const chapterTexts: string[] = [];

  for (const idref of idrefs) {
    const item = manifestItems.get(idref);
    if (!item) continue;
    // Only process text-based content (skip images, fonts, etc.)
    const mt = item.mediaType;
    if (!mt.includes("html") && !mt.includes("xml") && !mt.includes("xhtml") && !mt.includes("text")) continue;

    const decodedHref = safeDecode(item.href).replace(/^\.\//, "");
    const fullPath = opfDir + decodedHref;
    const contentFile = zip.file(fullPath) || zip.file(decodedHref);
    if (!contentFile) continue;

    const htmlContent = await contentFile.async("string");

    // Strip HTML tags
    const text = htmlContent
      .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&mdash;/g, "—")
      .replace(/&ndash;/g, "–")
      .replace(/&hellip;/g, "…")
      .replace(/&lsquo;/g, "'")
      .replace(/&rsquo;/g, "'")
      .replace(/&ldquo;/g, '"')
      .replace(/&rdquo;/g, '"')
      .replace(/&#?\w+;/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (text.length > 50) {
      chapterTexts.push(text);
      fullText += text + "\n\n";
    }
  }

  // Normalize line endings before chapter detection
  fullText = fullText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const detected = detectChapters(fullText);
  const chapters = splitByChapters(fullText, detected);

  // If no chapters detected, use the spine items as chapters
  if (chapters.length <= 1 && chapterTexts.length > 1) {
    return {
      title,
      author,
      chapters: chapterTexts.map((content, i) => ({
        title: `第${i + 1}部分`,
        content,
      })),
      totalChars: fullText.length,
    };
  }

  return {
    title,
    author,
    chapters,
    totalChars: fullText.length,
  };
}
