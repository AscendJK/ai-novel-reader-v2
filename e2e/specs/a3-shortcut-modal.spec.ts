import { test, expect, type Page, type Locator, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { stubBackend } from "../fixtures/backend";
import { sel, seedSession, openApp, expectBlocked } from "../pages/app";

/**
 * 快捷键说明面板：浏览器层的模态判据（与 `a2-version-modal.spec.ts` 同一档）。
 *
 * 组件本体在 jsdom 里已经有 18 条判据（`src/components/common/__tests__/shortcut-help.test.tsx`），
 * 但有三格 jsdom 给不了：
 * - **原生 Tab 遍历**：jsdom 收到 `keydown` 不会自己移动焦点，所以"整段 focus-trap 摘掉"在那里
 *   量不出来（这一点是实测踩到的：摘掉之后那条"连按八下不出面板"照样绿）。这里靠真 Chromium 动焦点。
 * - **遮罩盖不盖得住**：`fixed inset-0 z-50` 是不是真把底下的"设置"按钮挡住了，那是命中测试的事实。
 * - **可访问名是谁算的**：jsdom 那一档读的是属性字符串，这里读 Chrome 的 accessibility tree
 *   （`aria-labelledby` 指向那只 h3，名字要真算出来）。
 *
 * **ESC 这一格故意不在这里判**：`AppLayout.tsx:76` 那条全局 `Escape` 绑定与面板自己那支是同职双闸，
 * 单摘面板那一支这条判据仍然绿（等价变异）。ESC 归 jsdom 的 5.5 判——那边只挂面板自己，没有第二条路。
 */

/** package.json 那一份号，与前端常量同源（a-smoke.spec.ts:13 同一口径）。 */
const APP_VERSION: string = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;

const USER = "e2e-help-modal-user";

function originOf(testInfo: TestInfo): string {
  return new URL(testInfo.project.use.baseURL ?? "http://127.0.0.1:5274").origin;
}

/** 只按角色找：**名字那一格由 B5 单独判**，别的全用这一只，免得摘掉 labelledby 时四条一起红。 */
const panel = (page: Page): Locator => page.getByRole("dialog");

/** 焦点现在落在哪、还在不在面板里。 */
function focusInfo(page: Page): () => Promise<{ inside: boolean; label: string }> {
  return () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const dialog = document.querySelector('[role="dialog"]');
      const text = (el?.getAttribute("aria-label") || el?.textContent || "").trim().slice(0, 20);
      return {
        inside: !!el && !!dialog && dialog.contains(el),
        label: el ? `${el.tagName} ${text}` : "none",
      };
    });
}

/**
 * 落进书架的世界：后端版本与前端一致（不弹版本墙），面板由 **键盘** 打开。
 * 用键盘而不是点击，是为了让"打开之前谁拿着焦点"这一格能被显式安排（见 B4）。
 */
async function openHelp(page: Page, testInfo: TestInfo): Promise<void> {
  await stubBackend(page, {
    "GET /api/version": () => ({ body: { version: APP_VERSION } }),
  });
  await seedSession(page, { username: USER, serverUrl: originOf(testInfo) });
  await openApp(page);
  await expect(sel.emptyShelf(page)).toBeVisible();
  // Shift + / 才是 e.key === "?" 且 shiftKey 为真（直接 press("?") 在 Chromium 里 shiftKey 是假的）
  await page.keyboard.press("Shift+Slash");
  await expect(panel(page)).toBeVisible();
}

