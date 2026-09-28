import { test, expect, type Page, type Request } from "@playwright/test";
import { stubBackend, idleTtsStatus, type Backend, type StubTable } from "../fixtures/backend";
import { openApp, sel } from "../pages/app";
import { backToShelf, epubFile, importFiles, miniNovel, openBook, shelfCard, txtFile } from "../pages/shelf";

/**
 * B2 组：书架这个组件自己的出口（`BookSelect.tsx`）。
 *
 * B 组钉的是"导入进去、读得出来"，F 组钉的是"服务器答了之后徽章变成什么"，而这个组件
 * 自己那半——搜索框按哪三个字段过滤、同名文件跳不跳、从服务器书库「加入书架」整条链、
 * 删一本书要做的那几件事、离线时书库不许留出口、TXT 编码那个下拉到底传没传进解析器——
 * 之前一条判据都没有：浏览器每次开机都加载它（覆盖地板第 2 档），断言从没穿过它。
 *
 * 这些契约坏起来的形状全是**静默**的：卡片少一张、搜不到、按钮还能点、下次同步书又回来，
 * 一句报错都没有。所以每条都钉在"看得见的东西"上，不钉 console。
 */

const USER = "e2e-shelf2-user";
const PENDING_LEAVE_KEY = `novel-reader-pending-leave:${USER}`;

/** 服务器书库那一行的形状，照 `BookSelect.tsx:50-61` 的 `ServerNovel`。 */
const CLOUD_ID = "srv-cloud-book";
const CLOUD_CHAPTERS = [
  { id: "c1", index: 0, title: "云端第一章 起", content: "渡口那条船在天亮前解开缆，船家说这一班从不等人，可每年清明前后总有一封信会迟到，迟到人都不在了。", startOffset: 0, endOffset: 42 },
  { id: "c2", index: 1, title: "云端第二章 渡", content: "石阶上晒着别人家留下的蓑衣，守渡的人换了三届，缆桩上那道刻痕倒是没人舍得磨平，磨平了自家就认不出是哪一根。", startOffset: 42, endOffset: 84 },
  { id: "c3", index: 2, title: "云端第三章 归", content: "对岸的灯灭了又点起来，撑船的人说那是等不到人才会做的事，这话他自己信了半辈子，问到第三十年又说不知道。", startOffset: 84, endOffset: 126 },
];

function serverNovel(over: Record<string, unknown> = {}) {
  return {
    id: CLOUD_ID,
    title: "云端旧事",
    author: "船家",
    fileName: "cloud-book.txt",
    fileFormat: "txt",
    totalChars: 126,
    chapterCount: CLOUD_CHAPTERS.length,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    joined: false,
    ...over,
  };
}

/**
 * 在线会话。`sync-token` 一定要给：书架那两条腿（扫描书库、构建状态轮询）在 token 缺失时
 * 本就不该发请求，不给 token 的话"离线门"那条判据会退化成"没 token 所以没发"，测不到门自己那一半。
 */
async function openOnline(page: Page, extra: StubTable = {}): Promise<Backend> {
  const backend = await stubBackend(page, {
    ...idleTtsStatus,
    "GET /api/novels": { body: [] },
    "GET /api/rag/statuses/all": { body: {} },
    ...extra,
  });
  await page.addInitScript((u) => {
    localStorage.setItem("sync-username", u);
    localStorage.setItem("sync-token", "e2e-token");
  }, USER);
  await openApp(page);
  await expect(page.getByRole("button", { name: "从文件夹导入" })).toBeVisible({ timeout: 20_000 });
  return backend;
}

/** 离线会话：`novel-reader-offline-mode` 是产品自己那把开关（storage.ts:34-40 判字符串 "true"）。 */
async function openOffline(page: Page, extra: StubTable = {}): Promise<Backend> {
  const backend = await stubBackend(page, { ...idleTtsStatus, "GET /api/novels": { body: [] }, ...extra });
  await page.addInitScript((u) => {
    localStorage.setItem("sync-username", u);
    localStorage.setItem("sync-token", "e2e-token");
    localStorage.setItem("novel-reader-offline-mode", "true");
  }, USER);
  await openApp(page);
  await expect(page.getByRole("button", { name: "从文件夹导入" })).toBeVisible({ timeout: 20_000 });
  return backend;
}

