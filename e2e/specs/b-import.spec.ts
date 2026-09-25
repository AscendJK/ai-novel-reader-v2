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
      // 8 秒不是放水：缺陷的形状是"停在错的那一章不动"（检测已出窗、没有后续事件会
      // 再来一次），所以永久错的版本给多久都不会自己回来；而满负载下一次懒加载点击
      // 落地可以超过 3 秒（实测并发下红过一次）。
      if (await settlesTo(page, idx, 8_000)) {
        late.push(`点第${idx + 1}章 → 1.4 秒时=第${atWindowEnd + 1}章，后面绕回来了`);
      } else {
        terminal.push(`点第${idx + 1}章 → 出窗后停在第${atWindowEnd + 1}章，再给 8 秒也没回来`);
      }
    }
    log.push(`${idx + 1}${lazy ? "懒" : "同"}${corrupt ? " 窗内≠" : ""}${atWindowEnd === idx ? "" : " 出窗≠"}`);
  }

  console.log(`[B10] 序列 ${log.join(" | ")}`);
  console.log(`[B10] 窗内被改写 ${inWindow.length} 次：${inWindow.join("；") || "无"}`);
  console.log(`[B10] 出窗抖动后自愈 ${late.length} 次：${late.join("；") || "无"}`);

  expect(terminal, `${terminal.length}/20 次点目录之后当前章不是点的那一章`).toEqual([]);
});

/**
 * ── B24 台架：一只 scrollTop 上的两个写者 ─────────────────────────────
 *
 * 产品里对阅读容器的程序化写入只有两条路径（全仓 grep 过，`scrollTop =` 与 `.scrollTo(`
 * 各只有一处命中）：
 * - **补偿** `useContinuousScroll.ts:157`：上翻补载到内容之后
 *   `container.scrollTop = container.scrollTop + grown`。
 * - **逐帧纠正** `useContinuousScroll.ts:221`：跳章之后每帧
 *   `container.scrollTo({ top: container.scrollTop + drift, behavior: "instant" })`，
 *   跑到静默窗（500ms）结束；补偿落笔时会把它再叫起来一个窗（:162 → :232）。
 * 修之前补偿拿的是"`await loadChapters` 之前抄的那个绝对位置 + Δ"，而 `settleTokenRef`
 * 只挡下一次跳章、挡不住补偿——两个写者之间没有互锁，于是补偿只要落在跳章之后，就把整个
 * 文档甩回跳章之前的位置。这一条判据就是量它还会不会走形，不是在描述现状。
 *
 * 台架怎么撞出这个交错：补偿只在"已载窗口不含第一章"时才可能发生
 * （`useContinuousScroll.ts:136-142`：`firstLoaded.index - 10 >= firstLoaded.index` 直接返回），
 * 而窗口从书架点进来时按 `loadNovel(novelId, chapterIndex)` 只载目标章前后各 10 章
 * （`repositories.ts:82-87`）——所以先把进度推到第 20 章、回书架再点开，窗口就是
 * 第 10~25 章；此刻把容器顶到 scrollTop≈30，顶部哨兵（`ChapterContent.tsx:829`，h-px）
 * 落进 IO 的上沿 rootMargin 200px，上翻补载开始；在「IO 回调」与「补偿写」之间点目录，
 * 就得到"跳章在前、补偿在后"的交错。这个交错不是编出来的：用户在补载没回来时点了目录，
 * 就是这个时序。
 */

type WriteKind = "prepend" | "settle" | "jump" | "harness";

/** 一次 scrollTop 变化。`from` 是写之前的真值，`to` 是想写的值 */
interface ScrollWrite {
  t: number;
  kind: WriteKind;
  from: number;
  to: number;
}

/** 页内每帧抄一次现场。`drift` = 目标章顶部相对容器顶部的偏移（产品把落点钉在 0） */
interface ScrollFrame {
  t: number;
  scrollTop: number;
  scrollHeight: number;
  drift: number | null;
}

interface ProbeWindow {
  writes: ScrollWrite[];
  frames: ScrollFrame[];
  harness: boolean;
  want: Element | null;
}

/**
 * 三只 API 各包一层：scrollTop setter / scrollTo 装在容器实例上，scrollIntoView 装在
 * Element.prototype 上（只给 `.chapter-section` 记账，目录侧栏自己那份
 * `scrollIntoView({block:"nearest"})` 与朗读段落那条不算）。
 */
