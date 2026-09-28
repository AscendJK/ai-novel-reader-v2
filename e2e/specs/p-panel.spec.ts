import { test, expect, type Page } from "@playwright/test";
import { stubBackend, idleTtsStatus, type StubTable } from "../fixtures/backend";
import { openApp } from "../pages/app";

/**
 * P 组：调试面板 / 真机自检这一层在浏览器里的样子。
 *
 * 这一组为什么存在（09-28）：面板在 jsdom 里有一档全绿的用例，而真 Chromium 上顶栏那排
 * 按钮**用鼠标点不动**——`fireEvent.click` 直接派发 click，绕开了指针链，而产品的拖拽把手
 * 在 pointerdown 上无条件 `setPointerCapture`，把这一次点击改派给了把手自己
 * （台架读数：`pointerdown→button`、`pointerup→div`、`mouseup→div`、`click→div`；
 * 手指 tap 与键盘 Enter 都能换页）。同一族坑记过一次：判"监听到底接没接上"只能在浏览器层判。
 *
 * 手机才是这一层的真正用法，所以三条都按"制作人手上会发生什么"来写：
 *  P1 鼠标点顶栏按钮要真的换页（手指与键盘已经不是问题，见上面的读数）
 *  P2 探针一挂上，时间线里的每一行都得先带上一枚时刻（不带就没法把两行相减）
 *  P3 页面被停住 12 秒之后，回来必须自己写下"我漏了 12 秒"——这一格在真机上就是
 *     "熄屏那段时间报告里到底说了什么"的那一句实话
 *
 * 浏览器层的刀账（同一把刀先在 jsdom 打过，这里只记打进真页面时的读数）：
 * - Z1 store 摘掉统一贴戳 → P2 红 1（`有行没带时刻：["引擎切换: …","书架页面",…]`）
 * - Z3 `clockStamp` 退回 locale 口径 → P2 红 1，读数是 `[5:43:05 PM] …`；
 *   **这一刀在 jsdom 是红 0 的等价变异**（本机 Node locale 本就是 24 小时制），只有这里咬得住
 * - Z4 摘掉停摆补记那一行 → P3 红 1
 * - Z10 摘掉把手的按钮豁免 → P1 红 1，红在换页那一条（真鼠标点不动，正是台架量到的坏法）
 * - Z11 把手一律豁免 → P1 红 1，红在位移那一条（面板拖不动）
 *
 * 这一格判不了、也不许在这里演：现场行里的「音频秒表」能不能活着走到真导出——
 * 假后端台架没有朗读会话，那一行只会写「当前没有朗读会话」，把秒表桩出来演给判据看是另一种假。
 * 它由真后端那一档的 **R-D4** 判（真出声之后导出的现场行带秒表并前进；09-28 实测读数 2.7s→23.7s，
 * 见 `e2e/specs-real/r-tts.spec.ts`，同一把刀 Z12 打进包里那一跑它红过）。
 */

const USER = "e2e-panel-user";

async function openWithPanel(page: Page, extra: StubTable = {}): Promise<void> {
  await stubBackend(page, {
    ...idleTtsStatus,
    "GET /api/novels": { body: [] },
    "POST /api/sync/register": { body: { isNew: false, clientId: "c", token: "e2e-token", activeCount: 1, data: null } },
    "GET /api/sync/check-user/e2e-panel-user": { status: 404, headers: { "Access-Control-Allow-Origin": "*" } },
    "POST /api/sync/push": { body: { ok: true, watermark: "wm", skipped: { badPayload: 0, total: 0, ids: [] } } },
    "POST /api/sync/heartbeat": { body: { activeCount: 1 } },
    "POST /api/sync/disconnect": { body: { ok: true } },
    ...extra,
  });
  await page.addInitScript((u) => {
    localStorage.setItem("sync-username", u);
    localStorage.setItem("sync-token", "e2e-token");
    // 调试面板的开关（ui-store.ts:19 读字符串 "true"）
    localStorage.setItem("novel-reader-debug", "true");
    // 分享桩：把「导出报告」的正文留在 window 上，后面按行取
    (window as unknown as { __shared: string | null }).__shared = null;
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (d: { text?: string }) => {
        (window as unknown as { __shared: string | null }).__shared = d.text ?? "";
      },
    });
  }, USER);
  await openApp(page);
  await expect(page.getByRole("button", { name: "从文件夹导入" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "真机自检" })).toBeVisible({ timeout: 10_000 });
}