/**
 * 按分区锚定卡片。**不能用 `shelfCard`**：书库那一格的标题也是 `《书名》` 的 h3
 * （`BookSelect.tsx:728`），join 过之后同一个书名会在书架与书库各挂一份，
 * 不加锚点就是 strict mode violation（症状像坏了，其实是定位符）。
 */
function inGrid(page: Page, section: string, title: string) {
  return page
    .locator(`xpath=//h2[contains(., "${section}")]/following::div[contains(@class, "grid")][1]`)
    .getByText(`《${title}》`);
}
const shelfTitle = (page: Page, title: string) => inGrid(page, "我的书架", title);
const libraryTitle = (page: Page, title: string) => inGrid(page, "书库", title);
const shelfCount = (page: Page) => page.getByRole("heading", { name: /我的书架/ });
/** 只认正文里那一处章题：阅读页顶部还挂着一枚同名的当前章标题（两处 h2，不锚定就是 strict violation） */
const chapterHeading = (page: Page, title: string) => page.locator(".chapter-section h2", { hasText: title });

/** 点书架上那张卡进阅读（书库那一格点了没反应，别拿它当入口） */
async function openShelfBook(page: Page, title: string): Promise<void> {
  await shelfTitle(page, title).click();
  await expect(page.locator(".chapter-section").first()).toBeVisible();
}

test("B11 搜索框：书名、作者、文件名三个字段都算命中，计数写成 1/3 而不是 3", async ({ page }) => {
  await openOffline(page);
  await importFiles(page, [
    await epubFile("外来档案.epub", "内部题名", [
      "第一章 序\n这一章的正文写得足够长，好让章节探测器把它当成独立的一章，而不是并到上一章的尾巴上去——样本只剩一章时判据会红在错误的地方。",
    ]),
    txtFile("洛阳旧事.txt", miniNovel()),
    txtFile("虎牢关记.txt", miniNovel()),
  ]);
  await expect(shelfCard(page, "内部题名")).toBeVisible();
  await expect(shelfCard(page, "洛阳旧事")).toBeVisible();
  await expect(shelfCard(page, "虎牢关记")).toBeVisible();
  const search = page.locator("#bookshelf-search");

  // 文件名：EPUB 的书名取的是 dc:title（《内部题名》），所以"外来档案"只有走 fileName 这一路才搜得到
  await search.fill("外来档案");
  await expect(shelfCard(page, "内部题名")).toBeVisible();
  await expect(shelfCard(page, "洛阳旧事")).toHaveCount(0);
  await expect(shelfCount(page)).toContainText("1/3");

  // 作者：epub 的 dc:creator 落成"佚名"
  await search.fill("佚名");
  await expect(shelfCard(page, "内部题名")).toBeVisible();

  // 书名
  await search.fill("洛阳");
  await expect(shelfCard(page, "洛阳旧事")).toBeVisible();
  await expect(shelfCard(page, "内部题名")).toHaveCount(0);

  // 清空之后回到全量：过滤留着不放，用户看到的是"书丢了"
  await search.fill("");
  await expect(shelfCard(page, "虎牢关记")).toBeVisible();
  await expect(shelfCount(page)).toContainText("3");
});

