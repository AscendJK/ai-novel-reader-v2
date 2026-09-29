import { test, expect, type Page } from "@playwright/test";
import { stubBackend, idleTtsStatus } from "../fixtures/backend";
import { seedSession, openApp } from "../pages/app";
import { importFiles, shelfCard, txtFile } from "../pages/shelf";

/**
 * B3 组：阅读页的"翻页那一套"（`ChapterContent.tsx`）。
 *
 * B 组钉的是"三章全渲染、点目录会滚过去、进度落盘"，G 组钉的是窄屏布局，
 * 而这个组件自己那半——分页模式怎么翻到下一章、底栏那两个标签在边界上说什么、
 * 移动端点屏幕左中右三块各自做什么、双页门槛那两个数字（1024 / 展开右栏时 1400）——
 * 一条判据都没有：它每次开书都被加载（覆盖地板第 2 档），断言从没穿过它。
 *
 * 这些出口坏起来的形状都不报错：翻页按钮点了没反应、双页在窄屏上挤成半页、
 * 移动端点右边翻不了页。所以每条都钉"看得见的东西"（底栏那两个标签与页码那格）。
 */

const USER = "e2e-read3-user";

/** 标题行 + `paragraphs` 段正文：够撑出好几页，又不至于慢。 */
function pagedNovel(chapters = 3, paragraphs = 34): string {
  const line = "渡口那条船在天亮前解开缆，船家说这一班从不等人，可每年清明前后总有一封信会迟到，迟到时人都不在了。";
  return Array.from({ length: chapters }, (_, i) => {
    const n = i + 1;
    const body = Array.from({ length: paragraphs }, (_, p) => `第${p + 1}段。${line}`).join("\n\n");
    return `第${"一二三四五六七八九十"[i]}章 阅读页${n}\n${body}`;
  }).join("\n\n");
}

/** 分页模式偏好：`double`/`single` 走 localStorage 初值（`ui-store.ts:43-46`），自动切页关掉，免得被宽度牵着走 */
async function seedReadingMode(page: Page, mode: "single" | "double", autoSwitch = false): Promise<void> {
  await page.addInitScript(
    ({ m, auto }) => {
      localStorage.setItem("novel-reader-reading-mode", m);
      localStorage.setItem("novel-reader-auto-switch-page", auto ? "true" : "false");
    },
    { m: mode, auto: autoSwitch },
  );
}

/** 底栏那一格页码（分页模式：`页 / 总页`；双页时前半是 `1-2`） */
const pageLabel = (page: Page) => page.locator("span.whitespace-nowrap").filter({ hasText: /^\S+ \/ \d+$/ });

/**
 * 底栏本体。**跨章那两枚按钮的文案就是章节标题**，与左侧目录里那枚同名按钮撞车
 * （不锚底栏就是 strict mode violation，症状像坏了其实是定位符），所以凡按名字点
 * 章题的都从这儿走。
 */
const bottomNav = (page: Page) =>
  page.locator("div.border-t.bg-card").filter({ has: page.locator("span.whitespace-nowrap") });

async function openPagedBook(page: Page, title: string): Promise<void> {
  await importFiles(page, [txtFile(`${title}.txt`, pagedNovel())]);
  await expect(shelfCard(page, title)).toBeVisible();
  await shelfCard(page, title).click();
  await expect(pageLabel(page)).toBeVisible({ timeout: 20_000 });
}

/**
 * 分页要量完才有真实页数：量出来之前那一格写的是兜底的 `1 / 1`（`displayTotalPages = max(totalPages,1)`）。
 * 所以"总页数"必须等它长出来再读，否则整条判据会在"一页"上空转（第一版就是这么红的）。
 */
/** 页码那一格此刻写的总页数 */
async function totalNow(page: Page): Promise<number> {
  const [, raw] = (await pageLabel(page).textContent())!.split(" / ");
  return Number(raw);
}

async function settledTotal(page: Page): Promise<number> {
  let total = 1;
  await expect
    .poll(async () => {
      total = await totalNow(page);
      return total;
    }, { message: "分页一直没量出多于一页，样本或测量没生效", timeout: 20_000 })
    .toBeGreaterThan(1);
  return total;
}

