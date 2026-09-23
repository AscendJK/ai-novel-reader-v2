import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { stubBackend, idleTtsStatus } from "../fixtures/backend";
import { sel, expectUnblocked } from "../pages/app";
import { addProvider, openSettings, settings, signIn, signOut } from "../pages/settings";
import { importFiles, miniNovel, shelfCard, txtFile } from "../pages/shelf";

/**
 * D 组：设置与 API Key。守两条铁律——
 *   ① key 只存浏览器 IndexedDB，永不出本机（CLAUDE.md「API key 仅存浏览器」）；
 *   ② 配置按用户名分键存放，切用户不许串。
 * D9~D11 是同一屏往下两块的接线判据（存储管理 / 备份导出）：那两块都握着"删东西"和
 * "把东西写进文件"的出口，静态加载过不等于出口接对。
 *
 * 这一组一律**走真登录/真退出 UI**，不用 localStorage 预置会话：退出是
 * `window.confirm` + `location.reload()`（Header.tsx:44-49），而 init script 会在刷新后
 * 把会话重新种回去——那样"退出"这条路根本没测到。顺带也不再有"离线态起步"的别扭。
 */

const FAKE_KEY = "sk-e2e-dummy-不是真钥匙";
const USER_A = "e2e-keystore-a";
const USER_B = "e2e-keystore-b";

/** 直接查浏览器真 IndexedDB，而不是查应用自己的 store——store 会跟着代码一起错。 */
async function readSharedSetting<T>(page: Page, key: string): Promise<T | undefined> {
  const raw: unknown = await page.evaluate(async (k) => {
    return await new Promise<unknown>((resolve) => {
      const openReq = indexedDB.open("ai-novel-reader-shared");
      openReq.onsuccess = () => {
        const db = openReq.result;
        const getReq = db.transaction("settings", "readonly").objectStore("settings").get(k);
        getReq.onsuccess = () => resolve((getReq.result as { value?: unknown } | undefined)?.value);
        getReq.onerror = () => resolve(undefined);
      };
      openReq.onerror = () => resolve(undefined);
    });
  }, key);
  return raw as T | undefined;
}

async function localStorageDump(page: Page): Promise<string> {
  return page.evaluate(() => Object.entries(localStorage).map(([k, v]) => `${k}=${v}`).join("\n"));
}

test.beforeEach(async ({ page }) => {
  // D 组每条都要在开头做一次"真 boot + 从 IndexedDB 读回书架 + 登录"，这一步的耗时随并发
  // **线性恶化**：本机 `--workers=1` 单条 2.7 秒，`--workers=10` 下 D8 直接顶穿 30 秒的
  // 用例天花板（报出来是 `Test timeout of 30000ms exceeded`，红的地方在登录遮罩那一步，
  // 与判据无关）。同族先例是 D3（`6ab8e3d` 抬到 60 秒）。
  // 只抬**这一档文件**的用例天花板，全局 `expect.timeout` 仍是 5 秒（见 playwright.config.ts:27），
  // 所以"遮罩真的盖住按钮"这类缺陷照样在原预算内红——判别力靠变异复核，不靠这个 60 秒。
  test.setTimeout(60_000);
  await stubBackend(page, {
    ...idleTtsStatus,
    // 登录会真发一次注册（A1 实测），不桩住就卡在遮罩上
    "POST /api/sync/register": { body: { isNew: false, clientId: "e2e-client", token: "e2e-token", activeCount: 1, data: null } },
  });
  await signIn(page, USER_A);
});

test("D1 保存服务商：key 落在 IndexedDB，一个字节都不进 localStorage", async ({ page }) => {
  await openSettings(page);
  await addProvider(page, { name: "e2e 假商", key: FAKE_KEY, baseUrl: "http://e2e-llm.invalid/v1", model: "test-model" });

  // 名字同时出现在"当前使用的 API"选择器和配置卡片里，所以取第一个
  await expect(page.getByText("e2e 假商").first()).toBeVisible();

  const stored = await readSharedSetting<{ apiKey?: string; name?: string }[]>(page, `api-providers:${USER_A}`);
  expect(Array.isArray(stored), "配置应存成数组放在 sharedDB.settings").toBe(true);
  expect(stored?.[0]).toMatchObject({ name: "e2e 假商", apiKey: FAKE_KEY });

  const dump = await localStorageDump(page);
  expect(dump, "localStorage 里出现 key 就等于会被同步与备份带走").not.toContain(FAKE_KEY);
  expect(dump).not.toContain("sk-");
});

