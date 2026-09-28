import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { sel } from "../pages/app";
import { CHAPTER_TITLES } from "../pages/shelf";
import { probeRequest, type VendorSpec } from "./vendors";

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
 * 对话框仍然一律 accept —— `handleLogin` 里那两只 confirm（踢掉其他设备 / 覆盖本地数据）默认被
 * Playwright 当成"取消"，症状是点了进入什么也没发生。
 *
 * 但 **accept 之前要把弹层说的话留下来**：登录失败走的是 `window.alert("登录失败：…")`
 * （`src/hooks/useSyncOrchestration.ts:589`），accept 掉之后界面还停在登录页，判据只看得到
 * "登录闸还在"，红的形状跟"卡住了"一模一样。2026-09-27 就是这么绕了一圈：用户名超 30 字符被
 * 服务端 400（`server/routes/sync.js:31`），而报出来的是一句 30 秒超时。
 */
export async function signIn(page: Page, baseURL: string, username: string): Promise<void> {
  const said: string[] = [];
  page.on("dialog", (d) => {
    said.push(d.message().replace(/\s+/g, " ").slice(0, 160));
    void d.accept();
  });
  await page.goto(baseURL);
  await waitIsolated(page);
  if (!(await sel.loginGate(page).isVisible().catch(() => false))) return;
  await page.selectOption("#user-select", "__new__");
  await page.fill("#new-username", username);
  await page.getByTestId("login-submit").click();
  const gone = await sel.loginGate(page).waitFor({ state: "detached", timeout: 30_000 }).then(() => true).catch(() => false);
  if (gone) return;
  const onScreen = await sel.loginGate(page).innerText().catch(() => "（读不到界面文字）");
  expect(
    false,
    `登录 30 秒没过去。用户名 "${username}"（${username.length} 字符，服务端只收 2-30）。` +
      `弹层说过：${said.length ? said.join(" ｜ ") : "（一次都没弹）"}。还挂着的界面：${onScreen.replace(/\s+/g, " ").slice(0, 200)}`,
  ).toBe(true);
}

/**
 * 一次性租户名，**保证落在服务端那 2-30 字符的窗口里**。
 *
 * 为什么不直接拼 `r组${标签}-${RUN}`：厂商 id 最长 24 字符（`vendors.ts` 的 `ID`），加上本轮的戳就超
 * 30 —— 超了不是"名字被截短"而是登录整个红掉（400 走 alert，见 `signIn`）。装不下时留标签前 12 字符，
 * 尾巴换成"标签+戳"的 8 位摘要：既进窗口，又仍是一轮一个（同戳不会跟别的厂商撞车）。
 */
export function benchUsername(label: string, run: string): string {
  const full = `r组${label}-${run}`;
  if (full.length <= 30) return full;
  const digest = createHash("sha1").update(`${label}-${run}`).digest("hex").slice(0, 8);
  return `r组${label.slice(0, 12)}-${digest}`;
}

/** 预探走的是哪条腿：node 直连厂商，还是经后端代理转发（= 产品真正用的那条） */
export type Leg = "direct" | "proxy";
export type Reach = { reachable: true; via: Leg } | { reachable: false; skip: boolean; why: string };