test("B12 同名文件不再上第二张卡：跳过谁要点名，库里那一份也不许被覆盖", async ({ page }) => {
  await openOffline(page);
  await importFiles(page, [txtFile("洛阳旧事.txt", miniNovel())]);
  await expect(shelfCard(page, "洛阳旧事")).toBeVisible();

  // 同文件名、完全不同正文。不判重的两种坏法：同一本书上两张卡（点开是同一本），
  // 或者更坏的——第二次把第一次的正文覆盖掉。
  const other = "第一章 另一本\n这一本的正文与上一本毫无关系，讲的是渡口那边的事：船家每天把篷布掀开又盖上，等到天黑了才回屋去睡，第二天再来一遍。";
  await importFiles(page, [txtFile("洛阳旧事.txt", other)]);

  await expect(page.getByText(/已跳过 1 本重复小说：洛阳旧事\.txt/)).toBeVisible();
  await expect(shelfCard(page, "洛阳旧事")).toHaveCount(1);
  await expect(shelfCount(page)).toContainText("1");

  await openBook(page, "洛阳旧事");
  await expect(page.getByText(/洛阳城下的雪落了三天/)).toBeVisible();
  await expect(page.getByText(/渡口那边的事/)).toHaveCount(0);
});

test("B13 从书库「加入书架」：当场就在书架上、点得开、章节真是取回来的、join 真发过、刷新之后还在", async ({ page }) => {
  const backend = await openOnline(page, {
    "GET /api/novels": { body: [serverNovel()] },
    [`GET /api/novels/${CLOUD_ID}/chapters`]: { body: CLOUD_CHAPTERS },
    [`POST /api/novels/${CLOUD_ID}/join`]: { body: { ok: true } },
  });

  await page.getByRole("button", { name: "扫描书库" }).click();
  await expect(libraryTitle(page, "云端旧事")).toBeVisible();
  await page.getByRole("button", { name: "加入书架" }).click();

  await expect(shelfTitle(page, "云端旧事")).toBeVisible();
  expect(backend.count("POST", `/api/novels/${CLOUD_ID}/join`), "加入书架之后该告诉服务器我 join 了这本书").toBe(1);

  // 书库那一行不再是按钮：已经在了，再点一次就是重复导入。（判这一眼要在**点开之前**——
  // 回到书架时 `BookSelect` 是重新挂载的，`serverNovels` 那份 state 清了，得重新扫描才有那一行。）
  await expect(page.getByText("已添加")).toBeVisible();
  await expect(page.getByRole("button", { name: "加入书架" })).toHaveCount(0);

  // 点得开，而且读到的就是刚取回来的那三章（章节真落进了这台机器那个用户的库）
  await openShelfBook(page, "云端旧事");
  await expect(chapterHeading(page, "云端第一章 起")).toBeVisible();
  await expect(chapterHeading(page, "云端第三章 归")).toBeVisible();
  await expect(page.getByText(/渡口那条船在天亮前解开缆/)).toBeVisible();
  await backToShelf(page);

  // 刷新之后还在 = 真落了库。`loadAllNovelMeta` 是按 `createdAt` 排的（schema `novels: "id, createdAt"`），
  // 落库时少写这个字段的话，书在库里、书架上却永远看不见它——当场那一半（本地 state）抓不到，只有这一半抓得到。
  await page.reload();
  await expect(page.getByRole("button", { name: "从文件夹导入" })).toBeVisible({ timeout: 20_000 });
  await expect(shelfTitle(page, "云端旧事")).toBeVisible();
  await openShelfBook(page, "云端旧事");
  await expect(chapterHeading(page, "云端第二章 渡")).toBeVisible();
});

