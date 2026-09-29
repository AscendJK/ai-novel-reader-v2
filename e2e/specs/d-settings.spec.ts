import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { stubBackend, idleTtsStatus } from "../fixtures/backend";
import { sel, expectUnblocked } from "../pages/app";
import { addProvider, leaveSettings, openSettings, settings, signIn, signOut } from "../pages/settings";
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

/**
 * D6 裸 IP 的连接方式（制作人 09-29 深夜把口径翻成「选什么连什么，默认 http」）。
 *
 * 这一档**推翻**的是我先前那句假话——旧测试钉的是"先探 HTTPS，不通再探 HTTP，两条都活着就定 8443"，
 * 而那套行为的依据是"Pages 上那条 HTTP 腿永远被混合内容拦掉"；09-29 深夜在真 Chrome 里量过
 * `https://ascendjk.github.io` 探 `http://192.168.1.10:5173` **能拿到 200**，那条依据不成立，
 * 加上白撞一发 8443 实测要吃 2 秒（局域网机器没开 8443 是常态），所以整条自动改试另一腿的行为删掉了。
 * 桩把**两条腿都装成活**的：旧口径在这里会定到 `:8443`，新口径必须停在用户选的那一条、另一条一次都不发。
 */
test("D6 只填裸 IP：选哪条连哪条，默认 HTTP，另一条一次都不许背头发", async ({ page }) => {
  await signOut(page);

  const backend = await stubBackend(page, {
    ...idleTtsStatus,
    "GET /api/sync/check-user/test": { status: 404, headers: { "Access-Control-Allow-Origin": "*" } },
  });
  const probes = () => backend.seen().filter((s) => s.path === "/api/sync/check-user/test").map((s) => s.origin);

  await page.getByRole("button", { name: "配置" }).click();
  await page.getByPlaceholder("192.168.1.100").fill("192.168.1.5");
  await page.getByRole("button", { name: "保存" }).click();

  // 默认那一枚是 HTTP：存下来的就是 5173，而且没有第二发
  await expect(page.getByText("http://192.168.1.5:5173")).toBeVisible();
  expect(probes(), "选了 HTTP 就不该有人替用户去连 8443").toEqual(["http://192.168.1.5:5173"]);

  // 已存过地址的人打开面板时框里就带着协议：这两枚必须真的能动它（09-29 第一版把它们做成 disabled，
  // 对老用户等于没有这个选项——就是这一格当场抓出来的）
  await page.getByRole("button", { name: "更改" }).click();
  const address = page.getByPlaceholder("192.168.1.100");
  const httpBtn = page.getByRole("radio", { name: "HTTP :5173" });
  const httpsBtn = page.getByRole("radio", { name: "HTTPS :8443" });
  await expect(address).toHaveValue("http://192.168.1.5:5173");
  await expect(httpBtn).toBeEnabled();

  await httpsBtn.click();
  await expect(address, "点 HTTPS 要把地址开头的协议与默认端口一起改掉").toHaveValue("https://192.168.1.5:8443");
  // 换完当场就按新那条重探（面板里那行结果跟着走），不发第二腿
  await expect(page.getByText("连接成功！")).toBeVisible();
  expect(probes(), "点 HTTPS 之后当场重探的必须是 8443 那一发").toEqual([
    "http://192.168.1.5:5173",
    "https://192.168.1.5:8443",
  ]);

  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("https://192.168.1.5:8443")).toBeVisible();
  expect(
    probes().filter((o) => o.startsWith("http://")),
    "已经换到 HTTPS 了还补一腿 http 就是没改干净"
  ).toEqual(["http://192.168.1.5:5173"]);

  // 自己写过的端口保留，只有那一头的默认端口跟着换
  await page.getByRole("button", { name: "更改" }).click();
  await address.fill("http://192.168.1.7:9000");
  await httpsBtn.click();
  await expect(address, "9000 是用户自己写的，不该被换成 8443").toHaveValue("https://192.168.1.7:9000");
  await page.getByRole("button", { name: "跳过" }).click();

  // 地址里只写 IP（没写协议）→ 仍然按按钮选的那条走
  await page.getByRole("button", { name: "更改" }).click();
  await page.getByRole("radio", { name: "HTTP :5173" }).click();
  await address.fill("192.168.1.6");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("http://192.168.1.6:5173")).toBeVisible();

  // 清单**摊开着**的那一路：框是空的、最近地址有货 → 一聚焦就摊开。
  // 这条钉的是"摊开的清单不许挡掉连接方式那两枚"——旧版是 absolute 浮层，正好盖在上面，点不动。
  await page.getByRole("button", { name: "更改" }).click();
  await address.fill("");
  await address.blur();
  await address.click();
  await expect(page.getByText("http://192.168.1.5:5173")).toBeVisible();
  await httpsBtn.click();
  await expect(httpsBtn, "清单摊开着也要点得动那两枚").toBeChecked();
  await page.getByText("http://192.168.1.5:5173").click();
  await expect(address).toHaveValue("http://192.168.1.5:5173");
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
  // 分类明细是异步统计出来的（storage-stats 要把 IndexedDB 扫完才报数）：**一次性读 count
  // 会在统计还没完时拿到 0**，单跑永远量不到、整档并跑就假红（2026-09-26 实测：单跑 3/3 绿，
  // 全量第三跑到这条红在前提上）。所以这条前提要等，不许抢。
  await expect
    .poll(() => rows.count(), {
      timeout: 20_000,
      message: "前提：分类明细里至少有一行带清理出口，一格都没有等于这屏没东西可清",
    })
    .toBeGreaterThan(0);
  const n = await rows.count();

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