/**
 * 厂商可达性预探（**在 node 侧发，不进浏览器**）。
 *
 * 这一档的判据全建立"外部厂商活着"之上，而它今天确实会飘：同一本合成长书跑两次，
 * 发出去的请求数就从 1 变 2（重试）。网络层挂了让判据红，报出来像"产品坏了"，
 * 而实际是外网不通 / 厂商 5xx。所以分类：
 *  - **连不出去（DNS/拒绝/超时）与 5xx → 先换代理腿再探一次，两条腿都不通才 `skip`**（见下面那段
 *    "为什么要第二条腿"）；
 *  - **429 单独一档：先等一再探，等不到就 `skip`**。它是"这一分钟不让你测"，既不是产品坏了
 *    也不是厂商不在——拿它让整组红，报出来的是一屋子假红（2026-09-23 实测：sensenova 按分钟
 *    限流，八条判据连着跑第二条就 `RateLimitExceeded.EndpointTPMExceeded`）。
 *  - **其余 4xx 不跳过**：key 失效、路径写错正是要让它红——R-E4 那条尤其依赖
 *    厂商真回 401（它判的是"厂商 401 不许说成本机会话失效"）。
 * 只探可达性，不探内容：内容对不对仍由各条判据自己说。
 * 请求形状（端点、头、body）不在这里写死，一律走 `probeRequest`——两家协议的差别就在头那三行。
 *
 * ## 为什么要第二条腿（2026-09-28，制作人拍 A）
 *
 * 预探原来只有一条 node 直连腿，而它**比自己要护着的那些判据更严**：这一档真判的三条
 * （R-E1 走代理、R-E2 直连+代理、R-E4 直连+代理）都受后端那 3 分钟超时兜着（`server/routes/proxy.js`
 * 的 `AbortSignal.timeout(180000)`），预探却自己在 30 秒就 `abort`。厂商回得慢 ≠ 厂商不在，
 * 于是"慢"被读成"不在"、整组静悄悄跳过。当天实测两个读数都对上了：
 *  - 411：预探 `AbortError This operation was aborted` → #38 被跳过；
 *  - LongCat：同一把直连探针跳过了 #30/#31，而它自己的 #39（走代理腿的那条）当场就过了。
 *
 * 第二条腿**不是另一张网**：后端就跑在同一台机器（`127.0.0.1:5399`），换的其实是
 * "产品那条腿的超时与重试形状"，而且它正是 R-E1 判的那条路——所以这一腿通了就足以让判据自己
 * 去说"厂商回得好不好"，不该由预探替它做决定。
 *
 * ## 2026-09-28 验收读数（四个分支各量了一次）
 *
 * 前三次一次真厂商请求都没发出去（要么 DNS 不通，要么是本地 scratch 假厂商）；第四次是制作人
 * 批过的剂量：一发 64 token 的 ping + 一次注定的 401。
 *
 *  - **两条腿都不通 → 跳过并把两句原因并起来**：清单换成一只 `https://does-not-exist-anr.invalid`
 *    的假厂商（仓库外的 scratch 清单），跑 `r-vendor.spec.ts` 整档 → `3 skipped`，
 *    `why` = `连不出去：TypeError fetch failed，且后端没能把这一发送达厂商（HTTP 500：{"error":"代理请求失败"}）`；
 *  - **直连腿 abort → 代理腿救回来**：一次性 scratch（跑完已删）起一只本地 4 秒才答的假厂商，
 *    给直连腿 1 秒上限 → `{reachable:true, via:"proxy"}`，控制台那句
 *    `直连腿：连不出去：AbortError This operation was aborted → 代理腿通了，不跳过`；
 *  - **对照组（直连腿预算够就不该多走一条腿）**：同一只厂商给 20 秒 → `{reachable:true, via:"direct"}`；
 *  - **真厂商**：`--grep "错 key · 411"` 一条 → `ok`（8.7s），这一回直连腿自己就通了，
 *    所以代理腿在真厂商上**只量到了"没被触发"**；小计那句是 `[预探小计] 这一跑没有被厂商预探跳过的判据。`
 *
 * 收尾小计的两个分支同样各量了一次（上面第一条是"有跳过"，真厂商那条是"没有跳过"）。
 * `BATCH_JUDGES` 与两个 `judges:` 数组里的名字是**手写**的：对不上时从 `list` 报的 skipped
 * 标题能看出来多了哪一条。
 */
