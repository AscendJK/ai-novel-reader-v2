import JSZip from "jszip";
import type { ParseResult } from "./types";
import { detectChapters, splitByChapters } from "./chapter-detector";

export async function parseEpub(file: File): Promise<ParseResult> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

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

  // Map IDs to hrefs and media types
  const manifestItems = new Map<string, { href: string; mediaType: string }>();
  const itemMatches = opfXml.matchAll(/<item[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*media-type="([^"]+)"[^>]*>/g);
  for (const m of itemMatches) {
    manifestItems.set(m[1], { href: m[2], mediaType: m[3] });
  }

  // Extract text from all spine items
  let fullText = "";
  const chapterTexts: string[] = [];

  for (const idref of idrefs) {
    const item = manifestItems.get(idref);
    if (!item) continue;
    // Only process text-based content (skip images, fonts, etc.)
    const mt = item.mediaType;
    if (!mt.includes("html") && !mt.includes("xml") && !mt.includes("xhtml") && !mt.includes("text")) continue;

    const fullPath = opfDir + item.href;
    const contentFile = zip.file(fullPath);
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
