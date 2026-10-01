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

/** 分页/滚动偏好：`single`/`double`/`scroll` 走 localStorage 初值（`ui-store.ts:43-46`），自动切页关掉，免得被宽度牵着走 */
async function seedReadingMode(page: Page, mode: "single" | "double" | "scroll", autoSwitch = false): Promise<void> {
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

/**
 * B20 钉的是闸门里「窄窗口」那一支：这里没有 `hasTouch`，Chromium 的指针仍是鼠标
 * （`(pointer: coarse)` 为假），点按还灵就说明宽度那半没被摘走——桌面把窗子拖窄的读者照旧能点。
 * B28 钉另一支（触摸 + 宽屏），B29 钉"两支都不成立时不接管"。
 */
test("B20 窄窗口 + 鼠标：点屏幕左中右三块各自是上一页、双击沉浸、下一页", async ({ page }) => {
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

/**
 * B27：自动阅读（滚动模式）真的在动吗——最低档 0.5 行/秒。
 *
 * 制作人报"设到 0.5 行/秒就卡住不动"。成因在 `useAutoRead.ts:217` 那一行
 * `el.scrollTop += 速度 × 行高 × dt × 缓启动系数`：**浏览器写 `scrollTop` 会归到整数像素**，
 * 而 0.5 行/秒 × 行高 32.4px ÷ 60 帧 ≈ **0.27px/帧**——每一帧都被抹平，小数永远进不了下一像素。
 * 这一格单测看不见：`useAutoRead.test.ts:44` 里那个 `el.scrollTop` 是只普通 JS 数字属性
 * （jsdom 不模拟取整），+= 0.27 攒得干干净净，所以既有 5 条判据（最低测到 1 行/秒）全绿。
 * 判据放在浏览器层，并且**同一趟跑两档**：4 行/秒是对照，用来证明"红了是产品坏了"而不是量法坏了。
 */
test("B27 自动阅读（滚动模式）：最低档 0.5 行/秒要真的在动，4 行/秒是对照", async ({ page }) => {
  // 两档各测 6 秒 / 4 秒，加开机与导入：这条天生比别家慢，天花板单独抬（同 D6 的做法）
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await seedReadingMode(page, "scroll");
  await openApp(page);
  await importFiles(page, [txtFile("阅读页.txt", pagedNovel())]);
  await expect(shelfCard(page, "阅读页")).toBeVisible();
  await shelfCard(page, "阅读页").click();
  const scroller = page.locator(".chapter-scroll-container");
  await expect(scroller).toBeVisible({ timeout: 20_000 });

  /** 开自动阅读，并把滚动速度设成 `speed` 行/秒（走真 UI：那枚「快捷调速」的下拉） */
  const setSpeed = async (speed: number) => {
    await page.getByTitle("自动阅读（速度/间隔在字体面板中设置）").click();
    await expect(page.getByTitle("停止自动阅读")).toBeVisible();
    await page.getByTitle("快捷调速").click();
    await page.getByRole("button", { name: `${speed} 行/秒` }).click();
    await expect(page.getByTitle("快捷调速")).toContainText(`${speed} 行/秒`);
  };

  /** 在 `windowMs` 毫秒里量正文真的挪了多少像素（行高取正文段落现场的 `line-height`，不抄默认值） */
  const measure = (windowMs: number) =>
    page.evaluate(async (ms) => {
      const el = document.querySelector(".chapter-scroll-container") as HTMLElement;
      // `.chapter-section` 里第一只 `p` 是章题下面那行小字（text-xs，行高 16px），
      // 要的是正文：`.prose` 里那些（实测行高 = 字号 18 × 1.8 = 32.4px）
      const bodyPara = el.querySelector(".chapter-section .prose p") ?? el.querySelector("p");
      const lineHeightPx = parseFloat(getComputedStyle(bodyPara!).lineHeight);
      const start = el.scrollTop;
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, ms));
      return {
        lineHeightPx,
        moved: el.scrollTop - start,
        elapsed: performance.now() - t0,
        room: el.scrollHeight - el.clientHeight - start,
      };
    }, windowMs);

  /** 期望位移：扣掉 800ms 缓启动平均少跑的那半秒 */
  const expectedPx = (speed: number, lineHeightPx: number, elapsedMs: number) =>
    speed * lineHeightPx * ((elapsedMs / 1000) - 0.4);

  // ── 报的那一档：0.5 行/秒 ──
  await setSpeed(0.5);
  const slow = await measure(6000);
  const slowExpected = expectedPx(0.5, slow.lineHeightPx, slow.elapsed);
  console.log(
    `[B27] 0.5 行/秒：行高 ${slow.lineHeightPx.toFixed(1)}px，${(slow.elapsed / 1000).toFixed(2)} 秒里挪了 ` +
      `${slow.moved}px（该 ${slowExpected.toFixed(0)}px），剩余可滚 ${slow.room}px`
  );
  expect(slow.room, "样本撑不出可滚距离，这一格是空转").toBeGreaterThan(slowExpected * 2);
  expect(
    slow.moved,
    `0.5 行/秒该走约 ${slowExpected.toFixed(0)}px，实际 ${slow.moved}px——逐帧位移不足 1px 时被 scrollTop 取整抹平了`
  ).toBeGreaterThanOrEqual(slowExpected * 0.6);

  // ── 对照：4 行/秒（同一台机器同一趟，量法坏了它也得不绿）──
  await page.getByTitle("快捷调速").click();
  await page.getByRole("button", { name: "4 行/秒" }).click();
  const fast = await measure(4000);
  const fastExpected = expectedPx(4, fast.lineHeightPx, fast.elapsed);
  console.log(`[B27] 4 行/秒（对照）：${(fast.elapsed / 1000).toFixed(2)} 秒里挪了 ${fast.moved}px（该 ${fastExpected.toFixed(0)}px）`);
  expect(fast.moved, `对照组只走了 ${fast.moved}px，说明量法或自动阅读本身没生效`).toBeGreaterThanOrEqual(fastExpected * 0.6);

  await page.getByTitle("停止自动阅读").click();
});

/**
 * B28/B29/B30：点按手势跟「输入方式」走，不跟宽度走。
 *
 * 制作人报"翻页模式下点屏幕左右两半翻不了页"。旧闸门是 `innerWidth >= 768` 直接 return，
 * 平板竖屏正好撞在这一格上——iPad 竖屏就是 768 CSS px，手指点两侧什么都不发生。
 * 现在的口径是 `窄窗口 || (pointer: coarse)`：触摸设备任意宽度都接管，桌面宽度 + 鼠标不接管
 * （那一次 click 常见的是划选文字，误翻页比少一个手势坏）。
 *
 * 触摸那一支靠 `hasTouch` 造出来，所以两格开头都先自证媒体查询现场是真/假——
 * 台架要是没把主指针换成触摸，B28 会退化成"什么都不测"的假绿。
 */
test.describe("平板竖屏那一档：手指点两侧翻页", () => {
  test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true });

  test("B28 768 宽 + 触摸：点右缘翻下一页，点左缘翻回上一页", async ({ page }) => {
    await seedReadingMode(page, "single");
    await openApp(page);
    expect(
      await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches),
      "hasTouch 没把主指针变成触摸，这一格会空转"
    ).toBe(true);
    await openPagedBook(page, "阅读页");

    const total = await settledTotal(page);
    expect(total, "样本撑不出多页，点按判据会空转").toBeGreaterThan(2);

    const canvas = page.locator('div[style*="touch-action"]');
    const box = (await canvas.boundingBox())!;
    const at = (ratio: number) => ({ x: box.width * ratio, y: box.height * 0.5 });

    await canvas.click({ position: at(0.92) });
    await expect(pageLabel(page), "触摸设备在 768 宽点右缘该翻到下一页").toHaveText(`2 / ${total}`);
    await canvas.click({ position: at(0.06) });
    await expect(pageLabel(page), "同一宽度点左缘该翻回上一页").toHaveText(`1 / ${total}`);
  });

  test("B30 同一宽度、滚动模式：点中间两下照样进沉浸（两处手势共用一道闸门）", async ({ page }) => {
    // `ChapterContent` 里点按手势有两处：分页那三块与滚动模式中间的双击沉浸。
    // 旧口径两处各写一遍 `innerWidth >= 768`，改一处漏一处就会"平板上翻页能用、沉浸按不动"，
    // 而现在它们共用 `tapGesturesEnabled()`——这一格钉的就是共用那半。
    await seedReadingMode(page, "scroll");
    await openApp(page);
    expect(await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches), "台架没造出触摸").toBe(true);
    await openPagedBook(page, "阅读页");

    const scroller = page.locator(".chapter-scroll-container");
    await expect(scroller).toBeVisible();
    const box = (await scroller.boundingBox())!;
    await expect(page.getByTitle("退出沉浸模式")).toHaveCount(0);

    await scroller.dblclick({ position: { x: box.width * 0.5, y: box.height * 0.5 } });
    await expect(page.getByTitle("退出沉浸模式"), "768 宽的触摸设备上双击中间该进沉浸").toBeVisible();
  });
});