test("D14 清理 TTS 残留：回执要报数，不许被一句「清理完成」盖掉", async ({ page }) => {
  // 全新浏览器上下文里 tts-cache 是空的 → 孤儿数 0，产品该说的是它自己那句
  // "没有发现残留文件"。用户点这枚按钮要的答案就是"清了几个"，通用文案盖掉它
  // 等于这个功能只做了一半（StorageManager 里两处 setMessage 并存的形状）。
  await openSettings(page);
  page.on("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "清理残留" }).click();
  await expect(page.getByText("没有发现残留文件")).toBeVisible();
  await expect(page.getByText("清理完成"), "带信息的回执不许被通用文案覆盖").toHaveCount(0);
});

test("D15 导入别人给的备份：里面的 API 配置不许进浏览器，而且界面要说明白", async ({ page }) => {
  // D11 钉的是"导出侧不带钥匙"，这一条钉另一头：备份会被拿去分享、换机器，
  // 一份带 api-providers 的文件如果能原样灌进来，这台机器之后所有 AI 请求的
  // 去向就由给文件的那个人说了算。"不许静默"这半句只有界面层能证。
  const backup = {
    // 按"真导出"的样子造：`loadAllNovelMeta` 走的是 `db.novels.orderBy("createdAt")`，
    // 缺 createdAt 的记录会被 IndexedDB 索引游标直接跳过——第一版样本没带这个字段，
    // 于是红在"书架看不见"，那是我样本假，不是产品坏（D11 里那句"正文要带得上去"
    // 之所以稳，就是因为它是从真库里导出来再灌回去的）。
    novels: [{
      id: "bk-1", title: "外来备份里的书", author: "某人", fileName: "外来备份里的书.txt",
      fileFormat: "txt", totalChars: 24, chapterCount: 1, createdAt: Date.now(), updatedAt: Date.now(),
    }],
    chapters: [{ id: "bk-1-c1", novelId: "bk-1", index: 0, title: "第一章", content: "洛阳城下的雪落了三天，街面上没有一个卖炭的人。" }],
    settings: [
      { key: `api-providers:${USER_A}`, value: [{ name: "外来服务商", apiKey: "sk-外来钥匙", baseUrl: "https://attacker.invalid/v1" }] },
    ],
  };
  await openSettings(page);
  await page.locator("#import-backup").setInputFiles({
    name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup), "utf8"),
  });

  await expect(page.getByText("导入成功").first()).toBeVisible();
  await expect(page.getByText(/已忽略 1 条 API 配置/)).toBeVisible();
  expect(await readSharedSetting(page, `api-providers:${USER_A}`), "钥匙进了浏览器=这台机器的请求去向被改走").toBeUndefined();
  // 主数据不许被连坐：书要真回到书架上（离开设置会重挂 BookSelect → 重读库）。
  // 判"看得见"而不是"在库里"：用户唯一能感知的就是前者。
  await leaveSettings(page);
  await expect(shelfCard(page, "外来备份里的书")).toBeVisible();
});

/**
 * 一次进架 n 本小书。书名带两位序号，方便在「单本导出」那只下拉里数条数、认最后一条。
 */
function shelfOf(n: number): { name: string; mimeType: string; buffer: Buffer }[] {
  return Array.from({ length: n }, (_, i) => txtFile(`下拉书${String(i).padStart(2, "0")}.txt`, miniNovel()));
}

/**
 * 把目标元素"底边贴近视口底"：往上找第一个真的会滚的祖先，按差值抬它的 scrollTop。
 * 返回贴完之后元素底边距视口底还剩多少像素——测试拿它当**前提**断言，
 * 不然"滚没滚到"这件事一旦没成立，后面所有几何判据都变成空判。
 *
 * 为什么要手动滚：设置屏不是整页滚，而是 `AppLayout.tsx:259` 那只
 * `<div class="h-full overflow-auto">`（外面还套着 `overflow-hidden` 的 main）。
 * 下拉列表正是被这一层裁的，所以这一档判的是"贴到容器底开列表会怎样"。
 */
