/**
 * R-E：真厂商两条腿（浏览器直连 + 后端代理），两家厂商各走一遍。
 *
 * 这一组是整套验证里**唯一**碰到真上游 AI 服务的地方，别的层全是假厂商：
 *  - 主套 C 组把厂商挂在**同源** `/api/e2e-llm/v1`（`e2e/fixtures/vendor.ts` 头上写着为什么
 *    必须同源：那样直连腿与代理腿转发的都是本页面上的地址，一发桩管两条腿）；
 *  - 探针 `probe:proxy` 看的是后端代理自己的契约（转发白名单、错误分类、SSE 透传），上游是假的。
 * 所以"这家厂商的域名/路径/模型名到底通不通""它的 CORS 长什么样""厂商用 401 表达密钥被拒时
 * 前端会不会误判成本机会话失效"这三件事，今天只有这一档能红。
 *
 * key 的口径（制作人 2026-09-22 明确"不用担心泄露，你自己测"）：
 *  - **只从环境变量读**（`ANR_VENDOR1_KEY` / `ANR_VENDOR2_KEY`），不落盘、不进仓库、不写进任何
 *    提交与报告文本；没给 key 时整组 `test.skip`，所以标准的 17 条一轮不会因此变红；
 *  - 跑这一档**必须** `ANR_REAL_ARTIFACTS=off`：Playwright 的 trace 会原样记下请求头，
 *    `Authorization: Bearer <key>` 就躺在 `test-results/` 里（`playwright.real.config.ts` 认这只 env）。
 *
 * 两条腿的形状（`src/api/providers/openai.ts`）：先直连 `POST {baseUrl}/chat/completions`，
 * **只有连不上**（CORS / DNS / 超时）才换代理；厂商答回来之后的 401/429/空响应**不换腿**
 * （批次 Q 修的那处：async 里 `return` 一只没 await 的 promise 会绕过 catch）。
 * sensenova 不响应 `OPTIONS` 预检，所以它的直连腿在浏览器里必败，代理腿才是唯一活路 —— 这正是
 * R-E2 要量的分野：两家同一条判据，腿形却不一样。
 */
import { test, expect, type Page } from "@playwright/test";
import { panel } from "../pages/panel";
import { openSettings, openSummaryPanel, addProvider, leaveSettings } from "../pages/settings";
import { importFiles, openBook, shelfCard, txtFile } from "../pages/shelf";
import { ORIGIN, RUN, realNovel, signIn, vendorReach } from "./fixtures";

interface Vendor {
  /** 只出现在测试标题与判据文案里，不含 key */
  label: string;
  user: string;
  providerName: string;
  keyEnv: string;
  base: string;
  model: string;
}

/** 厂商地址/模型名可被 env 覆盖（换型号调试时用），key 不行——key 只在 env 里活一次。 */
const VENDORS: Vendor[] = [
  {
    label: "厂商一",
    user: `r组厂商一-${RUN}`,
    providerName: `R-E 厂商一-${RUN}`,
    keyEnv: "ANR_VENDOR1_KEY",
    base: process.env.ANR_VENDOR1_BASE ?? "https://411.cc.cd/v1",
    model: process.env.ANR_VENDOR1_MODEL ?? "gpt-5.6-luna",
  },
  {
    label: "厂商二（sensenova：不响应 OPTIONS 预检）",
    user: `r组厂商二-${RUN}`,
    providerName: `R-E 厂商二-${RUN}`,
    keyEnv: "ANR_VENDOR2_KEY",
    base: process.env.ANR_VENDOR2_BASE ?? "https://token.sensenova.cn/v1",
    model: process.env.ANR_VENDOR2_MODEL ?? "sensenova-6.8-flash-lite",
  },
];

const BOOK = `R-E真厂商书-${RUN}`;
/** 第一章正文里独有的词（`fixtures.ts` 的 `realNovel()`）。摘要里一个都没有 = 不是真读过这章 */
const CHAPTER_TOKENS = /洛阳|卖炭|兵卒|火盆|薄霜|铁甲/;

async function bearer(page: Page): Promise<string> {
  const t = await page.evaluate(() => localStorage.getItem("sync-token"));
  expect(t, "没拿到后端会话 token，说明登录这步就没成").toBeTruthy();
  return t as string;
}

/**
 * 两条腿的请求计数。
 *
 * 直连腿被 CORS 拦下时浏览器**照样会发**（拿不到响应），所以 `request` 事件能记到它 ——
 * 这正是"浏览器真的试过直连"的证据。代理腿走的是同源 `/api/proxy/chat`。
 */
