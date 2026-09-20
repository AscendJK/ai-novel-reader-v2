import { test, expect } from "@playwright/test";
import { stubBackend, idleTtsStatus } from "../fixtures/backend";
import { seedSession, openApp } from "../pages/app";
import {
  CHAPTER_TITLES,
  backToShelf,
  chapterSection,
  epubFile,
  importFiles,
  miniNovel,
  navChapter,
  openBook,
  shelfCard,
  txtFile,
  txtFileUtf16NoBom,
} from "../pages/shelf";

/**
 * B 组：导入与阅读。这一组是浏览器层最典型的"jsdom 看不见"的路——真 File 对象、
 * 真字节解码、真 IndexedDB 落盘与刷新后回读。
 */

const USER = "e2e-shelf-user";

test.beforeEach(async ({ page }) => {
  await stubBackend(page, idleTtsStatus);
  await seedSession(page, { username: USER });
  await openApp(page);
});

test("B1 导入一本 .txt：书名取文件名，章数取真章节数", async ({ page }) => {
  await importFiles(page, [txtFile("洛阳旧事.txt", miniNovel())]);

  await expect(shelfCard(page, "洛阳旧事")).toBeVisible();
  await expect(page.getByText("3 章")).toBeVisible();
});

test("B2 导入 .epub：书名取 dc:title 而不是文件名，spine 顺序决定章节顺序", async ({ page }) => {
  const book = await epubFile("shelves.epub", "黑木崖纪事", [
    `${CHAPTER_TITLES[0]}\n崖下的雪落了三天，渡口没有人来。船家把缆绳换了两次，第二次连系法都变了，还是没人上船，只剩灶上的火一天比一天小。`,
    `${CHAPTER_TITLES[1]}\n关上的鼓声一夜未停，守将把盔缨系了两遍。探马来回三趟，说的都是同一句：敌军还在三十里外，谁也不肯先出关去看。`,
  ]);
  await importFiles(page, [book]);

  // 文件名是 shelves.epub，卡片标题必须是 dc:title；文件名本身仍显示在卡片副行里，
  // 两者来源不同（OPF metadata vs 文件名），所以两条一起断言才说明"没拿文件名当书名"
  await expect(shelfCard(page, "黑木崖纪事")).toBeVisible();
  await expect(page.getByText("shelves.epub")).toBeVisible();

  await openBook(page, "黑木崖纪事");
  await expect(chapterSection(page, 0)).toContainText("崖下的雪落了三天");
  await expect(chapterSection(page, 1)).toContainText("关上的鼓声一夜未停");
});

test("B3 一次导入三本：三张卡各自对得上自己的章数，内容不串号", async ({ page }) => {
  await importFiles(page, [
    txtFile("甲部.txt", miniNovel()),
    txtFile(
      "乙部.txt",
      `${CHAPTER_TITLES[0]}\n乙部第一句独有。后面再补几句凑够独立成章的字数，免得被并进上一章去。这一段特意写长，短于五十字会被合并。\n\n${CHAPTER_TITLES[1]}\n乙部第二句独有。这一段同样写长一些，两章各归各位才不会串号，读者一眼就能看出内容没混。`,
    ),
    txtFile("丙部.txt", "整本没有章节标题的一段话，丙部独有。"),
  ]);

  await expect(shelfCard(page, "甲部")).toBeVisible();
  await expect(shelfCard(page, "乙部")).toBeVisible();
  await expect(shelfCard(page, "丙部")).toBeVisible();

  await openBook(page, "乙部");
  await expect(chapterSection(page, 0)).toContainText("乙部第一句独有");
  await expect(chapterSection(page, 1)).toContainText("乙部第二句独有");
  await expect(page.locator(".chapter-section")).toHaveCount(2);
});

