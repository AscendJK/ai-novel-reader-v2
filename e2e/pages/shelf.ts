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

/** 长书样本的标题格式，`navEntry` 的定位锚点与它同源 */
export function longChapterTitle(n: number): string {
  return `第${n}章 渡口${n}`;
}

/**
 * `chapterCount` 章的长书。为什么要超过 10 章：滚动 hook 的懒加载批是 `LOAD_BATCH = 10`，
 * 打开书时窗口外的章节没有 content，点它走的是 `ChapterNav.tsx:58-84` 那条"先异步读库、
 * 再抑制、再滚动"的分支——三章小样本（`miniNovel`）永远碰不到这条路。
 */
export function longNovel(chapterCount = 25): string {
  const sentence =
    "石阶被水泡过了三道，缆桩上系着的麻绳换了两回，等船的人始终没有来，只有船家每天把篷布掀开又盖上，天黑了才回屋。";
  return Array.from({ length: chapterCount }, (_, i) => {
    const n = i + 1;
    return `${longChapterTitle(n)}\n渡口${n}这一站的第一句。${sentence}${sentence}`;
  }).join("\n\n");
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
  // 必须限定在侧栏容器里：移动端那份目录抽屉（ReadingPanel.tsx:134-146）也挂着同名按钮
  return page.locator('[data-sidebar="chapter-nav"]').getByRole("button", { name: new RegExp(CHAPTER_TITLES[index]) });
}

/** 目录侧栏里 `longNovel` 的第 n 章（n 从 1 起）。收尾锚定，避免"第 2 章"前缀撞上"第 25 章"。 */
export function navEntry(page: Page, n: number) {
  return page
    .locator('[data-sidebar="chapter-nav"]')
    .getByRole("button", { name: new RegExp(`${longChapterTitle(n)}$`) });
}

/** 这一章的内容此刻在不在阅读 DOM 里（在 = 点它走同步分支，不在 = 走懒加载分支） */
export async function chapterRendered(page: Page, chapterId: string): Promise<boolean> {
  return (await page.locator(`.chapter-section[data-chapter-id="${chapterId}"]`).count()) > 0;
}