test("B14 删一本书要做满那几件事：确认框如实、leave 真发、记账清掉、书库那行交回可加入、刷新不复活", async ({ page }) => {
  const backend = await openOnline(page, {
    "GET /api/novels": { body: [serverNovel()] },
    [`GET /api/novels/${CLOUD_ID}/chapters`]: { body: CLOUD_CHAPTERS },
    [`POST /api/novels/${CLOUD_ID}/join`]: { body: { ok: true } },
    [`POST /api/novels/${CLOUD_ID}/leave`]: { body: { ok: true } },
  });
  await page.getByRole("button", { name: "扫描书库" }).click();
  await page.getByRole("button", { name: "加入书架" }).click();
  await expect(shelfTitle(page, "云端旧事")).toBeVisible();
  await expect(page.getByText("已添加")).toBeVisible();

  let asked = "";
  page.once("dialog", async (d) => {
    asked = d.message();
    await d.accept();
  });
  await page.getByTitle("删除此书").click();

  // 确认框里那句承诺得有据：服务器那一份不能被他这一删带走
  expect(asked, "确认框没写清服务器那份仍在").toContain("小说本身仍保留在服务器书库中");
  await expect(shelfTitle(page, "云端旧事")).toHaveCount(0);
  expect(backend.count("POST", `/api/novels/${CLOUD_ID}/leave`), "从书架移除要发 leave，否则服务器一直认为我 joined").toBe(1);

  // 本地那条 leave 记账要清掉：留着它，下次同步会一直补发一次已经送达的请求
  expect(await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "[]"), PENDING_LEAVE_KEY)).not.toContain(CLOUD_ID);

  // 书库那一行回到可加入：删了的就是没 join 的
  await expect(page.getByRole("button", { name: "加入书架" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "从文件夹导入" })).toBeVisible({ timeout: 20_000 });
  await expect(shelfTitle(page, "云端旧事")).toHaveCount(0);
});

test("B14b leave 没送达要记账，不许静默丢掉", async ({ page }) => {
  await openOnline(page, {
    "GET /api/novels": { body: [serverNovel()] },
    [`GET /api/novels/${CLOUD_ID}/chapters`]: { body: CLOUD_CHAPTERS },
    [`POST /api/novels/${CLOUD_ID}/join`]: { body: { ok: true } },
    [`POST /api/novels/${CLOUD_ID}/leave`]: { status: 500, body: { error: "服务器炸了" } },
  });
  await page.getByRole("button", { name: "扫描书库" }).click();
  await page.getByRole("button", { name: "加入书架" }).click();
  await expect(shelfTitle(page, "云端旧事")).toBeVisible();

  page.once("dialog", (d) => void d.accept());
  await page.getByTitle("删除此书").click();
  await expect(shelfTitle(page, "云端旧事")).toHaveCount(0);

  // 不记账的话服务器永远认为这本书挂着，下一次同步把它连同云端摘要一起拉回来——删除复活
  await expect
    .poll(() => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "[]"), PENDING_LEAVE_KEY))
    .toContain(CLOUD_ID);
});

test("B15 离线：书库这一区不许留出口，也不许偷打接口", async ({ page }) => {
  const backend = await openOffline(page, { "GET /api/novels": { body: [serverNovel()] } });
  await importFiles(page, [txtFile("洛阳旧事.txt", miniNovel())]);
  await expect(shelfCard(page, "洛阳旧事")).toBeVisible();

  const scan = page.getByRole("button", { name: "离线不可用" });
  await expect(scan).toBeVisible();
  await expect(scan).toBeDisabled();
  await expect(page.getByText("书库需要服务器在线才能访问")).toBeVisible();
  // 构建状态那一路轮询（5 秒一次）也归这个组件管：离线就一发都别发。
  // 要等过那个周期，不然"没发"只是因为还没轮到。
  await page.waitForTimeout(6_000);
  expect(backend.count("GET", "/api/novels"), "离线还在拉服务器书库").toBe(0);
  expect(backend.count("GET", "/api/rag/statuses/all"), "离线还在打构建状态轮询").toBe(0);
});

