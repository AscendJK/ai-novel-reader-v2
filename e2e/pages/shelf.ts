import { expect, type Page } from "@playwright/test";
import JSZip from "jszip";

/** 阅读与书架这条路上的定位符与"喂文件"的工具。 */

export const CHAPTER_TITLES = ["第一章 风起", "第二章 云涌", "第三章 归途"];

/**
 * 三章正文，每章首句互不相同——串号（章节错位/内容混掉）一眼就能看出来。
 *
 * 每章正文必须长于 `MIN_STANDALONE_CHAPTER_CHARS`（chapter-detector.ts:110，50 字），
 * 否则短章会被并进上一章，样本看着"只有一章"。这条是实测撞出来的：短样本时
 * 卡片显示 1 章，判据全组红，而产品行为是对的。
 */
export function miniNovel(): string {
  return [
    `${CHAPTER_TITLES[0]}\n洛阳城下的雪落了三天，街面上没有一个卖炭的人。守城的兵卒围着火盆打盹，铁甲上结了一层薄霜，谁也不肯先开口说话。`,
    `${CHAPTER_TITLES[1]}\n虎牢关的鼓声一夜未停，守将把盔缨系了两遍又松开。探马第三次回报说敌军尚在三十里外，帐中无人敢信，也没人敢不信。`,
    `${CHAPTER_TITLES[2]}\n黑木崖上有人吹笛，笛声里带着饕餮二字的古意。山下渡口那条船等了半月，船家说从没人见崖上有人下来过。`,
  ].join("\n\n");
}

export function txtFile(name: string, text: string) {
  return { name, mimeType: "text/plain", buffer: Buffer.from(text, "utf8") };
}

/** 纯中文、无 BOM 的 UTF-16：批次 E-1 的编码判据要在真字节上再验一次。 */
export function txtFileUtf16NoBom(name: string, text: string) {
  return { name, mimeType: "text/plain", buffer: Buffer.from(text, "utf16le") };
}

/**
 * 最小可用 EPUB：container.xml 指 OPF，OPF 里 dc:title + spine + manifest。
 * 章节标题写在正文里，交给同一套章节探测器切。
 */
export async function epubFile(name: string, title: string, chapters: string[]): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  const items = chapters.map((_, i) => `<item id="c${i}" href="ch${i}.xhtml" media-type="application/xhtml+xml"/>`).join("");
  const refs = chapters.map((_, i) => `<itemref idref="c${i}"/>`).join("");
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>佚名</dc:creator></metadata><manifest>${items}</manifest><spine>${refs}</spine></package>`,
  );
  chapters.forEach((body, i) => {
    zip.file(
      `OEBPS/ch${i}.xhtml`,
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><p>${body}</p></body></html>`,
    );
  });
  return { name, mimeType: "application/epub+zip", buffer: await zip.generateAsync({ type: "nodebuffer" }) };
}

/**
 * 走真文件输入（`BookSelect.tsx:561-575` 的隐藏 input）。
 *
 * 不点"从文件夹导入"：那条路走 `showOpenFilePicker`（BookSelect.tsx:420），
 * 自动化浏览器里没有这个 API，点了只会走到 catch 分支。
 */
export async function importFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void> {
  await page.locator("#novel-file-input").setInputFiles(files);
}

export function shelfCard(page: Page, title: string) {
  return page.getByRole("heading", { name: `《${title}》` });
}

export async function openBook(page: Page, title: string): Promise<void> {
  await shelfCard(page, title).click();
  await expect(page.locator(".chapter-section").first()).toBeVisible();
}

export function chapterSection(page: Page, index: number) {
  return page.locator(".chapter-section").filter({
    has: page.getByRole("heading", { name: CHAPTER_TITLES[index], exact: true, level: 2 }),
  });
}

export async function backToShelf(page: Page): Promise<void> {
  await page.getByRole("button", { name: "书架" }).click();
}

/** 目录侧栏里的章节按钮（宽屏才有，见 ReadingPanel.tsx:47）。按钮文案可能带序号前缀，所以不用 exact。 */
export function navChapter(page: Page, index: number) {
  return page.getByRole("button", { name: new RegExp(CHAPTER_TITLES[index]) });
}