/**
 * 时间线正文：**走导出那一条路**取回，不读面板 DOM。
 *
 * 两个原因。① 探针只在「真机自检」这一页挂着（`DebugPanel.tsx:91-98` 的 effect 跟着 tab 走），
 * 切到「日志」页去读行会把探针先卸掉，停摆那一行就永远等不到；② 制作人真机上拿到的就是这份
 * 文本，判"有没有时刻"判的应该就是它。`navigator.share` 在页面里换成一个记录入参的桩，
 * 于是点「导出报告」等于把文本原样交给我们。
 */
async function exportTimeline(page: Page): Promise<string[]> {
  await page.getByRole("button", { name: "导出报告" }).click();
  const text = await page.evaluate(() => (window as unknown as { __shared: string }).__shared ?? "");
  const body = text.split("【最近事件时间线】\n")[1] ?? "";
  return body.split("\n").filter(Boolean);
}

test("P1 顶栏那排按钮：鼠标点要真的换页（手指与键盘不是问题，鼠标曾经不是）", async ({ page }) => {
  test.setTimeout(60_000);
  await openWithPanel(page);

  await expect(page.getByRole("button", { name: "日志" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "真机自检" }).click();
  await expect(page.getByRole("button", { name: "真机自检" })).toHaveAttribute("aria-pressed", "true", {
    timeout: 5_000,
  });

  // 反向：换回日志也要靠鼠标成立（两头的值都取样，单边写死成"永远在自检页"当场也是绿的）
  await page.getByRole("button", { name: "日志" }).click();
  await expect(page.getByRole("button", { name: "日志" })).toHaveAttribute("aria-pressed", "true");

  // 拖还得能拖：把手空白处按下并移动，面板位置要跟着走
  const handle = page.locator("[data-debug-handle]");
  const box = (await handle.boundingBox())!;
  const before = (await page.locator("[data-debug-panel]").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 60, { steps: 6 });
  await page.mouse.up();
  const after = (await page.locator("[data-debug-panel]").boundingBox())!;
  expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y), "把手改成不捕获指针之后，面板拖不动了").toBeGreaterThan(40);
});

test("P2 探针一挂上，导出里每一行都得带时刻（两行相减才是熄屏那段的时长）", async ({ page }) => {
  test.setTimeout(60_000);
  await openWithPanel(page);
  await page.getByRole("button", { name: "真机自检" }).click();
  await expect.poll(() => exportTimeline(page).then((r) => r.length), { timeout: 10_000 })
    .toBeGreaterThan(0);

  const rows = await exportTimeline(page);
  const bare = rows.filter((l) => !/^\[\d{2}:\d{2}:\d{2}/.test(l));
  expect(bare.length, `有行没带时刻：${JSON.stringify(bare)}`).toBe(0);
  // 12 小时制在这一格里是致命的：相邻两行相减会凭空多出 43200 秒（09-28 台架就是这么撞的）
  expect(rows.some((l) => /上午|下午|\bAM\b|\bPM\b/i.test(l.slice(0, 12))), `时刻里混进了 12 小时制的字样：${JSON.stringify(rows.slice(0, 3))}`).toBe(false);
});

test("P3 页面被停住 12 秒，回来必须自己写下「我漏了 12 秒」", async ({ page }) => {
  test.setTimeout(90_000);
  await openWithPanel(page);
  await page.getByRole("button", { name: "真机自检" }).click();
  await expect.poll(() => exportTimeline(page).then((r) => r.length), { timeout: 10_000 }).toBeGreaterThan(0);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Debugger.enable");
  // 停主线程但不点页面——`Debugger.pause` 是台架量出来真能让 setInterval 停摆的那一种
  //（`Page.setWebLifecycleState:"frozen"` 在这台 Chromium 上对活动页面不生效，实测零漏拍）
  await cdp.send("Debugger.pause");
  await new Promise((r) => setTimeout(r, 12_000));
  await cdp.send("Debugger.resume");
  await cdp.send("Debugger.disable");

  await expect
    .poll(() => exportTimeline(page).then((rows) => rows.filter((l) => l.includes("停摆")).at(-1) ?? ""), { timeout: 15_000 })
    .toMatch(/停摆\s*1[1-9](\.\d)?\s*秒/);
});