/** 真 Big5 字节（359 字节）：`第一章 風起` + 三段繁体正文。e2e 不为此引 iconv 依赖，字节按 hex 给。 */
const BIG5_HEX =
  "b2c4a440b3b920adb7b05f0aaca5b6a7abb0a455aabab3b7b8a8a446a454a4d1a141b5f3adb1a457a853a6b3a440add3bde6acb4aabaa448a143a675abb0aabaa74ca8f2b3f2b5dba4f5acd6a5b4acdaa141c54ba5d2a457b5b2a446a440bc68c1a1c1f7a141bdd6a45da4a3aad6a5fdb67da466bba1b8dca1430a0ab2c4a447b3b920b6b3b4e90aaaeaa863c3f6aabab9aac16ea440a95da5bcb0b1a141a675b14ea7e2b2afc5d5c3b4a446a8e2b94da453c350b67da143b1b4b0a8b2c4a454a6b8a65eb3f8bba1bcc4ad78a97ca662a454a451a8bda57ea141b162a4a4b54ca448b4b1ab48a141a45da853a448b4b1a4a3ab48a1430a0ab2c4a454b3b920c26bb37e0ab6c2a4ecb156a457a6b3a448a76ab2c3a141b2c3c16eb8ccb161b5dbc5b9c34ba447a672aabaa56ab74ea143a473a455b4e7a466a8bab1f8b2eeb5a5a446a562a4eba141b2eeae61bba1b171a853a448a8a3b156a457a6b3a448a455a8d3b94ca1430a";
const BIG5_SENTENCE = "洛陽城下的雪落了三天";
const big5File = (name: string) => ({ name, mimeType: "text/plain", buffer: Buffer.from(BIG5_HEX, "hex") });

test("B16 TXT 编码那个下拉是真传进解析器的：选 Big5 就按 Big5 解，选 UTF-8 就真按 UTF-8 解", async ({ page }) => {
  await openOffline(page);
  await page.selectOption("#txt-encoding", "big5");
  await expect(page.getByText("按所选编码解析 .txt")).toBeVisible();
  await importFiles(page, [big5File("繁體新事.txt")]);
  await openBook(page, "繁體新事");
  await expect(page.getByText(new RegExp(BIG5_SENTENCE))).toBeVisible();
  await backToShelf(page);

  // 反向那一半才有判别力：手动指定的优先级高于自动识别。只测"选 Big5 能读对"的话，
  // "下拉根本没传下去、auto 恰好也挑对"这一种坏法演不出来（`pickEncoding` 确实会在
  // GBK/Big5 之间比可读性，所以 auto 是有可能蒙对的）。
  await page.selectOption("#txt-encoding", "utf-8");
  await importFiles(page, [big5File("繁體舊事.txt")]);
  await openBook(page, "繁體舊事");
  await expect(page.locator(".chapter-section").first()).toBeVisible();
  await expect(page.getByText(new RegExp(BIG5_SENTENCE))).toHaveCount(0);
});

test("B17 扫描书库失败：不许停在「扫描中...」，也不许把失败说成「书库为空」", async ({ page }) => {
  await openOnline(page, {
    "GET /api/novels": (req: Request) =>
      new URL(req.url()).searchParams.has("username")
        ? { status: 500, body: { error: "炸了" } }
        : { body: [] },
  });
  const scan = page.getByRole("button", { name: "扫描书库" });
  await scan.click();
  // 按钮文案要回到「扫描书库」：`scanning` 没被 finally 复位的话，这一区从此按不动（转圈不塌）
  await expect(scan).toBeVisible();
  await expect(page.getByRole("button", { name: "扫描中..." })).toHaveCount(0);
  await expect(page.getByText("书库为空")).toHaveCount(0);
});

/**
 * B18：iOS 那一支在浏览器层的证据（制作人 2026-09-28 拍方案 A：入口整条摘掉）。
 *
 * **这一条不验 iOS 的选框行为**——Playwright 只能换 UA，换不掉真 iPhone 的 Files app。
 * 它验的是"产品按 UA 摘掉了那一支"这件事真的活在页面里：同一颗 Chromium（下面那行
 * `expect(hasPicker).toBe(true)` 就是钉这一格——API 明明在，按钮却还是没了，说明起作用的是
 * `BookSelect.tsx:45` 的 `isIOS`，不是"这浏览器没有 File System Access API"那条假解释），
 * 换成 iPhone UA 之后，那颗按钮、那个隐藏的 `webkitdirectory` input、那行指引三样都要对得上，
 * 而**唯一的选文件入口 `#novel-file-input` 不许跟着一起消失**。
 *
 * 就绪门不能用 `openOnline`——它自己就断言那颗按钮可见（在桌面那一组里当门是好的，在这里必挂）。
 */
