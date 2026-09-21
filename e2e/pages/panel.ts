import type { Locator, Page } from "@playwright/test";

/**
 * 桌面端 AI 分析面板的定位符。
 *
 * 必须限定在 `[data-sidebar="summary-panel"]` 里：同一棵 SummaryPanel 被挂了**两遍**
 * （`ReadingPanel.tsx:124` 桌面侧栏 + `:147-155` 移动端整屏，后者只是 `display:none`），
 * 不限定域的话任何 `getByText` 都会命中 2 个元素、直接 strict mode violation。
 */
function inPanel(page: Page): Locator {
  return page.locator('[data-sidebar="summary-panel"]');
}

/** 移动端那份面板只在 `mobileAiOpen` 为真时挂载（ReadingPanel.tsx:147），默认只有一份。
 *  但两栏并排时桌面侧栏里也会渲染出章节面板，所以判据一律带域。 */
export const panel = {
  root: (page: Page): Locator => inPanel(page),
  text: (page: Page, part: string | RegExp): Locator => inPanel(page).getByText(part),
  button: (page: Page, name: string | RegExp): Locator => inPanel(page).getByRole("button", { name }),
  tab: (page: Page, name: string): Locator => inPanel(page).getByRole("tab", { name: new RegExp(name) }),
};
