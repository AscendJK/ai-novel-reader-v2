import { test, expect, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { stubBackend, idleTtsStatus } from "../fixtures/backend";
import { sel, seedSession, openApp, expectUnblocked, expectBlocked, watchConsole } from "../pages/app";

/**
 * A 组：冒烟。跑不通就说明整套 E2E 的地基是坏的，所以它也是 CI 的唯一入口。
 *
 * 这里的每条判据都要求"把对应的东西改坏，这条会红"，逐条变异记录见提交信息。
 */

// 与 vite define 的 __APP_VERSION__ 同源（vite.config.ts:10-12 读的就是这个文件）
const APP_VERSION: string = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;

const USER = "e2e-smoke-user";

function originOf(testInfo: TestInfo): string {
  return new URL(testInfo.project.use.baseURL ?? "http://127.0.0.1:5274").origin;
}

test.describe("A 组冒烟", () => {
  test("A1 遮罩挡着时书架点不到；离线登录成功后遮罩必须从 DOM 摘掉", async ({ page }) => {
    let registered: { username?: string; mode?: string } | null = null;
    const backend = await stubBackend(page, {
      "POST /api/sync/register": (req) => {
        registered = JSON.parse(req.postData() ?? "{}");
        return { body: { isNew: true, clientId: "e2e-client", token: "e2e-token", activeCount: 1, data: null } };
      },
    });
    await openApp(page);

    await expect(sel.loginGate(page)).toBeVisible();
    // 遮罩挡着的时候，书架不是"不存在"而是"存在但点不到"——两头都要断言
    await expect(sel.emptyShelf(page)).toBeVisible();
    await expectBlocked(sel.folderImportButton(page));

    await sel.usernameSelect(page).selectOption({ value: "__new__" });
    await sel.newUsername(page).fill(USER);
    await sel.loginSubmit(page).click();

    // 判据是"遮罩这个节点从 DOM 上摘掉"，不是"书架可见"（可见性不看遮挡）
    await expect(sel.loginGate(page)).toHaveCount(0);
    await expectUnblocked(sel.folderImportButton(page));

    // 实测口径：没配 server-url 时前端把当前源当后端（api-client.ts:63-72 同源回退），
    // 所以"创建并进入"确实会发一次注册。谁把它改成"静默本地登录"，这里必须红。
    expect(backend.count("POST", "/api/sync/register"), "登录要向服务器注册一次").toBe(1);
    expect(registered, "注册要带上用户输入的用户名").toMatchObject({ username: USER });
    // 开机路径还会打这五只（靠 backend.unmatched() 量出来的，逐条补桩留给 B/E 组）：
    //   GET /api/sync/check-user/<user>、GET /api/novels、POST /api/sync/push、
    //   GET /api/rag/model-proxy/.../tokenizer.json 与 tokenizer_config.json
    // 不在这里断言 unmatched()：要求每条用例桩满全世界，最后只会被人把断言删掉。
  });

  test("A2 空书架首帧：空态文案在、导入入口真的点得到", async ({ page }) => {
    await seedSession(page, { username: USER });
    await openApp(page);

    await expect(sel.loginGate(page)).toHaveCount(0);
    await expect(sel.emptyShelf(page)).toBeVisible();
    await expectUnblocked(sel.folderImportButton(page));
  });

  test("A3 走完开机路径不留 console 错误", async ({ page }) => {
    const errors = watchConsole(page);
    await stubBackend(page, idleTtsStatus);
    await seedSession(page, { username: USER });
    await openApp(page);
    await expectUnblocked(sel.folderImportButton(page));
    await sel.settingsButton(page).click();
    await expect(sel.settingsScreen(page)).toBeVisible();

    expect(errors(), `开机路径上有报错: ${JSON.stringify(errors())}`).toEqual([]);
  });

  test("A4 设置页来回三次：不残留遮罩、不把书架变成点不到", async ({ page }) => {
    await seedSession(page, { username: USER });
    await openApp(page);

    for (let i = 0; i < 3; i++) {
      await sel.settingsButton(page).click();
      await expect(sel.settingsScreen(page)).toBeVisible();
      await page.getByRole("button", { name: "返回" }).click();
      await expect(sel.settingsScreen(page)).toHaveCount(0);
      await expectUnblocked(sel.folderImportButton(page));
    }
    await expect(sel.loginGate(page)).toHaveCount(0);
  });

  test("A5 前后端版本一致不弹；不一致要弹出具体两个版本号", async ({ page }, testInfo) => {
    let serverVersion = APP_VERSION;
    const backend = await stubBackend(page, {
      "GET /api/version": () => ({ body: { version: serverVersion } }),
    });
    // 版本检测有两个前置条件（AppLayout.tsx:190-193）：已登录 + 配过服务器地址。
    // 少给 server-url 的话这条用例会"因为根本没查"而假绿。
    await seedSession(page, { username: USER, serverUrl: originOf(testInfo) });

    await openApp(page);
    await expect(sel.loginGate(page)).toHaveCount(0);
    await expect(sel.versionMismatchDialog(page)).toHaveCount(0);
    expect(backend.count("GET", "/api/version"), "配了服务器地址就该真的去查一次版本").toBeGreaterThan(0);

    serverVersion = "9.9.9";
    await openApp(page);
    await expect(sel.versionMismatchDialog(page)).toBeVisible();
    await expect(page.getByText("9.9.9").first()).toBeVisible();
  });
});