test("D2 key 还没填：保存按钮是禁用的（填上才放开）", async ({ page }) => {
  await openSettings(page);
  const s = settings(page);
  await s.add.click();
  await s.name.fill("只有名字没有 key");

  await expect(s.save).toBeDisabled();
  await s.key.fill(FAKE_KEY);
  await expect(s.save).toBeEnabled();
});

test("D3 换一个用户名：服务商列表跟着换，不许串到别人账号下", async ({ page }) => {
  // 单跑 6~8 秒，6 worker 混跑 20~22 秒，全套并跑历史上偶发 30 秒+。
  // 2026-09-23 把打满的那一档拆开逐步计时（`--repeat-each=12 --workers=6`，32.0/32.1/33.7 秒），
  // 结论是这二十几秒**全在重启应用**：signIn 五发各 4~7 秒（冷启那一发 13.4 秒）、signOut 两发
  // 各 3~4.5 秒，七次 boot 占掉几乎全程；而 openSettings ≤1.4 秒、三处断言 ≤0.2 秒，
  // 离全局 5 秒 expect 预算很远——所以没有任何一步值得单独抬预算（signIn/signOut 本来就各自
  // 带 20 秒，见 `pages/settings.ts:27,34`；B7 的纪律也在这儿成立：只抬量出来紧的那一步）。
  // 2026-09-22 在真后端台架上量过归因：换用户整趟 427ms、一次开机只发 4 个 /api 请求且
  // **与书架规模无关**（1 本与 8 本同样 4 发，见 `specs-real/r-boot-cost.spec.ts`）——
  // 所以这里不是产品在慢，是这条判据要跑 5 次 boot、每次 boot 在 dev 下都要拉一遍未打包源码。
  // 天花板按并发的量给，不按单跑给。
  test.setTimeout(60_000);
  await openSettings(page);
  await addProvider(page, { name: "A 专用配置", key: FAKE_KEY });
  await expect(page.getByText("A 专用配置").first()).toBeVisible();

  await signOut(page);
  await signIn(page, USER_B);
  await openSettings(page);
  await expect(settings(page).emptyList).toBeVisible();
  await expect(page.getByText("A 专用配置")).toHaveCount(0);

  await signOut(page);
  await signIn(page, USER_A);
  await openSettings(page);
  await expect(page.getByText("A 专用配置").first()).toBeVisible();
});

test("D4 删除本地用户：它的 IndexedDB 用户库真的被删掉", async ({ page }) => {
  await openSettings(page);
  await addProvider(page, { name: "待随用户删除", key: FAKE_KEY });
  await signOut(page);

  await sel.usernameSelect(page).selectOption({ value: USER_A });
  // 删除也要接 confirm（UsernameLogin.tsx:119），否则默认 dismiss = 用户点了取消
  page.once("dialog", (d) => d.accept());
  await page.getByTitle("删除用户").click();
  await expect(sel.usernameSelect(page).locator(`option[value="${USER_A}"]`)).toHaveCount(0);

  // deleteDatabase 要等在途事务让路，是异步的，所以轮询而不是读一次
  await expect
    .poll(
      async () =>
        page.evaluate(async (user) => {
          const dbs = await indexedDB.databases();
          return dbs.some((d) => d.name === `ai-novel-reader-${user}`);
        }, USER_A),
      { timeout: 8_000 },
    )
    .toBe(false);
});

test("D5 离线开关：切到手动离线之后，书架照样点得到", async ({ page }) => {
  const online = page.getByTitle("在线 - 点击切换到离线模式");
  await expectUnblocked(online);
  await online.click();

  await expect(page.getByText("手动离线")).toBeVisible();
  // 这条真正的判据：离线不是"锁住界面"
  await expectUnblocked(sel.folderImportButton(page));
});

