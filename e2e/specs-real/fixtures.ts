import { expect, type Page } from "@playwright/test";
import { sel } from "../pages/app";
import { CHAPTER_TITLES } from "../pages/shelf";

/**
 * 真后端那一档共用的三只工具。放在 specs-real 里而不是 `e2e/pages/`：
 * 主套（`pages/*.ts`）的世界里后端是 `page.route` 桩、不注册 SW、也没有真 token，
 * 这几只的判据全都建立在"没有桩"之上，混在一起会互相污染假设。
 */

export const ORIGIN = process.env.ANR_REAL_ORIGIN ?? "http://127.0.0.1:5399";
/** 一次性数据目录（包外），RAG/TTS 那两组要按它量落盘。preflight 已经强制它存在且不在仓库里。 */
export const DATA_DIR = process.env.ANR_REAL_DATA_DIR ?? "";

/**
 * 每次跑用一对新名字，而不是清库重开：
 *  - "点界面**创建**的用户真进了服务端的库"这类判据，名字要是上一轮就存在，
 *    `handleLogin` 走 join 分支也能过，判据就悄悄降级成了"服务端认得这个人"；
 *  - 上一轮中途挂掉留下的半成品书会让 `shelfCard` 撞上两只同名卡片，
 *    报出来是"strict mode violation"，看着像产品缺陷其实是台架脏。
 * 一次性目录整个会在收尾删掉，所以这里只累积、不回收。要复现某一轮就显式设 `ANR_REAL_RUN`。
 */
export const RUN = process.env.ANR_REAL_RUN ?? String(Date.now()).slice(-6);

/** RAG 检索要在正文里认出它（R-C3 拿它当"检索真回到了这一章"的证据） */
export const SENTINEL = "青龙寺的石阶一共三百七十二级，守碑的老僧每天用帚扫三遍，扫到第三年把石缝扫出了一道浅槽。";

/**
 * 三章真样本。章节标题必须用 `shelf.ts` 里那三只：`navChapter`/`chapterSection` 的定位锚点
 * 与它同源。自己另起一批（我一开始写的"第三章 归程"）不会报"找不到"，只会**一声不响地
 * 等到超时**——这一档每条的天花板是 15 分钟，一次拼错就烧掉一刻钟。
 * 每章正文还得长过 50 字，否则被 `chapter-detector.ts:110` 并进上一章。
 */
export function realNovel(): string {
  return [
    `${CHAPTER_TITLES[0]}\n洛阳城下的雪落了三天，街面上没有一个卖炭的人。守城的兵卒围着火盆打盹，铁甲上结了一层薄霜，谁也不肯先开口说话。`,
    `${CHAPTER_TITLES[1]}\n${SENTINEL}山下渡口那条船等了半月，船家说从没人见崖上有人下来过，只有笛声每天按时响一次。`,
    `${CHAPTER_TITLES[2]}\n虎牢关的鼓声一夜未停，守将把盔缨系了两遍又松开。探马第三次回报说敌军尚在三十里外，帐中无人敢信，也没人敢不信。`,
  ].join("\n\n");
}

/**
 * 直接问服务端（带真 token），不用界面那套 fetch。
 *
 * token 走 `Authorization: Bearer`（`server/middleware/auth.js:13-19`），值由 `sync-client`
 * 存在 `localStorage["sync-token"]`。读它是为了"绕开界面问服务端"，不是重新造一份会话——
 * 造出来的就是另一个用户，判据就废了。
 */
export async function api<T>(page: Page, url: string): Promise<T> {
  const token = await page.evaluate(() => localStorage.getItem("sync-token"));
  const r = await page.request.get(`${ORIGIN}${url}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  expect(r.status(), `GET ${url} 不该是 ${r.status()}`).toBe(200);
  return (await r.json()) as T;
}

/**
 * 等"这一版真被 SW 接管且拿到跨源隔离"。
 *
 * COI 只在**已被 SW 控制的页面发生的那次导航**上生效，所以首访拿不到，产品会自己刷一次
 * （`main.tsx` 的 `ensureCrossOriginIsolated`）。轮询谓词必须容得下页面自刷——
 * `evaluate` 撞上导航会抛，那正是我们要等的过程，不是失败。
 */
export async function waitIsolated(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return await page.evaluate(async () => {
            const reg = await navigator.serviceWorker.ready;
            return { ctrl: !!reg.active, coi: window.crossOriginIsolated };
          });
        } catch {
          return { ctrl: false, coi: false };
        }
      },
      { timeout: 60_000, message: "SW 没接管，或接管之后仍拿不到隔离" },
    )
    .toEqual({ ctrl: true, coi: true });
}

/**
 * 每条用例自己登录一次。
 *
 * 为什么不能靠上一条用例的登录态：Playwright 的 `page`/`context` 是**每条用例新建**的，
 * localStorage 与 IndexedDB 都是干净的 —— 表现是拿到一个没登录的界面（登录遮罩还挂着，
 * 底下书架是空的），而 `setInputFiles` 不受遮罩阻挡，于是导入"看起来发了"、卡片却永远不来。
 * 换 context 不是坏事：这一档本来就要看"空浏览器从真服务端能拉回什么"。
 *
 * 先等隔离再填表：首启那一刷落在开机后约 1.8 秒，等它过去再动手，登录这步才是确定的。
 * 对话框一律 accept —— `handleLogin` 里那两只 confirm（踢掉其他设备 / 覆盖本地数据）默认被
 * Playwright 当成"取消"，症状是点了进入什么也没发生。
 */
export async function signIn(page: Page, baseURL: string, username: string): Promise<void> {
  page.on("dialog", (d) => d.accept());
  await page.goto(baseURL);
  await waitIsolated(page);
  if (!(await sel.loginGate(page).isVisible().catch(() => false))) return;
  await page.selectOption("#user-select", "__new__");
  await page.fill("#new-username", username);
  await page.getByTestId("login-submit").click();
  await expect(sel.loginGate(page)).toHaveCount(0, { timeout: 30_000 });
}