export async function vendorReach(
  vendor: VendorSpec,
  key: string,
  opts: {
    timeoutMs?: number;
    /** 代理腿再探的超时（默认 90 秒：直连腿那 30 秒正是这次翻车的原因，别再拿它当上限） */
    proxyTimeoutMs?: number;
    /**
     * 撞上 429 时最多再探几次、每次等多久。
     *
     * 默认 5 次 × 120 秒（最多等 8 分钟）。第一版给的是 3 × 60，实测不够：上一轮刚跑完 12 分钟
     * 真厂商，配额窗口还热着，预探等满 2 分钟就放弃 → **整组 8 条一条都没测**（Playwright 还回
     * exit 0，看着像"跑过了"）。这一档每一跑都花钱，宁可多等几分钟也别空跑。
     */
    triesOn429?: number; waitOn429Ms?: number;
  } = {},
): Promise<Reach> {
  const tries = opts.triesOn429 ?? 5;
  const wait = opts.waitOn429Ms ?? 120_000;
  let directWhy = "预探一次都没跑成（不该到这里）";
  for (let attempt = 1; attempt <= tries; attempt++) {
    const r = await oneProbe(vendor, key, opts.timeoutMs);
    if (r.reachable) return { reachable: true, via: "direct" };
    directWhy = r.why;
    // 厂商答了 4xx：直连腿明明是通的，换腿只会拿到同一个 4xx，而这正是要红的东西
    if (!r.skip) return r;
    if (r.status !== 429) break;
    if (attempt === tries) {
      // 429 不换腿：厂商已经答话了，换一条腿去打只会拿到同一个 429（两条腿在同一台机器上）
      return { reachable: false, skip: true, why: `${r.why}（直连腿等满 ${tries} 次，每次 ${wait / 1000} 秒）` };
    }
    console.log(`[厂商预探] ${vendor.label} 429 限流，等 ${wait / 1000} 秒后再探（第 ${attempt}/${tries} 次）`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  const p = await proxyProbe(vendor, key, opts.proxyTimeoutMs);
  if (p.reachable) {
    console.log(`[厂商预探] ${vendor.label} 直连腿：${directWhy} → 代理腿通了，不跳过（判据自己会说厂商回得好不好）`);
    return { reachable: true, via: "proxy" };
  }
  if (!p.skip) return p;
  return { reachable: false, skip: true, why: `${directWhy}，且${p.why}` };
}

async function oneProbe(vendor: VendorSpec, key: string, timeoutMs?: number): Promise<Reach & { status?: number }> {
  const { url, headers, body } = probeRequest(vendor, key);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? 30_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      // body 由 probeRequest 给：两种协议都明确不要流式，这里只要状态码，不想要一坨 SSE
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (res.status >= 500) return { reachable: false, skip: true, status: res.status, why: `厂商侧 HTTP ${res.status}（5xx 算它不在）` };
    if (res.status === 429) {
      return { reachable: false, skip: true, status: 429, why: `厂商限流（429）：配额窗口没过去，这轮不该由它判产品好坏` };
    }
    if (!res.ok) return { reachable: false, skip: false, status: res.status, why: `厂商回 HTTP ${res.status}：4xx 是真问题（key/额度/路径），不许当成"网络不通"跳掉` };
    return { reachable: true, via: "direct" };
  } catch (e) {
    return { reachable: false, skip: true, why: `连不出去：${e instanceof Error ? `${e.name} ${e.message}` : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 代理腿再探：POST `/api/proxy/chat`，形状与 R-E1 那条真判据一致（同源、由后端转发给厂商）。
 *
 * 它要先有一只本地会话：`server/routes/proxy.js:93` 的 `getSessionUsername` 不认就没得谈
 * （回 401 + `X-Proxy-Auth: required`）。这里**另开一个探针专用租户**，不复用 `l.user`：
 * 抢在界面登录之前把名字注册掉，会把 `signIn` 那步从"创建"变成"加入已有"，
 * R-E1/R-E2 判的就不再是同一条路了。
 *
 * 状态码归类按"这句话是谁说的"分：后端自己说的（400/401/500/504）是台架的事，
 * 厂商原样转达的（`res.status(response.status)` 那条分支）才算厂商的事。
 */
async function proxyProbe(vendor: VendorSpec, key: string, timeoutMs?: number): Promise<Reach & { status?: number }> {
  const token = await probeSession(vendor);
  if (!token) {
    return { reachable: false, skip: true, why: "后端代理腿没走通（本机 `/api/sync/register` 建不起会话）：这一档缺了后端什么都测不了" };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? 90_000);
  const { url, headers, body } = probeRequest(vendor, key);
  try {
    const res = await fetch(`${ORIGIN}/api/proxy/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      // 形状与直连腿那发**同一个出处**（`probeRequest`）：两条腿探的必须是同一件事，
      // 只是"谁去发"不同——否则代理腿通了也证明不了直连腿那发本来能通。
      body: JSON.stringify({ url, headers, body }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (res.status === 200) return { reachable: true, via: "proxy" };
    if (res.headers.get("x-proxy-auth")) {
      return { reachable: false, skip: true, why: `后端把这发挡在本地会话上（HTTP ${res.status}）：台架的登录问题，与厂商无关` };
    }
    if (res.status === 429) return { reachable: false, skip: true, status: 429, why: "厂商限流（429，经代理腿）：配额窗口没过去" };
    if (res.status >= 500) {
      return {
        reachable: false, skip: true, status: res.status,
        why: `后端没能把这一发送达厂商（HTTP ${res.status}：${text.replace(/\s+/g, " ").slice(0, 120)}）`,
      };
    }
    if (res.status === 400) {
      return {
        reachable: false, skip: true, status: res.status,
        why: `后端按自己的规矩拒了这一发（HTTP 400：${text.replace(/\s+/g, " ").slice(0, 120)}）：到不了厂商，不算厂商不在、也不算产品坏`,
      };
    }
    return { reachable: false, skip: false, status: res.status, why: `厂商经代理腿回 HTTP ${res.status}：4xx 是真问题（key/额度/路径），不许跳` };
  } catch (e) {
    return { reachable: false, skip: true, why: `代理腿连后端都没应答：${e instanceof Error ? `${e.name} ${e.message}` : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 探针专用租户：名字仍从 `id` + `RUN` 派生（`benchUsername` 保证落进服务端 2-30 字符窗口） */
async function probeSession(vendor: VendorSpec): Promise<string | null> {
  try {
    const res = await fetch(`${ORIGIN}/api/sync/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: benchUsername(`t${vendor.id}`, RUN), clientId: `pre-probe-${RUN}` }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const token = (JSON.parse(await res.text()) as { token?: unknown }).token;
    return typeof token === "string" && token !== "" ? token : null;
  } catch {
    return null;
  }
}

/* ───────────────────────── 预探小计（B：别让 exit 0 把跳过藏起来） ───────────────────────── */

/**
 * 每"被预探跳过一个组"就往这只文件里追加一行，跑完由 `postflight.ts` 汇总打印。
 *
 * 为什么走文件而不是内存：`workers` 现在是 1，但汇总要跨进程——`globalTeardown` 是另一个
 * 进程，看不见 spec 里的模块变量。为什么落 `DATA_DIR`：它本来就是一次性、仓库外的（预检已
 * 强制），换一轮跑就换一份，不会串；预检那一趟会把上一轮的文件清掉，所以这里读到的**一定**
 * 是这一轮的读数。
 *
 * **`judges` 是手写的**：这个组里判的是哪几条，新增判据就得一起加。对不上时看得出来——
 * `list` 报的 skipped 标题比小计多一条，就是这里漏登记了。
 */
export interface PreProbeSkip {
  /** 组名（与 describe 标题同一份字面，见两个调用点） */
  group: string;
  vendor: string;
  why: string;
  judges: string[];
  at: string;
}

export const PRE_PROBE_TALLY_FILE = path.join(DATA_DIR || os.tmpdir(), "pre-probe-tally.jsonl");

/** 预检调用：清掉上一轮的小计，否则"这一轮被杀了几条"会跨轮累加 */
export function clearPreProbeTally(): void {
  try {
    if (existsSync(PRE_PROBE_TALLY_FILE)) writeFileSync(PRE_PROBE_TALLY_FILE, "");
  } catch (e) {
    console.log(`[预探小计] 清不掉 ${PRE_PROBE_TALLY_FILE}：${e instanceof Error ? e.message : String(e)}（小计会带上上一轮的行数）`);
  }
}

export function recordPreProbeSkip(entry: Omit<PreProbeSkip, "at">): void {
  const line = `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`;
  try {
    appendFileSync(PRE_PROBE_TALLY_FILE, line, "utf8");
  } catch (e) {
    console.log(`[预探小计] 这一行没能记下（${e instanceof Error ? e.message : String(e)}）：${line.trim()}`);
  }
}

export function readPreProbeTally(): PreProbeSkip[] {
  if (!existsSync(PRE_PROBE_TALLY_FILE)) return [];
  const out: PreProbeSkip[] = [];
  for (const line of readFileSync(PRE_PROBE_TALLY_FILE, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as PreProbeSkip);
    } catch {
      console.log(`[预探小计] 这一行读不出（多半是被别的跑截断了）：${line.slice(0, 160)}`);
    }
  }
  return out;
}