function legs(page: Page, vendorBase: string) {
  const s = { direct: 0, proxy: 0 };
  page.on("request", (r) => {
    const u = r.url();
    if (u.startsWith(vendorBase)) s.direct++;
    else if (u.includes("/api/proxy/")) s.proxy++;
  });
  return s;
}

/** 配一家厂商并确认它就是「当前使用的那只」 */
async function configure(page: Page, baseURL: string, v: Vendor, key: string): Promise<void> {
  await signIn(page, baseURL, v.user);
  await openSettings(page);
  await addProvider(page, { name: v.providerName, key, baseUrl: v.base, model: v.model });
  // 生效与否看顶部那只「API 提供商」选择器（`ProviderSelect.tsx:21` 的 `#active-provider`，
  // 它的 `SelectValue` 显示当前激活的那家）。不点卡片、也不用 `getByText("当前")`：
  // 徽章那两枚"当前"加上"当前使用的 API"「当前章播放完毕后…」实测撞 5 个元素，
  // 而保存后厂商名已经同时出现在选择器与卡片上，`.first()` 会点到选择器上把下拉打开。
  const trigger = page.locator("#active-provider");
  await expect(trigger).toBeVisible();
  if (!(await trigger.innerText()).includes(v.providerName)) {
    await trigger.click();
    await page.getByRole("option").filter({ hasText: v.providerName }).click();
  }
  await expect(trigger).toContainText(v.providerName);
  await leaveSettings(page);
}

for (const v of VENDORS) {
  const key = process.env[v.keyEnv] ?? "";

  test.describe.serial(`R-E ${v.label}`, () => {
    test.skip(!key, `没设 ${v.keyEnv}：这一组要真厂商 key，缺了就跳过（不算红）`);

    // 厂商"不在"与产品"坏了"是两件事：连不出去/5xx 就整组跳过并写明原因，
    // 4xx（key 失效、额度、路径写错）照红——那正是这些判据要报的东西。
    test.beforeAll(async () => {
      const r = await vendorReach({ base: v.base, model: v.model, key });
      if (r.reachable) return;
      console.log(`[R-E] ${v.label} 预探：${r.why} → ${r.skip ? "跳过这一组" : "不跳过，让判据红"}`);
      test.skip(r.skip, `${v.label} 预探：${r.why}`);
    });

    test(`R-E1 可达性：经后端代理转发打一条探针，域名/路径/模型名三件都对得上`, async ({ page, baseURL }) => {
      test.setTimeout(3 * 60_000);
      await signIn(page, baseURL!, v.user);

      const r = await page.request.post(`${ORIGIN}/api/proxy/chat`, {
        headers: { authorization: `Bearer ${await bearer(page)}`, "content-type": "application/json" },
        data: {
          url: `${v.base}/chat/completions`,
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          // 非流式：这一条要的是"厂商原样回的结构对不对"，SSE 透传由 probe:proxy 那 14 项管。
          // 预算给到 512 而不是几十字符：sensenova-6.8-flash-lite 实测是**推理模型**，
          // 16 token 会被它的 `reasoning` 吃光（`finish_reason:"length"`、`content` 干脆没有），
          // 那样厂商是通的、探针却会红在"没正文"上——报出来的是预算，不是可达性。
          body: { model: v.model, stream: false, max_tokens: 512, messages: [{ role: "user", content: "只回复两个字：收到" }] },
        },
      });
      const text = await r.text();
      expect(r.status(), `代理转发回 ${r.status()}，厂商原话：${text.slice(0, 300)}`).toBe(200);
      const j = JSON.parse(text) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        usage?: Record<string, number>;
      };
      const content = j.choices?.[0]?.message?.content ?? "";
      expect(
        content.trim().length,
        `厂商回了 200 但没有正文（finish_reason=${j.choices?.[0]?.finish_reason}）：${text.slice(0, 300)}`,
      ).toBeGreaterThan(0);
      // usage 是前端算上下文预算的依据（token-manager），缺它等于每轮都按最保守值猜
      const total = Object.values(j.usage ?? {}).reduce((a, n) => a + (Number(n) || 0), 0);
      expect(total, `响应里没有 usage（前端 token 预算没依据）：${JSON.stringify(j.usage)}`).toBeGreaterThan(0);
      console.log(`[R-E1] ${v.label} 可达：正文 "${content.trim().slice(0, 20)}"，usage=${JSON.stringify(j.usage)}`);
    });

    test(`R-E2 界面走一次真摘要：直连腿真发过、分类不误报、内容真是这章、二次打开不再花钱`, async ({ page, baseURL }, testInfo) => {
      test.setTimeout(6 * 60_000);
      await configure(page, baseURL!, v, key);
      await importFiles(page, [txtFile(`${BOOK}.txt`, realNovel())]);
      await expect(shelfCard(page, BOOK)).toBeVisible({ timeout: 30_000 });
      await openBook(page, BOOK);

      const s = legs(page, v.base);
      await openSummaryPanel(page);
      await panel.button(page, "总结本章").click();
      // 真上游：首字之外还要等整段生成完，给 4 分钟
      await expect(panel.text(page, CHAPTER_TOKENS).first()).toBeVisible({ timeout: 4 * 60_000 });
      await expect(panel.text(page, "暂无总结，点击上方按钮生成")).toHaveCount(0);

      // 浏览器真的朝厂商发过请求（被 CORS 拦下也算发过）——不试直连就说明配置没被用上
      expect(s.direct, `浏览器一次都没往 ${v.base} 发请求：直连那条腿根本没被走到`).toBeGreaterThan(0);
      // 批次 Q 那处的真后端翻版：厂商/网络的问题不许说成"本机会话失效"
      await expect(panel.text(page, /与后端的登录会话已失效/)).toHaveCount(0);
      const body = await panel.root(page).innerText();
      expect(body.length, "面板没有可读的摘要正文").toBeGreaterThan(40);
      console.log(`[R-E2] ${v.label} 腿形：直连发过 ${s.direct} 次、代理 ${s.proxy} 次`);
      testInfo.annotations.push({ type: "legs", description: `direct=${s.direct} proxy=${s.proxy}` });

      // 反向：同一章第二次进面板必须吃缓存，不再打厂商也不再打代理（否则每翻一页都在花钱）
      const before = { ...s };
      await page.getByRole("button", { name: "书架" }).first().click();
      await expect(shelfCard(page, BOOK)).toBeVisible({ timeout: 30_000 });
      await openBook(page, BOOK);
      await expect(panel.text(page, CHAPTER_TOKENS).first()).toBeVisible({ timeout: 60_000 });
      expect({ direct: s.direct - before.direct, proxy: s.proxy - before.proxy }, "重开同一章又打了一次厂商/代理：缓存没起作用").toEqual({
        direct: 0,
        proxy: 0,
      });
    });
  });
}