async function installScrollProbe(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const container = document.querySelector(".chapter-scroll-container") as HTMLElement;
    const proto = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    if (!proto?.get || !proto.set) throw new Error("B24 台架：包不住 scrollTop setter");
    const state: ProbeWindow = { writes: [], frames: [], harness: false, want: null };
    (window as unknown as { __b24: ProbeWindow }).__b24 = state;
    const realTop = proto.get.bind(container) as () => number;
    const write = (v: number) => (proto.set as (x: number) => void).call(container, v);

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      get: () => realTop(),
      set: (v: number) => {
        state.writes.push({ t: performance.now(), kind: state.harness ? "harness" : "prepend", from: realTop(), to: v });
        write(v);
      },
    });

    const realScrollTo = container.scrollTo.bind(container);
    (container as unknown as { scrollTo: (arg: ScrollToOptions) => void }).scrollTo = (arg: ScrollToOptions) => {
      state.writes.push({ t: performance.now(), kind: "settle", from: realTop(), to: arg.top ?? 0 });
      realScrollTo(arg);
    };

    const realInto = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, ...args: Parameters<Element["scrollIntoView"]>) {
      const before = realTop();
      realInto.apply(this, args);
      if (this.classList.contains("chapter-section")) {
        state.writes.push({ t: performance.now(), kind: "jump", from: before, to: realTop() });
      }
    };

    const sample = () => {
      const want = state.want;
      state.frames.push({
        t: performance.now(),
        scrollTop: realTop(),
        scrollHeight: container.scrollHeight,
        drift: want?.isConnected ? want.getBoundingClientRect().top - container.getBoundingClientRect().top : null,
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

/** 一次争用尝试的现场 */
interface Attempt {
  clickedAt: number;
  view: number;
  writes: ScrollWrite[];
  frames: ScrollFrame[];
}

/**
 * 顶到哨兵区 → 等 `delayMs` → 真点一下目录里的目标章 → 采样 1.8 秒。
 * 整段都在页内跑：CDP 一次往返几十到几百毫秒，"滚完再点"在页外根本排不进那两个间隙里。
 */
async function provokePrependRace(
  page: import("@playwright/test").Page,
  chapterId: string,
  delayMs: number
): Promise<Attempt> {
  return page.evaluate(
    async ({ id, delay }) => {
      const container = document.querySelector(".chapter-scroll-container") as HTMLElement;
      const state = (window as unknown as { __b24: ProbeWindow }).__b24;
      const target = container.querySelector(`.chapter-section[data-chapter-id="${id}"]`);
      if (!target) throw new Error("B24 台架：目标章不在 DOM 里，点它会走懒加载分支");
      const entry = document.querySelector<HTMLButtonElement>(`[data-sidebar="chapter-nav"] button[data-chapter-id="${id}"]`);
      if (!entry) throw new Error("B24 台架：侧栏目录里找不到这一章的按钮");

      state.writes.length = 0;
      state.frames.length = 0;
      state.want = target;
      // 内联 auto 只为了"这一下瞬移"，写完立刻交还给产品的 .scroll-smooth——
      // 留着它会替产品改掉补偿写的动画口径，量到的就不是现场了
      container.style.scrollBehavior = "auto";
      state.harness = true;
      container.scrollTop = 30;
      state.harness = false;
      container.style.scrollBehavior = "";

      const clickedAt = performance.now();
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      entry.click();
      await new Promise<void>((resolve) => setTimeout(resolve, 1_800));
      return { clickedAt, view: container.clientHeight, writes: state.writes.slice(), frames: state.frames.slice() };
    },
    { id: chapterId, delay: delayMs }
  );
}

/** 把一次尝试的现场折成几个数（都是"用户看得见"的量，不是内部状态） */
function readAttempt(attempt: Attempt, storedIndex: number) {
  const jump = attempt.writes.find((w) => w.kind === "jump");
  const prepends = attempt.writes.filter((w) => w.kind === "prepend");
  // 交错 = 补偿写在跳章那一跳之后落笔：两个写者真抢上了同一只 scrollTop
  const raced = prepends.filter((p) => jump && p.t > jump.t);
  const afterJump = attempt.frames.filter((f) => jump && f.t > jump.t + 32 && f.drift !== null);
  const tail = attempt.frames.filter((f) => f.drift !== null).slice(-5);
  return {
    raced: raced.length,
    prependWrites: prepends.length,
    settleWrites: attempt.writes.filter((w) => w.kind === "settle").length,
    // 补偿那一笔把 scrollTop 挪了多少像素（修好之后 ≈ 插进来的内容高度，本身不是缺陷）
    writtenPx: Math.max(0, ...raced.map((p) => Math.abs(p.to - p.from))),
    flashPx: Math.max(0, ...afterJump.map((f) => Math.abs(f.drift ?? 0))),
    terminalPx: tail.length ? Math.max(...tail.map((f) => Math.abs(f.drift ?? 0))) : Number.NaN,
    view: attempt.view,
    storedIndex,
  };
}

/**
 * B24：上翻补载的补偿写与跳章的逐帧纠正抢同一只 scrollTop。
 *
 * 每一轮都从书架重新点开（重新载入才会得到"窗口不含第一章"的现场），所以一尝试一次开书。
 * 两档时钟：正常 CPU，和 CDP 的 6 倍降速（模拟慢机）。
 *
 * 三条判据，2026-09-25 五轮台架读数（`降速×/点前延迟`）写在每条后面：
 * - **落点**（终态）：1.8 秒后目标章顶部离容器顶部 ≤ 2px。未修时 1×/16 与 1×/40 是 0.2px，
 *   6×/24 是 **4585px**——补偿写在纠正循环收工之后才落笔，把整个文档甩回"跳章之前"的位置，
 *   再没有人拽回来。
 * - **当前章**（同一条缺陷的用户口径）：store 里必须还是点的那一章。未修时 6×/24 那轮是
 *   第 9 章，也就是"点第 24 章 → 界面停在第 9 章 → 进度记成第 9 章"。
 * - **不许整屏走形**（过程量）：跳章之后任何一帧，目标章顶部都不许离开落点超过一屏
 *   （一屏 523px）。没争用的轮次是 0px，未修时争用轮次是 4520px（1× 时下一帧被纠正拽回来了，
 *   可用户已经看见页面飞走过一次）。阈值取"一屏"而不是 0，是因为 scroll anchoring 本身就有
 *   亚屏级的瞬时漂移（B10 记过 119px 这一档），那一量级不该算这条红。
 *
 * 四刀逐条打过修好的产品，两半各被一条单独咬住（都在 6×/24ms 那轮现形）：
 * - 刀1 把补偿换回"补载前抄的绝对值 + Δ" → 只有**不许整屏走形**红（4520px）。
 * - 刀2 摘掉 `rearmSettleRef.current?.()` → 只有**落点**红（204px）。
 * - 刀3 只重启循环、不续窗，刀4 只续窗、不重启循环 → 都是**落点**红（204px）：补偿那一笔
 *   自己有 204px 残差（离屏章节按 500px 估算记账），叫循环和续窗缺一个都兜不住它。
 * - 修完之后五轮：落点 0.2~0.3px，窗内最大偏 0 或 204px，当前章全是第 24 章。
 *
 * 最后那条 `interleaved > 0` 是台架自检：它红了不是产品坏了，而是这一轮两个写者根本没
 * 碰上——那上面三条判据全是空转，绿灯不算数。
 */
test("B24 补载补偿与跳章纠正抢 scrollTop：点第 24 章不许落回别处", async ({ page }) => {
  test.setTimeout(360_000); // 每轮都要重开一次书，慢机档还要降速
  const CHAPTERS = 25;
  const CLICK_CHAPTER = 24; // 已载窗口 10~25 里的深处一章：跳它，落点离scrollTop=30 越远越看得出
  await importFiles(page, [txtFile("补载争用.txt", longNovel(CHAPTERS))]);
  await openBook(page, "补载争用");
  await page.waitForTimeout(900);

  const cdp = await page.context().newCDPSession(page);
  const bad: string[] = [];
  const log: string[] = [];
  let interleaved = 0;

  for (const phase of [
    { rate: 1, delays: [0, 16, 40] },
    { rate: 6, delays: [0, 24] },
  ]) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: phase.rate });
    for (const delay of phase.delays) {
      // 现场复位：进度必须在第 20 章，且必须"从书架重新点开"，这样载入窗口才是 10~25 章
      await navEntry(page, 20).click();
      await page.waitForTimeout(1_600);
      await backToShelf(page);
      await expect(shelfCard(page, "补载争用")).toBeVisible({ timeout: 30_000 });
      await openBook(page, "补载争用");
      await page.waitForTimeout(1_500); // 等恢复位置那 600ms 静默期走完
      await installScrollProbe(page);

      const chapterId = await navEntry(page, CLICK_CHAPTER).getAttribute("data-chapter-id");
      if (!chapterId) throw new Error("B24 台架：目录里没有第 24 章");
      const attempt = await provokePrependRace(page, chapterId, delay);
      const n = readAttempt(attempt, await storedChapterIndex(page));
      const label = `降速${phase.rate}×/延迟${delay}ms`;
      interleaved += n.raced;

      if (n.raced > 0) {
        if (!(n.terminalPx >= 0 && n.terminalPx <= 2)) {
          bad.push(`${label} → 补偿写在跳章之后落笔，1.8 秒后第${CLICK_CHAPTER}章顶部离落点 ${n.terminalPx.toFixed(0)}px`);
        }
        if (n.storedIndex !== CLICK_CHAPTER - 1) {
          bad.push(`${label} → 界面当前章=第${n.storedIndex + 1}章，不是点的第${CLICK_CHAPTER}章`);
        }
        if (!(n.flashPx >= 0 && n.flashPx < n.view)) {
          bad.push(`${label} → 跳章之后有帧把第${CLICK_CHAPTER}章甩开 ${n.flashPx.toFixed(0)}px（一屏 ${n.view}px）`);
        }
      }
      log.push(
        `${label} 补偿${n.prependWrites}/交错${n.raced}/这一笔挪${n.writtenPx.toFixed(0)}/纠正${n.settleWrites}` +
          `/窗内最大偏${n.flashPx.toFixed(0)}/落点${n.terminalPx.toFixed(1)}/第${n.storedIndex + 1}章`
      );
    }
  }
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  console.log(`[B24] ${log.join("\n[B24] ")}`);
  console.log(`[B24] ${interleaved}/5 轮出现"补偿写在跳章之后"，判据红 ${bad.length} 条：${bad.join("；") || "无"}`);

  expect(interleaved, "台架没能让补偿落在跳章之后（这一轮两个写者根本没抢过同一只 scrollTop）").toBeGreaterThan(0);
  expect(bad, `${bad.length} 轮的落点/当前章离开了刚点的那一章`).toEqual([]);
});
