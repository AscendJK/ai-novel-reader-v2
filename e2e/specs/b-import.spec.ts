import { test, expect } from "@playwright/test";
import { stubBackend, idleTtsStatus } from "../fixtures/backend";
import { seedSession, openApp } from "../pages/app";
import {
  CHAPTER_TITLES,
  backToShelf,
  chapterRendered,
  chapterSection,
  epubFile,
  importFiles,
  longNovel,
  miniNovel,
  navChapter,
  navEntry,
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
  // 读整个 main 的文本，而不是 shelfCard(...).innerText()：卡片不在时后者会一直抛错，
  // expect.poll 把抛错当"还没满足"重试到超时，报错里只剩一句 Timeout waiting on the
  // predicate，看不出是"进度没记上"还是"根本没回到书架"。读 main 才有真值可看。
  await expect
    .poll(async () => (await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 300), {
      timeout: 20_000,
      message: "回书架之后应当看到第三章的进度",
    })
    .toContain("已读至第 3 章");
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

/**
 * 把阅读容器瞬移到某个位置，并补足检测所需的滚动事件。
 *
 * 两步都是必要的：容器带 `scroll-smooth` 类，程序化赋值也走平滑动画（产品自己在
 * `useContinuousScroll.ts:180` 同样先临时关掉再滚），不瞬移落地量到的就是路上那一帧；
 * 而检测按 rAF 节流、每 3 帧才跑一次（同文件 :423），一次跳变只产生一个滚动事件，
 * 静止位置反而永远不被检测看过一次。
 */
async function scrollToAndSettle(page: import("@playwright/test").Page, top: number | "max"): Promise<void> {
  await page.locator(".chapter-scroll-container").evaluate(async (el, value) => {
    el.style.scrollBehavior = "auto";
    el.scrollTop = value === "max" ? el.scrollHeight : value;
    for (let i = 0; i < 4; i++) {
      el.dispatchEvent(new Event("scroll"));
      await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve(); }); });
    }
  }, top);
}

/** 进度此刻记在第几章（书架卡片显示的就是它，直接在阅读器里读同一份状态） */
function storedChapterIndex(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate((user: string) => {
    const positions = JSON.parse(localStorage.getItem(`novel-reader-positions:${user}`) || "{}");
    const values = Object.values(positions) as { chapterIndex: number }[];
    return values.length === 1 ? values[0].chapterIndex : -1;
  }, USER);
}

test("B9 读到全书最末：最后一章再短也算读到它，停在中间时又不许提前跳到末章", async ({ page }) => {
  // 本机实测的几何：容器 523 高，三章 193/258/258。滚到底 scrollTop=269 已是上限，
  // 第三章顶部落在容器内 182px 处，而检测区是顶部 5%~15%（26~78px）——末章够不到检测区，
  // 检测把"当前章"判成第二章，进度从 100% 退回 66.67%。jsdom 量不到布局，只有浏览器层看得见。
  test.setTimeout(60_000);
  await importFiles(page, [txtFile("末章测试.txt", miniNovel())]);
  await openBook(page, "末章测试");
  // 等过"打开书时恢复位置"的静默期：useContinuousScroll 在恢复期间把检测整个关掉
  // （100ms 定位 + 500ms 解锁），这 600ms 里滚动，检测根本不会跑，测的就不是检测了。
  await page.waitForTimeout(800);

  // 反向判据：末尾兜底不能写成"永远算最后一章"。停在第二章占检测区的位置（200px）时，
  // 进度必须是第二章。
  await scrollToAndSettle(page, 200);
  await expect.poll(() => storedChapterIndex(page), { timeout: 10_000 }).toBe(1);

  await scrollToAndSettle(page, "max");
  await expect.poll(() => storedChapterIndex(page), { timeout: 10_000 }).toBe(2);

  await backToShelf(page);
  await expect(page.getByText("已读至第 3 章")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("100.00%")).toBeVisible();
});

/**
 * 定长伪随机点击序列（不用 Math.random）：同一份种子每次跑出同一串，红的时候能复现，
 * 也不会某天靠运气躲开缺陷。乘数取小是为了让 `state * A` 不超过 2^53——JS 只有
 * Number 没有整数溢出，溢出之后序列就不是确定性的了。
 */
function clickSequence(count: number, chapters: number, seed = 20260921): number[] {
  let state = seed % 4294967296;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const picks: number[] = [];
  let prev = -1;
  while (picks.length < count) {
    const i = Math.floor(next() * chapters);
    if (i !== prev) {
      picks.push(i);
      prev = i;
    }
  }
  return picks;
}

