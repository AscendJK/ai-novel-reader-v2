import { expect, type Locator, type Page } from "@playwright/test";

/**
 * 定位符集中在这里。产品文案改字时只有这一处要跟着改，用例不该各自抄一份中文。
 *
 * 为什么必须集中：应用没有 URL 路由（App.tsx:7-13 只挂 AppLayout，切页是
 * AppLayout.tsx:39-45 的三个 state），到不了深链，每条用例都是点按钮点进去的。
 */
export const sel = {
  loginGate: (page: Page): Locator => page.getByTestId("login-gate"),
  usernameSelect: (page: Page): Locator => page.locator("#user-select"),
  newUsername: (page: Page): Locator => page.locator("#new-username"),
  loginSubmit: (page: Page): Locator => page.getByTestId("login-submit"),
  settingsButton: (page: Page): Locator => page.getByTitle("设置"),
  notesButton: (page: Page): Locator => page.getByTitle("全部笔记"),
  /** 空书架文案（BookSelect 首帧）——A2 判的就是这句话本身，所以留在这里 */
  emptyShelf: (page: Page): Locator => page.getByText("书架上还没有书，上传第一本小说吧"),
  folderImportButton: (page: Page): Locator => page.getByRole("button", { name: "从文件夹导入" }),
  settingsScreen: (page: Page): Locator => page.getByText("关于浏览器直连与代理"),
  versionMismatchDialog: (page: Page): Locator => page.getByRole("heading", { name: "前后端版本不一致" }),
};

/**
 * 预置会话：直接落到书架，绕开"每条用例都要点一遍登录"。
 *
 * `sync-username` 决定 `syncReady` 初值（AppLayout.tsx:41）和用哪个 IndexedDB 库
 * （database.ts:174-192）；`novel-reader-offline-mode="true"` 让心跳不启动，
 * 于是纯逻辑用例不需要任何同步桩。布尔值的判据是字符串 "true"（storage.ts:34-40）。
 */
export async function seedSession(
  page: Page,
  opts: { username?: string; serverUrl?: string; offline?: boolean } = {},
): Promise<void> {
  const { username = "e2e-user", serverUrl = "", offline = true } = opts;
  await page.addInitScript(
    ({ username, serverUrl, offline }) => {
      localStorage.setItem("sync-username", username);
      if (serverUrl) localStorage.setItem("server-url", serverUrl);
      if (offline) localStorage.setItem("novel-reader-offline-mode", "true");
    },
    { username, serverUrl, offline },
  );
}

export async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  // "整页空白"绝不能算通过。桩吃掉源码模块、或异常被 ErrorBoundary 兜住，都会让
  // 后面所有"某元素不存在"的断言假绿——实测过一次白屏仍然绿了两条用例。
  await expect(page.locator("#root")).not.toBeEmpty();
}

/**
 * "这个元素现在真的点得到"——比 toBeVisible() 强一档。
 *
 * 实测换来的：登录遮罩挂着的时候，底下书架元素照样 visible、照样有真实几何尺寸，
 * 所以 `expect(书架).toBeVisible()` 会在"根本没登录"的状态下假绿。
 */
async function hitState(locator: Locator): Promise<string> {
  return locator.evaluate((el) => {
    // 遮挡之外还有第二类假绿：按钮在原地、也能命中，但被 disabled 了
    if ((el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true") {
      return "disabled";
    }
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (top === el || el.contains(top)) return "self";
    return top ? `covered:${top.tagName}.${(top.className || "").toString().slice(0, 40)}` : "covered:none";
  });
}

export async function expectUnblocked(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect(async () => {
    expect(await hitState(locator)).toBe("self");
  }).toPass({ timeout: 3_000 });
}

/** 反向判据：元素在，但被别的东西盖着。用来钉"遮罩确实拦人"。 */
export async function expectBlocked(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const state = await hitState(locator);
  expect(state, `期望被遮挡，实际命中元素本身`).toMatch(/^covered:/);
}

/** 收集 console 错误与页面未捕获异常；返回值在每条用例末尾调用一次当作断言。 */
export function watchConsole(page: Page): () => string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return () => errors.slice();
}