test("D7 展开用户名菜单之后，「退出登录」必须还点得动", async ({ page }) => {
  await page.getByTitle(USER_A, { exact: true }).click();

  // 缺陷②：菜单那层 `div.fixed.inset-0.z-40`（Header.tsx:157）会盖住没有 z-index 的
  // 退出按钮，真实鼠标点下去只关菜单。判据用命中测试，不用 toBeVisible——
  // 被盖住的元素在 Playwright 眼里照样"可见"。
  const logoutButton = page.getByTitle("退出登录");
  await expectUnblocked(logoutButton);

  page.once("dialog", (d) => d.accept());
  await logoutButton.click();
  await expect(sel.loginGate(page)).toBeVisible();
});

test("D6 只填裸 IP：探到 HTTPS 在跑就定 :8443，两边都不通退回 :5173", async ({ page }) => {
  await signOut(page);

  let httpsUp = true;
  const backend = await stubBackend(page, {
    ...idleTtsStatus,
    "GET /api/sync/check-user/test": () =>
      httpsUp ? { status: 404, headers: { "Access-Control-Allow-Origin": "*" } } : { abort: true },
  });

  await page.getByRole("button", { name: "配置" }).click();
  await page.getByPlaceholder("192.168.1.100").fill("192.168.1.5");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("https://192.168.1.5:8443")).toBeVisible();

  // 反过来：HTTPS 探不通必须落到 http://…:5173，而不是停在"无法连接"就完事
  httpsUp = false;
  await page.getByRole("button", { name: "更改" }).click();
  await page.getByPlaceholder("192.168.1.100").fill("192.168.1.6");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("http://192.168.1.6:5173")).toBeVisible();

  const probed = backend.seen().filter((s) => s.path === "/api/sync/check-user/test").length;
  expect(probed, "裸 IP 要先探 HTTPS，不通再探 HTTP").toBeGreaterThanOrEqual(3);
});

test("D8 改用户名：API 配置跟着搬到新名字下，旧名的键不许留在共享库里", async ({ page }) => {
  // 走到"改名"这条路要三个条件同时成立（useSyncOrchestration.ts:501-517）：登录成功
  // + 服务器侧数得出书 + 本地也有书。所以这本试验书要真导入，落进 A 的 IndexedDB 库。
  const backend = await stubBackend(page, {
    ...idleTtsStatus,
    "POST /api/sync/register": { body: { isNew: false, clientId: "e2e-client", token: "e2e-token", activeCount: 1, data: null } },
    "* /api/novels": { body: [{ id: "srv-1", title: "服务器上的那本书" }] },
    "/api/sync/**": { body: { ok: true } },
  });

  await importFiles(page, [txtFile("改名试验.txt", miniNovel())]);
  await expect(shelfCard(page, "改名试验")).toBeVisible();
  await openSettings(page);
  await addProvider(page, { name: "跟着改名的配置", key: FAKE_KEY });

  await signOut(page);
  // 两次 prompt：先答"3 - 改名"，再填新用户名
  const answers = ["3", USER_B];
  page.on("dialog", async (d) => {
    if (d.type() !== "prompt") return await d.accept();
    const a = answers.shift();
    if (a === undefined) return await d.dismiss();
    await d.accept(a);
  });
  await signIn(page, USER_A);
  expect(backend.seen().some((s) => s.path === "/api/novels"), "前提：登录时真去数过服务器侧的书").toBe(true);
  expect(answers, "两次 prompt 都该被答掉；剩下没答的说明根本没走到改名的分支").toEqual([]);

  await openSettings(page);
  await expect(page.getByText("跟着改名的配置").first()).toBeVisible();
  expect(await readSharedSetting<{ name: string }[]>(page, `api-providers:${USER_B}`)).toMatchObject([
    { name: "跟着改名的配置" },
  ]);
  expect(await readSharedSetting(page, `api-providers:${USER_A}`), "旧名的键留下就是永远取不回来的残留").toBeUndefined();
});