test("B4 不支持的扩展名：明确报错，且一本都不落库", async ({ page }) => {
  await importFiles(page, [{ name: "旧稿.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("假内容") }]);

  await expect(page.getByText("所选文件夹中未找到 .txt 或 .epub 文件")).toBeVisible();
  await expect(page.getByRole("heading", { name: "《旧稿》" })).toHaveCount(0);
  await expect(shelfCard(page, "旧稿")).toHaveCount(0);
});

test("B5 纯中文无 BOM 的 UTF-16：按 UTF-16 解，不再误判成 GBK 出乱码", async ({ page }) => {
  await importFiles(page, [txtFileUtf16NoBom("utf16旧事.txt", miniNovel())]);
  await openBook(page, "utf16旧事");

  // 判据取"生僻字 + 全角标点"：GBK 误判时这两处必然碎掉，而碎掉后仍可能有"第一章"字样
  await expect(chapterSection(page, 2)).toContainText("饕餮");
  await expect(chapterSection(page, 0)).toContainText("洛阳城下的雪落了三天，街面上没有一个卖炭的人。");
  const body = await page.locator(".chapter-section").first().innerText();
  expect(body, "解码失败时浏览器会留下 U+FFFD 替换符").not.toMatch(/\uFFFD/);
});

test("B6 打开书：三章全渲染、每章正文在自己的段落里；点目录会真的滚过去", async ({ page }) => {
  await importFiles(page, [txtFile("滚动测试.txt", miniNovel())]);
  await openBook(page, "滚动测试");

  await expect(page.locator(".chapter-section")).toHaveCount(3);
  // 按 DOM 顺序断言（不是"哪个标题下有什么"）——变异把章节倒序时，配对式断言全绿，
  // 只有这种写法才红（实测：chapters.reverse() 之下 B3/B5 都不红）。
  await expect(page.locator(".chapter-section").nth(0)).toContainText("洛阳城下的雪");
  await expect(page.locator(".chapter-section").nth(1)).toContainText("虎牢关的鼓声");
  await expect(page.locator(".chapter-section").nth(2)).toContainText("黑木崖上有人吹笛");

  const scroller = page.locator(".chapter-scroll-container");
  const before = await scroller.evaluate((el) => el.scrollTop);
  await navChapter(page, 2).click();
  await expect
    .poll(async () => (await scroller.evaluate((el) => el.scrollTop)) > before, { timeout: 5_000 })
    .toBe(true);
});

test("B7 读到第三章：回书架显示进度，刷新后进度还在（真 localStorage 落盘）", async ({ page }) => {
  test.setTimeout(60_000); // 刷新后的两条判据各给 20 秒，整条测试的天花板要跟着抬
  await importFiles(page, [txtFile("进度测试.txt", miniNovel())]);
  await openBook(page, "进度测试");
  await navChapter(page, 2).click();
  await backToShelf(page);

  // 这条用例只有一本书，所以进度文案全局唯一；不靠卡片祖先节点定位（那种 xpath 一改布局就碎）
  const progress = page.getByText("已读至第 3 章");
  await expect(progress).toBeVisible();

  await page.reload();
  // 刷新之后要等的是"整页重 boot + 从 IndexedDB 读回书架"，实测耗时随并发线性恶化
  // （10 worker 下这一条要走 14.6 秒，单跑 5 秒），所以这里的预算单给 20 秒。
  // 刻意不用 retries 兜：判据红的原因是"永远读不回来"，多给时间不改变它会不会红。
  await expect(shelfCard(page, "进度测试")).toBeVisible({ timeout: 20_000 });
  await expect(progress).toBeVisible({ timeout: 20_000 });
});

test("B8 刷新后书架不空：导入的结果落在浏览器本地库里", async ({ page }) => {
  test.setTimeout(60_000); // 见 B7 那条注释：满并行时"重 boot + 读回"要走十几秒
  await importFiles(page, [txtFile("刷新测试.txt", miniNovel())]);
  await expect(shelfCard(page, "刷新测试")).toBeVisible();

  await page.reload();
  await expect(shelfCard(page, "刷新测试")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("3 章")).toBeVisible({ timeout: 20_000 });
});