/** 当前章在多久之后落回点的那一章（true = 落回来了，哪怕绕了一圈） */
async function settlesTo(page: import("@playwright/test").Page, index: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  do {
    if ((await storedChapterIndex(page)) === index) return true;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  return false;
}

/** 产品侧的静默窗长度，见 `useContinuousScroll.ts` 的 `SUPPRESS_RELEASE_MS`。 */
const SUPPRESS_WINDOW_MS = 500;

/** 页内一次采样：t 用页面时钟（performance.now），i 是那一刻 store 里的当前章 */
interface Sample {
  t: number;
  i: number;
}

/**
 * 静默窗只能让页面自己量：CDP 一次 evaluate 往返就要几十到几百毫秒，"点完再读一次"
 * 根本落不进 500ms 窗里——第一版就是这么写的，报出来的"窗内 0 次"是假数。
 * 这里每 16ms 抄一份 localStorage，点完再一次性取回，按采样自己的时间轴对齐。
 */
async function startWindowSampling(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate((user: string) => {
    const w = window as unknown as { __b10?: Sample[]; __b10Timer?: number };
    w.__b10 = [];
    clearInterval(w.__b10Timer);
    w.__b10Timer = window.setInterval(() => {
      const positions = JSON.parse(localStorage.getItem(`novel-reader-positions:${user}`) || "{}");
      const values = Object.values(positions) as { chapterIndex: number }[];
      w.__b10?.push({ t: performance.now(), i: values.length === 1 ? values[0].chapterIndex : -1 });
    }, 16);
  }, USER);
}

async function stopWindowSampling(page: import("@playwright/test").Page): Promise<Sample[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __b10?: Sample[]; __b10Timer?: number };
    clearInterval(w.__b10Timer);
    const samples = w.__b10 ?? [];
    w.__b10 = undefined;
    return samples;
  });
}

/**
 * B10（§8.5 ①）：25 章的书连点 20 次目录，每一次"当前章"都必须落回刚点的那一章。
 * 真实时钟，不 mock rAF、不 mock 计时；25 章是为了越过 `LOAD_BATCH = 10` 这条懒加载
 * 分界——三章小样本走不到 `ChapterNav.tsx:58-84` 的异步分支。
 *
 * 两条读数分开：
 * - 判据（终态）：点完之后当前章必须等于点的那一章，红 = 用户看得见"点 A 得 B"。
 *   实测就是它抓到的：跳章落点被 content-visibility 的估算高度塌成真实高度 + 浏览器
 *   scroll anchoring 拉走 119px，检测区里躺着上一章。
 * - 观测（窗内）：静默窗本该让检测闭嘴，`suppressIO` 之后到出窗之前当前章被改写就说明
 *   窗没生效。这条**只打印不断言**——它现在是 0 次，把它焊成硬判据等于替一次
 *   还没发生的改动押注；红了再说（§8.5 ① 记的就是这个决定）。
 */
test("B10 连点目录 20 次：每次的当前章都必须落回刚点的那一章", async ({ page }) => {
  test.setTimeout(180_000); // 20 次点击 × 真实静默窗，量出来的就是时间
  const CHAPTERS = 25;
  await importFiles(page, [txtFile("长书压力.txt", longNovel(CHAPTERS))]);
  await openBook(page, "长书压力");
  // 等过"打开书时恢复位置"的静默期，理由同 B9：那 600ms 里检测根本不该跑
  await page.waitForTimeout(900);

  const terminal: string[] = [];
  const late: string[] = [];
  const inWindow: string[] = [];
  const log: string[] = [];

  for (const idx of clickSequence(20, CHAPTERS)) {
    const entry = navEntry(page, idx + 1);
    const chapterId = await entry.getAttribute("data-chapter-id");
    const lazy = chapterId ? !(await chapterRendered(page, chapterId)) : false;

    await startWindowSampling(page);
    await entry.click();
    await page.waitForTimeout(1_400); // 盖住整个静默窗 + 出窗后那次主动检测
    const samples = await stopWindowSampling(page);
    const atWindowEnd = await storedChapterIndex(page);

    // 窗的起点 = 页内采样第一次读到"点的那一章"的那一刻，也就是点击写进 store 的时刻
    const t0 = samples.find((s) => s.i === idx)?.t;
    if (t0 === undefined) {
      terminal.push(`点第${idx + 1}章 → 1.4 秒内当前章从没等于它（此刻=第${atWindowEnd + 1}章）`);
      log.push(`${idx + 1}${lazy ? "懒" : "同"}✗没落地`);
      continue;
    }
    const corrupt = samples.find(
      (s) => s.t > t0 && s.t - t0 < SUPPRESS_WINDOW_MS && s.i >= 0 && s.i !== idx,
    );
    if (corrupt) inWindow.push(`点第${idx + 1}章 → 窗内 +${Math.round(corrupt.t - t0)}ms 当前章=第${corrupt.i + 1}章`);

    if (atWindowEnd !== idx) {
      if (await settlesTo(page, idx, 3_000)) {
        late.push(`点第${idx + 1}章 → 1.4 秒时=第${atWindowEnd + 1}章，再给 3 秒绕回来了`);
      } else {
        terminal.push(`点第${idx + 1}章 → 出窗后停在第${atWindowEnd + 1}章，再给 3 秒也没回来`);
      }
    }
    log.push(`${idx + 1}${lazy ? "懒" : "同"}${corrupt ? " 窗内≠" : ""}${atWindowEnd === idx ? "" : " 出窗≠"}`);
  }

  console.log(`[B10] 序列 ${log.join(" | ")}`);
  console.log(`[B10] 窗内被改写 ${inWindow.length} 次：${inWindow.join("；") || "无"}`);
  console.log(`[B10] 出窗抖动后自愈 ${late.length} 次：${late.join("；") || "无"}`);

  expect(terminal, `${terminal.length}/20 次点目录之后当前章不是点的那一章`).toEqual([]);
});