test.describe("桌面宽度 + 鼠标：点正文两侧不接管", () => {
  test("B29 1280 宽、指针是 fine：点两侧页码一动不动", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await seedReadingMode(page, "single");
    await openApp(page);
    expect(
      await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches),
      "这一格要的是鼠标环境，coarse 为真说明台架串了"
    ).toBe(false);
    await openPagedBook(page, "阅读页");

    const total = await settledTotal(page);
    const canvas = page.locator('div[style*="touch-action"]');
    const box = (await canvas.boundingBox())!;
    const at = (ratio: number) => ({ x: box.width * ratio, y: box.height * 0.5 });

    // 右缘那一发才是这格的靶子：闸门写成恒真时它翻到 2，直接红。
    // （左缘在第一页时就算闸门开着也只是"已是第一章"点了不动，所以往回那一发要先翻到第 2 页再试）
    await canvas.click({ position: at(0.92) });
    await expect(pageLabel(page), "桌面宽度 + 鼠标：点右缘不该翻页").toHaveText(`1 / ${total}`);

    await bottomNav(page).getByRole("button", { name: "下一页" }).click();
    await expect(pageLabel(page)).toHaveText(`2 / ${total}`);
    await canvas.click({ position: at(0.06) });
    await expect(pageLabel(page), "桌面宽度 + 鼠标：点左缘不该翻回去").toHaveText(`2 / ${total}`);
  });
});
