import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { stubBackend } from "../fixtures/backend";
import { sel, seedSession, openApp } from "../pages/app";

/**
 * 版本不一致弹窗：浏览器层的模态判据。
 *
 * 组件本体在 jsdom 里已经有 20 条判据（src/components/common/__tests__/VersionMismatchDialog.test.tsx），
 * 但 jsdom 不跑原生 Tab 焦点遍历，所以「Tab 打转」「焦点归还」那两格在 jsdom 里是**判不到**的格子，
 * 而 a-smoke 的 A5 只判了「该不该弹出来」。这里补的是弹出来之后的那四格。
 */

const USER = "e2e-modal-user";

function originOf(testInfo: TestInfo): string {
  return new URL(testInfo.project.use.baseURL ?? "http://127.0.0.1:5274").origin;
}

/**
 * 桩一个「后端版本 = 9.9.9」的世界。
 *
 * `delayMs` 让弹窗晚一点挂上来 —— 归还焦点那一格需要一个**真实的元素**在挂载前一瞬拿着焦点，
 * 否则组件记下的"来路"就是 body，判不到东西。
 */
async function mismatchBackend(page: Page, delayMs = 0): Promise<void> {
  await stubBackend(page, {
    "GET /api/version": async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return { body: { version: "9.9.9" } };
    },
  });
}

/** 焦点现在落在哪、还在不在弹窗里 */
function focusInfo(page: Page): () => Promise<{ inside: boolean; label: string }> {
  return () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const dialog = document.querySelector('[role="dialog"]');
      const text = (el?.getAttribute("aria-label") || el?.textContent || "").trim().slice(0, 16);
      return {
        inside: !!el && !!dialog && dialog !== el && dialog.contains(el),
        label: el ? `${el.tagName} ${text}` : "none",
      };
    });
}

async function openWithMismatch(page: Page, testInfo: TestInfo): Promise<void> {
  await mismatchBackend(page);
  await seedSession(page, { username: USER, serverUrl: originOf(testInfo) });
  await openApp(page);
  await expect(sel.versionMismatchDialog(page)).toBeVisible();
}

