import { test, expect, type Page } from "@playwright/test";
import { stubBackend, idleTtsStatus } from "../fixtures/backend";
import { sel, expectUnblocked } from "../pages/app";
import { addProvider, openSettings, settings, signIn, signOut } from "../pages/settings";
import { importFiles, miniNovel, shelfCard, txtFile } from "../pages/shelf";

/**
 * D 组：设置与 API Key。守两条铁律——
 *   ① key 只存浏览器 IndexedDB，永不出本机（CLAUDE.md「API key 仅存浏览器」）；
 *   ② 配置按用户名分键存放，切用户不许串。
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
  test.setTimeout(60_000); // 同 B7/B8：两次退出+登录在混跑全套时要 30 秒以上，单跑 7.5 秒
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
