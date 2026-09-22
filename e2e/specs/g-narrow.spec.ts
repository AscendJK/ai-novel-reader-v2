import { test, expect, type Locator, type Page } from "@playwright/test";
import { stubBackend, idleTtsStatus, type Backend, type StubTable } from "../fixtures/backend";
import { vendorBaseUrl, vendorTable } from "../fixtures/vendor";
import { MAP_PLACES, mapFixture } from "../fixtures/map";
import { openApp, seedSession, expectUnblocked, expectBlocked } from "../pages/app";
import { addProvider, leaveSettings, openSettings } from "../pages/settings";
import { importFiles, miniNovel, openBook, txtFile, CHAPTER_TITLES } from "../pages/shelf";
import { mobilePanel } from "../pages/panel";

/**
 * G 组：390×844 窄屏（iPhone 12 的 CSS 宽度）。桌面那一套 1280×720 跑不到这些代码路径：
 * 底栏、目录抽屉、整屏 AI 面板全是 `md:hidden` 的分支，`ReadingPanel.tsx` 里它们与桌面
 * 侧栏是**两份并存的 DOM**——所以判据一律带容器域（同 C 组那份说明）。
 *
 * 会话一律走离线态（`seedSession({offline:true})`）：这一组要量的是版面与点击链，
 * 心跳/周期同步只会往请求面里掺噪声。
 */

const USER = "e2e-narrow-user";
const BOOK = "窄屏测试";
/** 必须纯 ASCII：它会进 `Authorization` 头（见 C 组同一条注释） */
const FAKE_KEY = "sk-e2e-g-fake-key-0123456789";

test.use({ viewport: { width: 390, height: 844 } });

/** 开页 + 导一本三章小书 + 进阅读器。返回 backend 以便查请求面。 */
async function openReaderAt390(page: Page, table: StubTable = {}): Promise<Backend> {
  const backend = await stubBackend(page, { ...idleTtsStatus, ...table });
  await seedSession(page, { username: USER, offline: true });
  await openApp(page);
  await importFiles(page, [txtFile(`${BOOK}.txt`, miniNovel())]);
  await openBook(page, BOOK);
  return backend;
}

/** 阅读器底部那六枚按钮（`ReadingPanel.tsx:74-99`，只有窄屏才有这一条） */
const dockButton = (page: Page, name: string): Locator => page.getByRole("button", { name, exact: true });

/** 窄屏这一份面板：整屏那个容器，不是桌面侧栏 */
const aiPanel = (page: Page): Locator => page.locator("[data-mobile-ai-panel]");
const navDrawer = (page: Page): Locator => page.locator("[data-mobile-nav-drawer]");

/** 窄屏上摸任何一枚底栏按钮之前，先把 Toast 请走（见函数内注释） */
async function clearToasts(page: Page): Promise<void> {
  for (const b of await page.getByLabel("关闭通知").all()) await b.click().catch(() => {});
}

/** 整页不许出现横向滚动条——窄屏上这等于"内容被切掉一半，用户只能左右拖" */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const box = await page.evaluate(() => {
    // 只算"没有被任何裁剪祖先拦住"的越界元素：全屏地图那张 svg 本来就是 1170 宽、
    // 塞在 `overflow-hidden` 的容器里靠拖动看，它越界是设计，不是 bug。
    const clipped = (el: Element): boolean => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === "hidden" || o === "clip") return true;
      }
      return false;
    };
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      // 顺带把越界的那个元素揪出来：只报"页面宽了 12px"的话，下一次红了没人找得到是谁
      offenders: [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((el) => !clipped(el) && el.getBoundingClientRect().right > window.innerWidth + 1)
        .slice(0, 3)
        .map((el) => `${el.tagName}.${(el.className || "").toString().slice(0, 40)}@${Math.round(el.getBoundingClientRect().right)}`),
    };
  });
  expect(box.offenders, `越界元素：${box.offenders.join(" | ")}`).toEqual([]);
  expect(box.scrollWidth, `documentElement.scrollWidth=${box.scrollWidth} 视口=${box.innerWidth}`).toBeLessThanOrEqual(box.innerWidth);
}

test("G1 底部六枚入口都在、都点得到，点「问答」真的把整屏面板开起来", async ({ page }) => {
  test.setTimeout(60_000);
  await openReaderAt390(page);
  // 离线态导入必然弹那一句"已保存到本地，上传服务器失败，有网时自动同步"
  // （`useFileParser.ts:147`）。Toast 是 `fixed bottom-4 right-4 z-[100]`（`Toast.tsx:44`），
  // 正好压在底栏那六枚上面，5 秒后自己收（`toast-store.ts:34-37`）。浮层盖住工具条是设计，
  // 不是缺陷，所以"底栏点得到"这条判据必须等浮层走了再摸——先请走，免得每条用例白等 5 秒。
  await clearToasts(page);

  for (const name of ["目录", "问答", "本章", "全书", "笔记", "搜索"]) {
    await expectUnblocked(dockButton(page, name));
  }

  await dockButton(page, "问答").click();
  await expect(aiPanel(page)).toBeVisible();
  // 开起来的必须是用户刚点的那一格：`openMobileTab` 先设 tab 再开面板，
  // 反过来的话这里会停在上一格（`ReadingPanel.tsx:66-69`）
  await expect(mobilePanel.tab(page, "问答")).toHaveAttribute("aria-selected", "true");
});