test.describe("快捷键说明面板的浏览器层四格", () => {
  test("B1 打开的那一下，焦点必须进墙（activeElement 就是那只 dialog）", async ({ page }, testInfo) => {
    await openHelp(page, testInfo);
    await expect(panel(page)).toBeFocused();
  });

  test("B2 正着 Tab 六下：一步都不许跑出墙（墙里只有一枚可聚焦，所以它必须一直停在那枚按钮上）", async ({ page }, testInfo) => {
    await openHelp(page, testInfo);
    const info = focusInfo(page);
    const labels: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const now = await info();
      expect(now.inside, `第 ${i + 1} 次 Tab 之后焦点跑出了面板（落在 ${now.label}）`).toBe(true);
      labels.push(now.label);
    }
    // 与 a2 的 M2 相反：那一档墙里有两个可聚焦项，要判"焦点真的在两行之间动"；
    // 这一档墙里只有关闭按钮一枚，可聚焦项集合 = 1，所以这一格判的是**一步都不许多走**。
    expect(new Set(labels).size, `面板里只该有一枚可聚焦元素，实到：${labels.join(" | ")}`).toBe(1);
    expect(labels[0], "焦点没停在那枚可访问名为「关闭快捷键说明」的按钮上").toContain("关闭快捷键说明");
  });

  test("B3 遮罩真的拦人：面板开着的时候，底下那枚「设置」按钮点不到", async ({ page }, testInfo) => {
    await openHelp(page, testInfo);
    // 只判 visible 会被遮罩骗过（底下的按钮照样可见、照样有几何尺寸），所以要判命中测试
    await expectBlocked(sel.settingsButton(page));
  });

  test("B4 关掉之后焦点还给来路那一个（来路是按快捷键之前拿着焦点的「设置」按钮）", async ({ page }, testInfo) => {
    await stubBackend(page, { "GET /api/version": () => ({ body: { version: APP_VERSION } }) });
    await seedSession(page, { username: USER, serverUrl: originOf(testInfo) });
    await openApp(page);
    await expect(sel.emptyShelf(page)).toBeVisible();
    await page.evaluate(() => (document.querySelector('[title="设置"]') as HTMLElement | null)?.focus());
    expect(await page.evaluate(() => document.activeElement?.getAttribute("title")),
      "前置没立住：按快捷键之前「设置」按钮没拿到焦点").toBe("设置");

    await page.keyboard.press("Shift+Slash");
    await expect(panel(page)).toBeVisible();
    // 刻意用点击关掉：ESC 那一格在 jsdom 判（真应用里它是同职双闸，摘掉面板那一支这里也不会红）
    await page.getByRole("button", { name: "关闭快捷键说明" }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("title")), {
        message: "面板卸载后焦点没还给来路（键盘用户会被丢回页面开头）",
      })
      .toBe("设置");
  });

  test("B5 Chrome 算得出来的角色与名字：dialog 叫「键盘快捷键」，里面那枚按钮叫「关闭快捷键说明」", async ({ page }, testInfo) => {
    await openHelp(page, testInfo);
    // 名字挂在 aria-labelledby → 那只 h3 上；这里要的是**真实可访问树**里的名字，不是属性字符串
    await expect(page.getByRole("dialog", { name: "键盘快捷键" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "键盘快捷键" }).getByRole("button", { name: "关闭快捷键说明" })).toBeVisible();
    // 打开一层说明不该再多一只 dialog（版本墙那种同层重复会读成"墙套墙"）
    await expect(page.getByRole("dialog")).toHaveCount(1);
    // 键帽是真 kbd：读屏念"这是按键"靠它
    await expect(page.getByRole("dialog").locator("kbd")).toHaveCount(9);
  });
});

/**
 * 判别力台账（2026-09-27 本机，真 Chromium，`--project=chromium --workers=2`）。
 * 基线：`src/components/common/ShortcutHelp.tsx` = sha256 `b4384333…`（4452 字节）＝jsdom 那一档
 * 改完之后、并且已经提交的那一份。每刀之后 `cp` 回基线 + `cmp` + 重核 sha；0 刀对照 **5 passed**。
 *
 *  X1 删掉 `panelRef.current?.focus()` → 只有 B1 红（:64）
 *  X2 把 `Array.from(panel.querySelectorAll(FOCUSABLE))` 换成空数组（整段 trap 死）→ 只有 B2 红（:69）
 *     ★这一格是 jsdom 给不了的：同一把刀打在 jsdom 那 18 条上红的是 5.4a/5.4b（"焦点掉到墙外要拉回来"），
 *     而"原生 Tab 会不会自己把人带出墙"只有真浏览器会动焦点。两道各判一半，缺一不可。
 *  X3 摘掉遮罩的 `fixed inset-0 z-50` → 只有 B3 红（:85，底下那枚「设置」又点得到了）
 *  X4 删掉 cleanup 里的 `previous?.focus?.()` → 只有 B4 红（:91）
 *  X5 删掉 `aria-labelledby={TITLE_ID}` → 只有 B5 红（:112，Chrome 算出来的 dialog 名字变空）
 * **没有一刀打出 0 红**，每条各咬一个行号。
 *
 * 一处刻意不判：**ESC**。`AppLayout.tsx:76` 那条全局 `Escape` 绑定与面板自己那一支是同职双闸——
 * 单摘面板那一支，这五条仍然全绿（等价变异），所以浏览器层不写 ESC 判据；那一格归 jsdom 的 5.5
 * （那边只挂面板，没有第二条路）。同理 `tabIndex={-1}` 与"焦点进墙"是相邻两格，jsdom 的 M5 已单独
 * 咬过（摘掉它红 5.3＋5.6），这一档不重复下刀。
 *
 * 顺带记一笔过程账：第一次跑构建产物那一档（`--project=build`）红在 `dist/ 比源码旧` 的守卫上——
 * 这轮反复 `cp` 还原产品文件把 mtime 推到了产物之前，不是产品问题；`npm run build` 之后 5 条全绿。
 */