test.describe("R-E 两条腿的分工（错 key）", () => {
  const v = VENDORS[1];
  const key = process.env[v.keyEnv] ?? "";
  // 用 sensenova 那家：它的直连腿在浏览器里必败（无 OPTIONS 预检），所以这次一定走到代理腿，
  // 也正是在这条腿上"厂商的 401"最容易被误判成"后端会话失效"（`server/routes/proxy.js:63-67` 注释）
  test.skip(!key, `没设 ${v.keyEnv}：需要一把真 key 才能派生一只错 key 的对照`);

  // 这条依赖厂商**真回 401**（判的是"厂商 401 不许说成本机会话失效"），所以厂商连不上时
  // 它没有可判的东西：与上面同一套分类——网络层/5xx 跳过，4xx 照跑。
  test.beforeAll(async () => {
    const r = await vendorReach({ base: v.base, model: v.model, key });
    if (r.reachable) return;
    console.log(`[R-E4] ${v.label} 预探：${r.why} → ${r.skip ? "跳过" : "不跳过，让判据红"}`);
    test.skip(r.skip, `${v.label} 预探：${r.why}`);
  });

  test(`R-E4 故意错的 key：报"认证失败"类文案，并且不拿同一份内容再打第二次`, async ({ page, baseURL }) => {
    test.setTimeout(6 * 60_000);
    // 只改 key 的中间一段，长度与形状都保持真 key 的样子：厂商才会回"密钥不对"而不是"请求格式错"
    await configure(page, baseURL!, v, `sk-${"0".repeat(Math.max(8, key.length - 3))}zz`);
    await importFiles(page, [txtFile(`${BOOK}.txt`, realNovel())]);
    await expect(shelfCard(page, BOOK)).toBeVisible({ timeout: 30_000 });
    await openBook(page, BOOK);

    const s = legs(page, v.base);
    const proxyAtClick = s.proxy;
    await openSummaryPanel(page);
    await panel.button(page, "总结本章").click();

    await expect(panel.text(page, /认证失败|API Key|密钥|401|403/).first()).toBeVisible({ timeout: 3 * 60_000 });
    // 不许把厂商的拒绝说成本机登录失效（说了用户就会去重登，而问题在 key）
    await expect(panel.text(page, /与后端的登录会话已失效/)).toHaveCount(0);
    // 批次 Q 的判据：厂商答回来之后再多的错也不换腿重打 —— 一次点击只许打代理一次
    expect(s.proxy - proxyAtClick, `一次点击打了 ${s.proxy - proxyAtClick} 次代理：401 之后不该再换腿重打`).toBeLessThanOrEqual(1);
  });
});