test("G2 目录抽屉：打开盖住正文，关掉之后正文必须重新点得到", async ({ page }) => {
  test.setTimeout(60_000);
  await openReaderAt390(page);

  const chapter = page.getByRole("heading", { name: CHAPTER_TITLES[0], exact: true }).first();
  await expect(chapter).toBeVisible();

  await dockButton(page, "目录").click();
  await expect(navDrawer(page)).toBeVisible();
  // 抽屉里那份目录与桌面侧栏是两份 DOM，不限定容器就撞 strict mode
  await expect(navDrawer(page).getByRole("button", { name: new RegExp(CHAPTER_TITLES[2]) })).toBeVisible();
  await expectBlocked(chapter);

  await page.getByLabel("关闭目录").click();
  await expect(navDrawer(page)).toHaveCount(0);
  await expectUnblocked(chapter);
});

test("G2b 抽屉里点章节：选中的是那一篇，而且抽屉得让开（手机上一屏 72% 被盖着不算完）", async ({ page }) => {
  test.setTimeout(60_000);
  await openReaderAt390(page);

  await dockButton(page, "目录").click();
  await navDrawer(page).getByRole("button", { name: new RegExp(CHAPTER_TITLES[2]) }).click();

  // 选中态先对：点第二章结果停在第三章就是串号
  await expect(page.getByText(/3 \/ 3/).first()).toBeVisible({ timeout: 20_000 });
  // 再判抽屉让没让开：390px 上抽屉宽 min(280px,80vw)=280px，不关掉就等于把正文压在下面
  await expect(navDrawer(page)).toHaveCount(0);
});

test("G3 整屏 AI 面板：五格 tab 不滚就得都摸得到，关闭按钮不许被面板自己的东西盖住", async ({ page }) => {
  test.setTimeout(60_000);
  await openReaderAt390(page);

  await dockButton(page, "全书").click();
  const panel = aiPanel(page);
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  // 自称整屏就得真是整屏：`h-dvh` + `fixed top-0`（`ReadingPanel.tsx:150`）
  expect(box?.height).toBeGreaterThanOrEqual(800);

  // 面板顶栏五格是 `flex-1` + `whitespace-nowrap` 挤在 390-2.5*2 里（`SummaryPanel.tsx:327-332`）。
  // 这里**不做任何滚动**：窄屏上"要点一下才能看见"的那一格 tab 就等于不存在。
  for (const name of ["问答", "本章分析", "全书分析", "笔记", "搜索"]) {
    await expectUnblocked(mobilePanel.tab(page, name));
  }
  await expect(mobilePanel.tab(page, "全书分析")).toHaveAttribute("aria-selected", "true");

  await page.getByLabel("关闭 AI 分析").click();
  await expect(panel).toBeHidden();
  await expectUnblocked(dockButton(page, "目录"));
});

/**
 * 390px 下把"小说地图"生成出来、展开、进大图并选中一个地点。
 *
 * 走「大图 → 选地点」而不是点图上的节点：预览那一格只有 192px 高，注入的 svg 按
 * `scale(0.35)` 塞进一层 286% 宽的容器里（`NovelMapSection.tsx:383-391`），热区靠坐标
 * 换算——产品自己都不信它（`:510` 的注释写的就是"移动端点节点热区失效时也能看描述"）。
 * 判据要跑在用户真用得上的入口上。
 */
async function openPlaceDetail(page: Page, places: typeof MAP_PLACES): Promise<Backend> {
  const backend = await stubBackend(page, { ...idleTtsStatus, ...vendorTable({ content: mapFixture(places) }) });
  await seedSession(page, { username: USER, offline: true });
  await openApp(page);
  await openSettings(page);
  await addProvider(page, { name: "e2e 假商", key: FAKE_KEY, baseUrl: vendorBaseUrl(page), model: "e2e-model" });
  await leaveSettings(page);
  await importFiles(page, [txtFile(`${BOOK}.txt`, miniNovel())]);
  await openBook(page, BOOK);
  await clearToasts(page);

  await dockButton(page, "全书").click();
  await mobilePanel.button(page, "生成小说地图").click();
  const header = page.getByRole("button", { name: /^小说地图/ });
  await expect(header).toBeVisible({ timeout: 20_000 });
  await header.click();
  await mobilePanel.button(page, /大图/).click();
  await page.getByLabel("选择地点").selectOption({ value: "p3" });
  await expect(page.getByTestId("place-detail")).toContainText("洛阳", { timeout: 20_000 });
  return backend;
}

