import { expect, type Locator, type Page } from "@playwright/test";
import { openApp, sel } from "./app";

/**
 * 设置页（API 服务商那一屏）的定位符与动作。
 *
 * 放在 pages/ 而不是各 spec 里：D 组管"配置存到哪"，C 组管"配置驱动出去的请求长什么样"，
 * 两边点的是同一批控件——抄两份的话产品改一次文案要记两处。
 */
export const settings = (page: Page) => ({
  add: page.getByRole("button", { name: "添加 API" }),
  save: page.getByRole("button", { name: "保存" }),
  name: page.locator("#api-name"),
  key: page.locator("#api-key"),
  baseUrl: page.locator("#api-baseurl"),
  model: page.locator("#api-model"),
  emptyList: page.getByText("暂无 API 配置，点击上方按钮添加"),
});

export async function signIn(page: Page, username: string): Promise<void> {
  await openApp(page);
  await sel.usernameSelect(page).selectOption({ value: "__new__" });
  await sel.newUsername(page).fill(username);
  await sel.loginSubmit(page).click();
  // 20 秒：满并发的"重 boot + 拉书架"实测要走十几秒（B7 量过），这条判据要红在
  // "永远进不去"上，而不是红在"这台机器此刻很忙"
  await expect(sel.loginGate(page)).toHaveCount(0, { timeout: 20_000 });
}

export async function signOut(page: Page): Promise<void> {
  // 不接 dialog 的话 Playwright 默认 dismiss，等于用户点了"取消"，根本退不出去
  page.once("dialog", (d) => d.accept());
  await page.getByTitle("退出登录").click();
  await expect(sel.loginGate(page)).toBeVisible({ timeout: 20_000 });
}

export async function openSettings(page: Page): Promise<void> {
  await sel.settingsButton(page).click();
  await expect(page.getByRole("heading", { name: "API 设置" })).toBeVisible();
}

/** 离开设置屏。用的是它自己顶部的「返回」——阅读器里那枚"书架"按钮在设置屏上并不存在。 */
export async function leaveSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "返回" }).click();
  await expect(page.getByRole("heading", { name: "API 设置" })).toHaveCount(0);
}

/** 走完"添加 API → 填表 → 保存"。不填的字段留产品默认（格式默认 OpenAI，流式默认开）。 */
export async function addProvider(
  page: Page,
  f: { name: string; key?: string; baseUrl?: string; model?: string },
): Promise<void> {
  const s = settings(page);
  await s.add.click();
  await s.name.fill(f.name);
  if (f.key !== undefined) await s.key.fill(f.key);
  if (f.baseUrl !== undefined) await s.baseUrl.fill(f.baseUrl);
  if (f.model !== undefined) await s.model.fill(f.model);
  await s.save.click();
}

/** 打开阅读器右侧的 AI 分析面板（`ReadingPanel.tsx:93-106`，只有 md 以上宽度有这枚按钮） */
export function summaryPanelToggle(page: Page): Locator {
  return page.getByLabel("展开 AI 分析面板");
}

export async function openSummaryPanel(page: Page): Promise<void> {
  await summaryPanelToggle(page).click();
  // 面板里第一枚收起按钮，同时也就等到了 Suspense 后面的真组件
  await expect(page.getByLabel("收起 AI 分析面板")).toBeVisible();
}