/**
 * 存储管理面板里某一类的那一行（label → 所在行）。
 *
 * 走 DOM 关系而不是给产品加 data-testid：这一组要验的就是"界面上写着可清理的那一行，
 * 出口到底接没接上"，加了测试专用属性就等于把定位方式与产品实现解耦开，红了也说不清
 * 是接线断了还是属性没渲染。`text()[1]` 取第一个文本节点：分类行是 `label + <span>字节数</span>`，
 * 而"已下载的嵌入模型"那一节的标题以"已下载的"开头，不会误命中。
 */
function storageRow(page: Page, label: string) {
  return page.locator(
    `xpath=//p[normalize-space(text()[1])="${label}"]/ancestor::div[contains(@class,"justify-between")][1]`
  );
}

test("D9 存储管理：写着「可清理」的每一行都必须真有出口，点了不许毫无反应", async ({ page }) => {
  await openSettings(page);
  const clean = storageRow(page, "嵌入模型").getByRole("button", { name: "清理" });
  // 前提：storage-stats 把 embedding-models 标成 cleanable，面板必然渲染出这枚按钮。
  // 这枚按钮本身有没有效才是这条判据要问的。
  await expect(clean, "分类明细里「嵌入模型」这一行的清理按钮").toBeVisible();

  const asked: string[] = [];
  page.on("dialog", async (d) => {
    asked.push(d.message());
    await d.dismiss();
  });
  await clean.click();
  // 用 poll 而不是 waitForTimeout：真没弹窗时它红在 5 秒预算内，报的是"点了没反应"
  await expect
    .poll(() => asked.length, { message: "点了「嵌入模型」的清理：既没弹确认，也没任何反馈" })
    .toBe(1);
  expect(asked[0], "弹的必须是这一类自己的确认文案（错接到别类=删错东西）").toContain("嵌入模型");
});

test("D10 存储管理：确认框点取消不许谎报「清理完成」，点确认要有落点且按钮要放开", async ({ page }) => {
  await openSettings(page);
  const clean = storageRow(page, "TTS 语音模型").getByRole("button", { name: "清理" });
  await expect(clean).toBeEnabled();

  let accept = false;
  const asked: string[] = [];
  page.on("dialog", async (d) => {
    asked.push(d.message());
    await (accept ? d.accept() : d.dismiss());
  });

  await clean.click();
  expect(asked[0], "取消之前得让用户看见后果：删了要重新下载").toContain("重新下载");
  await expect(page.getByText("清理完成"), "用户点的是取消，界面不许报完成").toHaveCount(0);

  accept = true;
  await clean.click();
  await expect(page.getByText("清理完成")).toBeVisible();
  // busyAction 复位：finally 没跑的话这枚按钮（和这一屏所有清理按钮）会永久禁用
  await expect(clean).toBeEnabled();
});

test("D11 备份：真浏览器里导出 JSON，正文要带得上去、钥匙一个字节都不许带上", async ({ page }) => {
  // 这一条不走桩：备份读的是浏览器真 IndexedDB，单测里那层是 fake-indexeddb。
  // 备份文件会被用户拿去分享/换机器，钥匙一旦在里面，D1 守的"key 永不出本机"就白立了。
  await importFiles(page, [txtFile("备份里的书.txt", miniNovel())]);
  await expect(shelfCard(page, "备份里的书")).toBeVisible();
  await openSettings(page);
  await addProvider(page, { name: "备份里的配置", key: FAKE_KEY });

  // 前提：钥匙真已落进浏览器存储。少了这一步，下面的"不含"可能只是没写进去的空场。
  const stored = await readSharedSetting<{ apiKey?: string }[]>(page, `api-providers:${USER_A}`);
  expect(stored?.[0]?.apiKey, "前提：钥匙已在 sharedDB.settings 里").toBe(FAKE_KEY);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "导出 JSON" }).click(),
  ]);
  expect(download.suggestedFilename()).toContain("小说阅读器备份");
  const file = await download.path();
  if (!file) throw new Error("下载没落成临时文件，这条判据无从下手");
  const text = await readFile(file, "utf8");

  expect(text).toContain("备份里的书");
  expect(text, "只有书目没有正文的备份，恢复出来是空壳").toContain("洛阳城下的雪");
  expect(text, "备份里出现钥匙=把钥匙交给了拿到文件的人").not.toContain(FAKE_KEY);
  expect(text).not.toMatch(/api-providers/);
});