test.beforeEach(async ({ page }) => {
  await stubBackend(page, idleTtsStatus);
  await seedSession(page, { username: USER });
});

test("B18 分页模式：末页那一下点下去要真的进下一章并回到第 1 页", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await seedReadingMode(page, "single");
  await openApp(page);
  await openPagedBook(page, "阅读页");

  const total = await settledTotal(page);
  await expect(pageLabel(page)).toHaveText(`1 / ${total}`);
  expect(total, "这一页样本撑不出多页，判据会空转").toBeGreaterThan(2);

  const next = bottomNav(page).getByRole("button", { name: "下一页" });
  for (let i = 1; i < total; i++) await next.click();
  await expect(pageLabel(page)).toHaveText(`${total} / ${total}`);

  const cross = bottomNav(page).getByRole("button", { name: "第二章 阅读页2" });
  await expect(cross, "末页的下一枚按钮该写着下一章标题").toBeVisible();
  await cross.click();

  await expect(pageLabel(page)).toHaveText(`1 / ${total}`);
  await expect(page.getByRole("heading", { name: "第二章 阅读页2" }).last()).toBeVisible();
  // 跨章之后"上一页"也得换成上一章标题：往回那一发是回章首（不是回上一章末页），别骗用户
  await expect(bottomNav(page).getByRole("button", { name: "第一章 阅读页1" })).toBeVisible();
});

test("B19 两头的边界要改口：第一章第一页没有「回上一页」，最后一章末页没有「下一页」", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await seedReadingMode(page, "single");
  await openApp(page);
  await openPagedBook(page, "阅读页");

  const nav = bottomNav(page);
  await expect(nav.getByRole("button", { name: "已是第一章" })).toBeDisabled();

  // 逐章走过去（不用"循环到改口为止"那种写法：真卡住时报错要指着是哪一步，而不是兜不住地空转）
  for (const title of ["第二章 阅读页2", "第三章 阅读页3"]) {
    const pages = await settledTotal(page);
    const next = nav.getByRole("button", { name: "下一页" });
    for (let i = 1; i < pages; i++) await next.click();
    const cross = nav.getByRole("button", { name: title });
    await expect(cross, `章末那枚按钮该写着下一章标题：${title}`).toBeVisible();
    await cross.click();
    // 落进下一章的第一页：页码回到 1，标题就是刚点的那一章
    await expect(pageLabel(page)).toHaveText(/^1 \/ \d+$/);
    await expect(page.getByRole("heading", { name: title }).last()).toBeVisible();
  }
  // 上面那一圈是"跨进每一章"，走完停在最后一章第一页：再翻到它的末页
  const lastPages = await settledTotal(page);
  for (let i = 1; i < lastPages; i++) await nav.getByRole("button", { name: "下一页" }).click();
  await expect(nav.getByRole("button", { name: "已是最后一章" })).toBeDisabled();
  await expect(nav.getByRole("button", { name: "下一页" })).toHaveCount(0);
});

test("B20 移动端：点屏幕左中右三块各自是上一页、双击沉浸、下一页", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 820 });
  await seedReadingMode(page, "single");
  await openApp(page);
  await openPagedBook(page, "阅读页");

  // 必须先等分页量出来再点：测量排在 100ms 防抖之后，窗内 `totalPages` 恒 0，而那时点右缘
  // 的正确行为是"什么都不做"（`ChapterContent.tsx` 的 pendingMeasure 护栏）。B18/B19 一开始
  // 就等，这一条漏了——CI 2026-09-29 首次跑全量时它落在窗内，判据把"护栏生效"读成坏了。
  // 窗内那一格由 jsdom 层钉住（`ChapterContent-internals.test.tsx`），这儿要钉的是量完之后。
  await settledTotal(page);

  // 正文容器：翻页模式下唯一带 touch-action 的那块（点它才走 handlePageClick）
  const canvas = page.locator('div[style*="touch-action"]');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const at = (ratio: number) => ({ x: box.width * ratio, y: box.height * 0.5 });

  await canvas.click({ position: at(0.92) });
  await expect(pageLabel(page)).toHaveText(/^2 \/ \d+$/);
  await canvas.click({ position: at(0.06) });
  await expect(pageLabel(page)).toHaveText(/^1 \/ \d+$/);

  // 中间那一块不是翻页，是双击进沉浸：沉浸之后底栏整个不挂
  await canvas.dblclick({ position: at(0.5) });
  await expect(page.getByRole("button", { name: "下一页" })).toHaveCount(0);
  await expect(page.getByTitle("退出沉浸模式")).toBeVisible();

  await page.getByTitle("退出沉浸模式").click();
  await expect(page.getByRole("button", { name: "下一页" })).toBeVisible();
});