async function stickToBottom(page: Page, selector: string, keepBottom = 56): Promise<number> {
  await page.locator(selector).evaluate((el, keep) => {
    const rect = el.getBoundingClientRect();
    const delta = rect.bottom - (window.innerHeight - keep);
    let node: HTMLElement | null = el.parentElement;
    while (node) {
      const s = getComputedStyle(node);
      if (/auto|scroll/.test(s.overflowY)) {
        node.scrollTop += delta;
        return;
      }
      node = node.parentElement;
    }
  }, keepBottom);
  const box = await page.locator(selector).boundingBox();
  const vh = page.viewportSize()?.height ?? 0;
  return box ? vh - box.y - box.height : vh;
}

test("D16 设置屏滚到底再开下拉：列表不许跑到屏幕外，最后一项要真点得着", async ({ page }) => {
  // `ui/select` 这只组件在浏览器层此前一条判据都没有（B16 打的是原生 <select>）。
  // 它替全应用做的两个决定——列表走 Portal、默认 position="popper"——真后果只有
  // 真浏览器量得到：列表会不会被设置页那只 overflow-auto 容器裁掉、贴底时会不会翻向。
  await importFiles(page, shelfOf(4));
  // 等导入真落地再进设置：`ExportPanel.tsx:16` 是挂载时读一次库（`useEffect(..., [])`），
  // 导入还在飞就进设置的话，这一屏拿到的是空列表，「单本导出」整块都不出现。
  // 25 秒：一本书要走解析 + 同步重试，实测 4 本在满并发下超默认 5 秒预算（停在「正在批量导入…」）——
  // 抬的只有这一步的等待，几何判据仍在原预算内。
  await expect(shelfCard(page, "下拉书03")).toBeVisible({ timeout: 25_000 });
  await openSettings(page);

  const gap = await stickToBottom(page, "#export-novel");
  expect(gap, "前提：触发器得贴着视口底，不然这一条量不到「贴底往哪儿开」").toBeLessThan(140);

  await page.locator("#export-novel").click();
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  const box = await list.boundingBox();
  const vh = page.viewportSize()?.height ?? 0;
  expect(box, "列表得量得到几何尺寸").not.toBeNull();
  expect(box!.y, "列表不许顶出屏幕上沿").toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `列表掉到屏幕外了（贴底时 popper 该翻到上方）：底边 ${box!.y + box!.height} > 视口 ${vh}`)
    .toBeLessThanOrEqual(vh + 1);

  const last = page.getByRole("option").last();
  await expect(last).toHaveText(/下拉书\d\d/);
  // 最后一项：看得见（几何）之外还要点得着（命中测试）——被容器裁掉的元素照样有几何尺寸
  await expectUnblocked(last);
});

test("D17 下拉选项超过一屏时：最后一条要滚得见、也选得中", async ({ page }) => {
  // 判两件事：① Viewport 那套尺寸类没把列表压成不可滚（`h-[var(--radix-select-trigger-height)]`
  //    就挂在那儿，只有真浏览器量得出它到底裁掉多少）；② 选中值在浏览器层真能回显到触发器上。
  // 用服务商那只下拉凑长列表：一本书要走解析 + 同步重试（实测 4 本就超 5 秒），
  // 一个服务商只写 IndexedDB。
  await openSettings(page);
  for (let i = 0; i < 13; i++) {
    await addProvider(page, { name: `服务商${String(i).padStart(2, "0")}`, key: `sk-e2e-${i}` });
  }
  const trigger = page.locator("#active-provider");
  await expect(trigger, "有一条带 key 的配置就该出现「当前使用的 API」那张卡").toBeVisible();

  await trigger.click();
  const options = page.getByRole("option");
  await expect(options, "13 条服务商就该有 13 个选项").toHaveCount(13);
  const last = options.last();
  await last.scrollIntoViewIfNeeded();
  const box = await last.boundingBox();
  const vh = page.viewportSize()?.height ?? 0;
  expect(box, "最后一项得量得到几何尺寸").not.toBeNull();
  const over = Math.round(box!.y + box!.height - vh);
  // ratio:1 = 整条都在窗口里。默认那档（ratio 0）只要有一像素露出来就算过，
  // 而"被屏幕下沿切掉一截"恰恰是这一条要抓的症状——用默认档它会绿。
  await expect(last, `最后一项整条都要在窗口内（实测底边超出视口 ${over}px）`).toBeInViewport({ ratio: 1 });
  await expectUnblocked(last);

  await page.keyboard.press("End");
  // End 之后必须**先看到**高亮落在最后一项，才许按回车。Radix 把这个聚焦动作排在
  // `setTimeout(() => focusFirst(...))` 里（`@radix-ui/react-select@2.2.6` dist 里那句
  // `setTimeout`），两次 `keyboard.press` 之间不隔一个往返回程时，回车可能还打在
  // 原先高亮的第一项上 —— 这条 2026-09-25 实测六次三红三绿，红的都是最后一句回显。
  await expect(last, "End 没把高亮挪到最后一项，回车就选不到它").toHaveAttribute("data-highlighted", "");
  await page.keyboard.press("Enter");
  await expect(trigger, "选中之后的回显只可能来自 ItemText").toContainText("服务商12");
});