/** 往浏览器真 Cache Storage 的 transformers-cache 里种条目（嵌入模型缓存就是这只桶） */
async function seedTransformersCache(page: Page, entries: { url: string; bytes: number }[]): Promise<void> {
  await page.evaluate(async (list) => {
    const cache = await caches.open("transformers-cache");
    for (const e of list) {
      await cache.put(e.url, new Response(new Blob([new Uint8Array(e.bytes)])));
    }
  }, entries);
}

async function transformersCacheCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const cache = await caches.open("transformers-cache");
    return (await cache.keys()).length;
  });
}

test("D12 分类明细里每一枚「清理」都要弹自己那一类的确认（不许有死按钮）", async ({ page }) => {
  // D9 只盯嵌入模型那一行；这一条把"清单会不会各写一份然后对不上"变成机器判据：
  // storage-stats 以后再加一类 cleanable，忘了接出口就在这儿红，不用人再去看源码。
  await openSettings(page);
  // 从按钮往上找它所在的那一行（`div.rounded-lg.border` 会连包住整组的外层一起命中，
  // 那样第一"行"里就有三枚按钮，红了也说不清是哪一类没接上）
  const rows = page.locator(
    'xpath=//button[normalize-space(.)="清理"]/ancestor::div[contains(@class,"rounded-lg")][1]'
  );
  const n = await rows.count();
  expect(n, "前提：分类明细里至少有一行带清理出口，一格都没有等于这屏没东西可清").toBeGreaterThan(0);

  const asked: string[] = [];
  page.on("dialog", async (d) => {
    asked.push(d.message());
    await d.dismiss();
  });
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const label = (await row.locator("p").first().innerText()).replace(/[0-9.]+\s*(B|KB|MB|GB)\s*$/i, "").trim();
    asked.length = 0;
    await row.getByRole("button", { name: "清理", exact: true }).click();
    await expect.poll(() => asked.length, { message: `「${label}」这一行的清理按钮点了没反应` }).toBe(1);
    expect(asked[0], `「${label}」弹的必须是它自己的确认文案（错接=删错东西）`).toContain(label);
  }
});

test("D13 清理「嵌入模型」要真把缓存文件删掉，删完那一行的数要落回 0", async ({ page }) => {
  await seedTransformersCache(page, [
    { url: "https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/config.json", bytes: 4096 },
    { url: "https://huggingface.co/Xenova/gte-small/resolve/main/tokenizer.json", bytes: 8192 },
    // 不属于任何已知模型的孤儿条目：逐 key 删的那种实现正是会漏掉它，而这一行的字节数算的是整只桶
    { url: "https://example.invalid/orphan/model/onnx", bytes: 2048 },
  ]);
  expect(await transformersCacheCount(page), "前提：三条都种进去了").toBe(3);

  await openSettings(page);
  const row = storageRow(page, "嵌入模型");
  const bytes = row.locator("span.font-mono");
  await expect(bytes, "前提：这一行报的不是 0 B，否则下面的\"落回 0\"是空场").not.toHaveText("0 B");

  page.on("dialog", (d) => void d.accept());
  await row.getByRole("button", { name: "清理", exact: true }).click();
  await expect(page.getByText("清理完成")).toBeVisible();
  await expect
    .poll(() => transformersCacheCount(page), { message: "点了确认之后 transformers-cache 里还剩条目，没删干净" })
    .toBe(0);
  // 报数与动手同一口径：清完之后界面那格必须跟着归零（runCleanup 里那次 refresh）
  await expect(bytes).toHaveText("0 B");
});