test("B21 自动切页：双页要够 1024，右栏展开时门槛抬到 1400", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await seedReadingMode(page, "double", true);
  await openApp(page);
  await openPagedBook(page, "阅读页");

  // 1100 ≥ 1024 且右栏收起 → 双页，页码那一格写的是 "1-2"
  await expect(pageLabel(page)).toHaveText(/1-2 \/ \d+$/);

  // 右栏展开会压缩阅读区：同样 1100 宽就不该再双页（挤成半页是看得见的坏）
  await page.getByRole("button", { name: "展开 AI 分析面板" }).click();
  await expect(pageLabel(page)).toHaveText(/^1 \/ \d+$/);

  await page.setViewportSize({ width: 1440, height: 720 });
  await expect(pageLabel(page)).toHaveText(/1-2 \/ \d+$/);

  // 收回右栏后回到 1024 那道门槛以下。**宽度必须落在 768..1024 之间**：再窄就先被
  // `< 768` 那一硬闸拦掉（量不到软门槛，把 1024 改成 500 照样绿，实测漏过一次），
  // 而"768 以下一律单页"是 B22 的靶子。
  await page.getByRole("button", { name: "收起 AI 分析面板" }).click();
  await page.setViewportSize({ width: 900, height: 720 });
  await expect(pageLabel(page)).toHaveText(/^1 \/ \d+$/);
});

test("B22 关掉「自动切页」之后：用户选的 double 只在宽屏生效，窄屏仍一律单页", async ({ page }) => {
  // 这条专门钉 `windowWidth < 768 → single` 那一硬闸。B21 那一眼是遮不住的：
  // 那儿开着自动切页，700 宽本来就被 1024 那道软门槛挡成单页，把硬闸删掉照样绿（实测过）。
  await page.setViewportSize({ width: 1000, height: 720 });
  await seedReadingMode(page, "double", false);
  await openApp(page);
  await openPagedBook(page, "阅读页");
  await expect(pageLabel(page)).toHaveText(/1-2 \/ \d+$/);

  await page.setViewportSize({ width: 700, height: 720 });
  await expect(pageLabel(page)).toHaveText(/^1 \/ \d+$/);
});

test("B23 容器尺寸变了要重量：窗口拉矮之后正文得重新排成更多页", async ({ page }) => {
  // 钉的是 `ChapterContent.tsx:337-349` 那只 ResizeObserver。量出来的容器尺寸只喂
  // `pageWidth`/`contentHeight`（`:307-313`）再进 usePagination，而 usePagination 自己
  // 没有观察器——"尺寸变了要重排"这条路上它是唯一入口。B21 那种"展开右栏"的断言挡不住：
  // 单页/双页那一步读的是 windowWidth（`:103-110`，走 resize 监听），不是量出来的尺寸。
  // 实测：摘掉 `obs.observe(el)` 之后 B18~B22 五条全绿，只有这条红（"拉一次只重量一次"
  // 那种写法也试了，红的是同一个位置，所以这里不另加"拉回原尺寸"那一半——它没有自己的靶子）。
  // 单测层没有立足点：`src/test/setup.ts` 那只 ResizeObserver 桩的 `observe()` 是空的，回调永远不会被叫醒。
  await page.setViewportSize({ width: 1280, height: 720 });
  await seedReadingMode(page, "single");
  await openApp(page);
  await openPagedBook(page, "阅读页");

  const before = await settledTotal(page);

  await page.setViewportSize({ width: 1280, height: 420 });
  await expect
    .poll(() => totalNow(page), {
      message: "拉矮之后总页数没变＝没重量容器，正文会按旧高度排、底下那一截看不见",
      timeout: 15_000,
    })
    .toBeGreaterThan(before);
});