test.describe("iPhone UA 下文件夹入口整条不出现", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1",
    isMobile: true,
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });

  test("B18 按钮与隐藏 input 都不在，指引换成那句实话，选文件入口还在", async ({ page }) => {
    await stubBackend(page, {
      ...idleTtsStatus,
      "GET /api/novels": { body: [] },
      "GET /api/rag/statuses/all": { body: {} },
    });
    await page.addInitScript((u) => {
      localStorage.setItem("sync-username", u);
      localStorage.setItem("sync-token", "e2e-token");
    }, USER);
    await openApp(page);

    expect(await page.evaluate(() => "showOpenFilePicker" in window)).toBe(true);
    await expect(sel.emptyShelf(page)).toBeVisible({ timeout: 20_000 });
    await expect(sel.folderImportButton(page)).toHaveCount(0);
    await expect(page.locator("#novel-folder-input")).toHaveCount(0);
    await expect(page.locator("#novel-file-input")).toHaveCount(1);
    await expect(page.getByText(/iPhone\/iPad 上「从文件夹导入」只能整包上传，已隐藏/)).toBeVisible();
  });
});

/**
 * B19：桌面那条 `webkitdirectory` 支路的「先算后动」（制作人 2026-09-28 拍 A 带折中）。
 *
 * 为什么浏览器层也要一条：jsdom 那一档（`BookSelect-folder-import.test.tsx`）把 `useFileParser`
 * 整只 mock 掉了——它判得住"确认之前不许解析"，判不住"确认之后真把书送上架"。
 * 被 mock 的壳里那条真解析链从没被穿过，正是跨薄壳那一族的老坑。
 *
 * **喂法不是 `setInputFiles`**：今天实测 Playwright 直接拒——
 * `locator.setInputFiles: Error: [webkitdirectory] input requires passing a path to a directory`，
 * 它只肯往普通 file input 里塞文件。所以这里在页面里造两只 `File` 装进 `input.files` 再派 `change`。
 * 少掉的只有"浏览器真的把一个目录摊成扁平清单"这一步（那是 `webkitdirectory` 的语义，
 * 由 B18 与 `BookSelect.tsx` 那段注释管着）；产品这一侧从 `change` 往后的整条链——过滤、计数、
 * 确认、真解析、落库、上架——穿的仍是实现本身。
 */
test("B19 整文件夹导入：先只报数量，点了确认卡片才出现", async ({ page }) => {
  await openOffline(page);
  const sample = miniNovel();
  await page.evaluate(({ names, body }) => {
    const el = document.querySelector<HTMLInputElement>("#novel-folder-input");
    if (!el) throw new Error("#novel-folder-input 不在 DOM 里（桌面这一支被谁摘了？）");
    const list = names.map((n) => new File([body], n, { type: "text/plain" }));
    Object.defineProperty(el, "files", { value: list, configurable: true });
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, { names: ["洛阳旧事.txt", "虎牢关记.txt"], body: sample });

  await expect(page.getByText(/找到 2 本小说/)).toBeVisible();
  // 确认之前一本书都不许上架——这才是这一格的正面
  await expect(shelfCard(page, "洛阳旧事")).toHaveCount(0);
  await expect(shelfCard(page, "虎牢关记")).toHaveCount(0);

  await page.getByRole("button", { name: "确认导入 2 本" }).click();
  await expect(shelfCard(page, "洛阳旧事")).toBeVisible();
  await expect(shelfCard(page, "虎牢关记")).toBeVisible();
  // 面板收走：留着那颗按钮，第二下就是把同一批再导一遍
  await expect(page.getByRole("button", { name: /确认导入/ })).toHaveCount(0);
});
