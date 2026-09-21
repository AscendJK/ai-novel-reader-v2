import type { Locator, Page } from "@playwright/test";

/**
 * AI 分析面板的定位符，按"哪一份面板"分域。
 *
 * 必须限定容器：同一棵 SummaryPanel 被挂了两遍（`ReadingPanel.tsx:124` 桌面侧栏
 * `[data-sidebar="summary-panel"]` + `:150` 移动端整屏 `[data-mobile-ai-panel]`，
 * 后者为了"任务在跑不中断"常驻挂载，靠 `display:none` 藏着）。不限定域的话任何
 * `getByText` 都会命中 2 个元素、直接 strict mode violation。
 */
export const DESKTOP_PANEL = '[data-sidebar="summary-panel"]';
export const MOBILE_PANEL = '[data-mobile-ai-panel]';

export function panelIn(rootSelector: string) {
  const root = (page: Page): Locator => page.locator(rootSelector);
  return {
    root,
    text: (page: Page, part: string | RegExp): Locator => root(page).getByText(part),
    button: (page: Page, name: string | RegExp): Locator => root(page).getByRole("button", { name }),
    tab: (page: Page, name: string): Locator => root(page).getByRole("tab", { name: new RegExp(name) }),
  };
}

export const panel = panelIn(DESKTOP_PANEL);
export const mobilePanel = panelIn(MOBILE_PANEL);