test("G4 390px 下打开地点详情：弹窗自己在屏内、整页不许被撑出横向滚动", async ({ page }) => {
  test.setTimeout(120_000);
  const backend = await openPlaceDetail(page, MAP_PLACES);

  const detail = page.getByTestId("place-detail");
  // 关闭按钮点不点得到，比"弹窗存在"更接近用户能不能脱身
  await expectUnblocked(detail.getByLabel("关闭", { exact: true }));
  // 整页不许被撑出横向滚动（越界的元素会被点名）
  await expectNoHorizontalOverflow(page);
  const box = await detail.boundingBox();
  expect(box, "详情卡片没有几何尺寸").not.toBeNull();
  expect(box!.x, "卡片左沿出界").toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, "卡片右沿出了 390 的屏").toBeLessThanOrEqual(390 + 1);
  // 刻意**没有**"下沿必须落在 844 之内"这一条：那层遮罩本来就能纵向滚（`overflow-y-auto`，
  // 就是为了关得掉），纵向出界不是缺陷。实测把卡片整体下移 700px，页面自己滚一下就把
  // 它带回视口，判据照样绿——留一条打不动的断言只会伪造"这块有钉"的错觉。
  // 纵向真正的用户后果（长内容时关不掉）由 G4b 盯。
  // 横向才要硬判：那层没有横向滚动的余地，出界就是切掉一半。
  //
  // 下面那个 1px 容差不是拍的。同一条判据在 Windows 和 WSL Ubuntu 24.04（CI 同款发行版，
  // 无头 Chromium，`--workers=2` 跑满 62 条全绿）实测一位不差：内部 356/356、右沿余量 17px；
  // 把中文字体从文泉驿换成"再加 Noto CJK"数也不动——动的只有纵向（G4b 那张卡片 1371 → 1390），
  // 而纵向这一维上面已经说过为什么不判。CI 那台机器中文不是豆腐块：`playwright install
  // --with-deps` 会 apt 带进 fonts-wqy-zenhei 和 unifont，GitHub 镜像 readme 里只列
  // noto-color-emoji 那是装依赖之前的快照。

  // 上面那条 `expectNoHorizontalOverflow` 看的是"整页有没有被撑出横向滚动"，
  // 而弹窗越界的内容会被祖先的裁剪/滚动吸收掉——实测给卡片塞一个 600px 宽的子元素，
  // 那条照绿。所以对弹窗要单独量它自己：内部一旦比自身宽，用户就得左右拖才看得到全。
  const innerOverhang = await detail.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(innerOverhang, "卡片内部要横向拖才看得全（模型给一段不带空格的长 URL 就是这样）").toBeLessThanOrEqual(1);

  // 这一条判据只该花一次模型调用
  expect(backend.seen().filter((r) => r.path.endsWith("/chat/completions")), "生成地图只发一次请求").toHaveLength(1);
});

test("G4b 模型吐回一段超长描述：详情弹窗必须还能滚到关闭按钮（不能变成关不掉的弹窗）", async ({ page }) => {
  test.setTimeout(120_000);
  // 长描述 + 一串不带空格的链接都是模型真会给出来的形状（`description` 是自由文本）
  const long = MAP_PLACES.map((p) =>
    p.id === "p3" ? { ...p, description: "洛".repeat(1200) + " https://example.com/" + "A".repeat(140) } : p,
  );
  await openPlaceDetail(page, long);

  const detail = page.getByTestId("place-detail");
  const close = detail.getByLabel("关闭", { exact: true });
  // 内容比视口高之后，"看得见"这件事就得靠滚动兑现：先滚到关闭按钮，再判它点得到
  await close.scrollIntoViewIfNeeded();
  await expectUnblocked(close);
  await expectNoHorizontalOverflow(page);
  // 同一条内部量法放在这里才是这一条的主角：不带空格的长 URL 不会被自然折行，
  // 卡片要么把它撑宽（用户得左右拖），要么靠 `break-words` 自己吞掉。
  const overhang = await detail.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overhang, "超长描述把卡片撑得要在内部左右拖").toBeLessThanOrEqual(1);
});

test("G5 竖屏转横屏：当前章必须还是那一章，不许回到第一章", async ({ page }) => {
  test.setTimeout(60_000);
  await openReaderAt390(page);

  // 用底栏的目录抽屉走到第三章（390px 下桌面侧栏不在，这是唯一的入口）
  await dockButton(page, "目录").click();
  await navDrawer(page).getByRole("button", { name: new RegExp(CHAPTER_TITLES[2]) }).click();
  await expect(page.getByText(/3 \/ 3/).first()).toBeVisible({ timeout: 20_000 });

  // 844×390 越过 md(768px) 断点：底栏消失、桌面侧栏出现，这是一次真换肤而不只是缩放
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByText(/3 \/ 3/).first()).toBeVisible({ timeout: 20_000 });

  const stored = await page.evaluate((u) => {
    const positions = JSON.parse(localStorage.getItem(`novel-reader-positions:${u}`) || "{}") as Record<string, { chapterIndex: number }>;
    const values = Object.values(positions);
    return values.length === 1 ? values[0].chapterIndex : -1;
  }, USER);
  expect(stored, "转屏之后落盘的当前章不再是第三章").toBe(2);
});