/** 目录里那一条此刻的横向形状（`read` 与探针逐项同源）。 */
async function navWidths(page: Page): Promise<{ vpClient: number; vpScroll: number; spanClient: number; spanScroll: number }> {
  return page.evaluate(() => {
    const vp = document.querySelector<HTMLElement>('[data-sidebar="chapter-nav"] [data-radix-scroll-area-viewport]')!;
    const span = vp.querySelector<HTMLElement>("span")!;
    return {
      vpClient: vp.clientWidth,
      vpScroll: vp.scrollWidth,
      spanClient: span.clientWidth,
      spanScroll: span.scrollWidth,
    };
  });
}

test("B25 目录里一条超长章节标题：不许把列表拉宽，要走省略号", async ({ page }) => {
  /**
   * 钉的是 `ui/scroll-area` 那半段命令式覆盖（`useFixViewportDisplay`）在真布局里的后果。
   * 单测层只能判"那两层 style 被写成了 block / 0"，判不了"会不会真撑破"——jsdom 没有表格
   * 自动布局，`clientWidth`/`scrollWidth` 恒 0。所以这一条是这只壳在浏览器层的靶子
   * （它历史上被修过六次：`0a5d594`→`5c9c00d`→`e2e9021`→`8ee5aee`→`57ceab8`→两笔清理）。
   *
   * 四组实测读数（`第N章 ` + 40 多个汉字，`text-xs`，侧栏 `md:w-56`=224px，viewport 可视宽 192px）：
   * - 产品现在这样：viewport **192/192** 不溢；标题那一格可见 142 / 需要 534 → 省略号真在截。
   * - 只把**内层**那行 `display` 退回 `"table"`（`minWidth` 仍按平到 0）：viewport **192/584**，
   *   横向多出来 392px，标题那一格变成 534/534（不再被截）→ 本条红，报"溢出 392px"。
   * - 两层都退回 Radix 默认的 `display:table` + `minWidth:100%`：同样是 192/584。
   * - 把**外层**那两行整个删掉：viewport 仍然 192/192，本条**照绿**。
   *   所以这一条只管得住内层那一只——外层那两行在目录这个调用点上量不出后果（它挡住的是
   *   另一类"Viewport 自己带上 table/100%"的形状），它的判据在单测层那边。
   *
   * 三条读数按"前提 → 终态 → 用户口径"排：前提那句必须在两种形状下都成立，否则它会抢在
   * 判据前面响（第一版就是拿"标题被截了没"当前提，结果刀落下先红的是它，报出来的像是样本坏了）。
   */
  await page.setViewportSize({ width: 1280, height: 720 });
  await seedReadingMode(page, "single");
  await openApp(page);
  const LONG = "渡口长亭短歌无名氏拟古其一其二其三其四其五其六其七其八其九其十并排再长一点看撑不撑";
  const body =
    "石阶被水泡过了三道，缆桩上系着的麻绳换了两回，等船的人始终没有来，只有船家每天把篷布掀开又盖上，天黑了才回屋。";
  const text = Array.from({ length: 8 }, (_, i) => `第${i + 1}章 ${LONG}${i + 1}\n${body}${body}`).join("\n\n");
  await importFiles(page, [txtFile("长标题目录.txt", text)]);
  await expect(shelfCard(page, "长标题目录")).toBeVisible({ timeout: 30_000 });
  await shelfCard(page, "长标题目录").click();
  await page.waitForSelector('[data-sidebar="chapter-nav"] [data-radix-scroll-area-viewport] span', { timeout: 30_000 });

  const w = await navWidths(page);
  console.log(`[B25] 目录 viewport ${w.vpClient}/${w.vpScroll}，标题那一格 ${w.spanClient}/${w.spanScroll}`);
  expect(w.spanScroll, `标题需要 ${w.spanScroll}px，这一列给得起 ${w.vpClient}px：样本不够长，后两条判据是空的`).toBeGreaterThan(
    w.vpClient
  );
  expect(w.vpScroll, `目录列表横向溢出 ${w.vpScroll - w.vpClient}px（可视宽 ${w.vpClient}px）——Radix 那只 table 包裹没被按平`).toBeLessThanOrEqual(
    w.vpClient + 1
  );
  expect(w.spanClient, "标题那一格没被截（可见宽就等于需要宽），省略号没生效").toBeLessThan(w.spanScroll);
});
