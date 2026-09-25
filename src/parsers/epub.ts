import JSZip from "jszip";
import type { ParseResult } from "./types";
import { detectChapters, splitByChapters } from "./chapter-detector";

/**
 * zip bomb 上限。两条闸，各挡各的：
 *  - 条目数：每个条目都会走一次路径解析。
 *  - **正文体积**：只累计 spine 里真被 `async("string")` 解出来的那些文本条目。
 *
 * 原来这道闸量的是「整只包里**所有条目自报**的 uncompressedSize 之和」，两个毛病：
 *  ① 图片/字体**从头到尾没解压过**也被计入，于是 320MB 的图解 EPUB 被整本拒掉，
 *    而正文其实只有一百 KB（判据：`epub.test.ts` "不在 spine 里的大图不许把书一起杀掉"）；
 *  ② 自报值本身不用防——JSZip 在 inflate 完会拿实际长度对账，谎报 `uncompressedSize`
 *    的包当场抛 `uncompressed data size mismatch`，走不到撑爆内存那一步
 *    （判据：同文件"谎报 header 的包由 JSZip 当场抛"；哪天 JSZip 不校验了那条会红）。
 *
 * 上限取 120MB：口径是**解出来的字符数**（UTF-16，真实驻留约两倍，所以这个数自带余量）。
 * 一本超长网文正文约 30MB 字符，spine HTML 连标签算 2~3 倍 ≈ 90MB，120MB 留出冗余。
 * 语料不在手上，所以这是**推算值不是实测分布**；要收紧得先量。
 */
const MAX_EPUB_DECOMPRESSED = 120 * 1024 * 1024;
const MAX_EPUB_ENTRIES = 5000;

export interface EpubParseOptions {
  /** 只为判据开的注入口：单测里造不出 120MB 正文，用小上限走同一条代码路径 */
  maxDecompressedBytes?: number;
}

export async function parseEpub(file: File, opts?: EpubParseOptions): Promise<ParseResult> {
  const maxBytes = opts?.maxDecompressedBytes ?? MAX_EPUB_DECOMPRESSED;
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const entries = Object.values(zip.files);
  if (entries.length > MAX_EPUB_ENTRIES) {
    throw new Error(`EPUB 条目过多（${entries.length} > ${MAX_EPUB_ENTRIES}），已拒绝解析`);
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
  // 累计**真解进来**的正文长度——上面那道体积闸从这里量，不再看 zip 头里自报的值
  let decompressedChars = 0;

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
    // 闸落在**解出来之后**：这一发 `async("string")` 本身就是内存峰值，量 zip 头既挡不住
    // 也拦错了东西（图片根本不走这条路）。累计超线立刻抛，后面的章节不再解。
    decompressedChars += htmlContent.length;
    if (decompressedChars > maxBytes) {
      throw new Error(
        `EPUB 解压后体积过大（正文累计 ${(decompressedChars / 1048576).toFixed(1)}MB > ` +
        `${(maxBytes / 1048576).toFixed(0)}MB），已拒绝解析`
      );
    }

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