test.describe("版本不一致弹窗的模态四格（浏览器层）", () => {
  test("M1 挂上来的那一瞬，焦点必须进墙（activeElement 就是那个 role=dialog）", async ({ page }, testInfo) => {
    await openWithMismatch(page, testInfo);
    // 焦点没进墙，键盘用户看到的是"弹窗出现了但 Tab 还从书架开始"
    await expect(page.getByRole("dialog")).toBeFocused();
  });

  test("M2 正着 Tab 六下：一步都不许跑出墙，而且必须在墙内两个可聚焦项之间真的动", async ({ page }, testInfo) => {
    await openWithMismatch(page, testInfo);
    const info = focusInfo(page);
    const labels: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const now = await info();
      expect(now.inside, `第 ${i + 1} 次 Tab 之后焦点跑出了弹窗（落在 ${now.label}）`).toBe(true);
      labels.push(now.label);
    }
    // 只判「还在墙里」会被「Tab 一点都没让焦点动」骗过，所以另一头一起判
    expect(new Set(labels).size, `六步只该在两个可聚焦项之间来回，实到：${labels.join(" | ")}`).toBe(2);
    for (let i = 1; i < labels.length; i++) {
      expect(labels[i], `第 ${i + 1} 步焦点没动（${labels[i]}）`).not.toBe(labels[i - 1]);
    }
  });

  test("M2b 反着 Shift+Tab：从第一项往回要绕到最后一项，不许退回书架", async ({ page }, testInfo) => {
    await openWithMismatch(page, testInfo);
    const info = focusInfo(page);
    await page.keyboard.press("Tab"); // 先进到第一项（GitHub Releases 那条链接）
    const first = await info();
    expect(first.label).toContain("GitHub Releases");
    await page.keyboard.press("Shift+Tab"); // 第一项往回 = 绕到最后一项
    const back1 = await info();
    expect(back1.inside, `Shift+Tab 退出了弹窗（落在 ${back1.label}）`).toBe(true);
    await page.keyboard.press("Shift+Tab");
    const back2 = await info();
    expect(back2.inside, `第二次 Shift+Tab 退出了弹窗（落在 ${back2.label}）`).toBe(true);
    expect(back2.label, "反着走没在两项之间来回").not.toBe(back1.label);
  });

  test("M3 ESC 是第二个出口：按下去弹窗必须消失", async ({ page }, testInfo) => {
    await openWithMismatch(page, testInfo);
    await page.keyboard.press("Escape");
    await expect(sel.versionMismatchDialog(page)).toHaveCount(0);
  });

  test("M4 关掉之后焦点要还给来路那一个（挂载前拿着焦点的是「设置」按钮）", async ({ page }, testInfo) => {
    await mismatchBackend(page, 1500);
    await seedSession(page, { username: USER, serverUrl: originOf(testInfo) });
    await openApp(page);
    // 版本那一发延后 1.5 秒，所以此刻弹窗还没挂上来 —— 焦点得抢在挂载之前放好，
    // 那一个才是组件要还的"来路"。
    await page.evaluate(() => (document.querySelector('[title="设置"]') as HTMLElement | null)?.focus());
    expect(await page.evaluate(() => document.activeElement?.getAttribute("title")), "前置没立住：来路那个按钮没拿到焦点").toBe("设置");

    await expect(sel.versionMismatchDialog(page)).toBeVisible();
    // 这里刻意用「点按钮」关，不用 ESC —— ESC 那一格由 M3 单独判，
    // 两处都靠 ESC 的话摘掉 ESC 分支会同时红两条，归因就糊了。
    await page.getByRole("button", { name: "继续使用" }).click();
    await expect(sel.versionMismatchDialog(page)).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("title")), {
        message: "弹窗卸载后焦点没还回来（键盘用户会被丢回页面开头）",
      })
      .toBe("设置");
  });

  test("M5 「继续使用」点下去也关得掉，且关掉之后书架真的点得到", async ({ page }, testInfo) => {
    await openWithMismatch(page, testInfo);
    await page.getByRole("button", { name: "继续使用" }).click();
    await expect(sel.versionMismatchDialog(page)).toHaveCount(0);
    await expect(sel.emptyShelf(page)).toBeVisible();
  });
});

/**
 * 判别力台账（2026-09-27 本机，真 Chromium，`--workers=2`）。
 * 基线：src/components/common/VersionMismatchDialog.tsx = sha256 99b3b4e0…（4821 B），
 * 每刀之后都 `cp` 回基线并 `cmp` + 核 sha；0 刀对照 6 passed。
 *
 *  K1 删掉 `panelRef.current?.focus()`（0 加 / 1 删）→ 只有 M1 红
 *  K2 删掉正着 Tab 的绕回分支 `else if (!e.shiftKey …) { preventDefault; first.focus() }`（0/3）
 *     → 只有 M2 红，报错原文「第 3 次 Tab 之后焦点跑出了弹窗（落在 BODY …）」
 *  K3 删掉 Shift+Tab 的绕回分支（1/4）→ 只有 M2b 红，落在弹窗外那只编码 SELECT 上
 *  K4 删掉 `if (e.key === "Escape")` 那 4 行 → 只有 M3 红
 *     （M4 刻意改用「点按钮」当卸载触发器：不然 K4 会一次红两条，归因就糊了）
 *  K5 删掉 cleanup 里的 `previous?.focus?.()`（0/1）→ 只有 M4 红
 *  K6 把 `onClick={onClose}` 换成空函数（1/1）→ M5 与 M4 各红一条
 *     （已知耦合：M4 要靠这一次点击把弹窗卸下来，所以点击失效必然连带它）
 *
 * 没有一刀打出 0 红。jsdom 那 20 条判据盯的是组件自己写的逻辑，这 6 条盯的是**浏览器的焦点系统**
 * ——原生 Tab 遍历、真实 activeElement、卸载后归还，都是 jsdom 给不了的格子。
 */
