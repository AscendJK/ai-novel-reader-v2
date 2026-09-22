/**
 * R-B6：一次开机的请求数**不许随书架规模涨**。
 *
 * 立这条的起因（2026-09-22 量测）：D3（换用户名不串号）在 6 worker 混跑时偶发超 30 秒，
 * 当时只把天花板抬到 60 秒，属于"调大容忍度"而不是查原因。真后端台架上量完的结论是
 * **产品侧不是原因**：换用户整趟 427ms、二次开机 198ms，且请求数是常数（书架 1 本与 8 本
 * 都是 4 发 /api），慢是 dev 源码伺服下 5 次 boot 各要拉几千个未打包模块的争用。
 *
 * 所以这条钉的是**将来**：哪天有人把"每本书各发一发"（逐本拉进度、逐本拉索引状态）接进
 * 开机路径，这台架就要红——那是唯一能让 boot 成本随藏书线性放大的形状，也是移动端/局域网
 * 上真会咬人的形状。钉"常数"而不是钉"快"：快慢跟机器谈不拢，常数谈得拢。
 */
import { test, expect, type Page } from "@playwright/test";
import { importFiles, miniNovel, shelfCard, txtFile } from "../pages/shelf";
import { RUN, signIn } from "./fixtures";

const USER = `perf甲-${RUN}`;

/** 一次 reload 窗口里浏览器发出的 `/api/*` 请求数 */
function apiMeter(page: Page) {
  const hits: string[] = [];
  const onReq = (r: { url: () => string }) => {
    let p: string;
    try {
      p = new URL(r.url()).pathname;
    } catch {
      return;
    }
    if (p.startsWith("/api/")) hits.push(p);
  };
  page.on("request", onReq);
  return {
    count: () => hits.length,
    /** 同一条路径出现几次（按书一发的形状在这里最显眼） */
    repeatOf: (frag: string) => hits.filter((h) => h.includes(frag)).length,
    off: () => page.off("request", onReq),
  };
}

/** reload 一次并等到书架真的渲染出来，返回这一趟的 `/api` 请求数 */
async function bootOnce(page: Page, firstTitle: string): Promise<{ calls: number; novelList: number }> {
  // 量测器必须挂在 reload **之前**：reload 之后才挂会把 boot 头几发漏掉（第一版就这么读出过 4 发）
  const m = apiMeter(page);
  await page.reload({ waitUntil: "load" });
  await expect(shelfCard(page, firstTitle)).toBeVisible({ timeout: 60_000 });
  // 书架出来后还有一小段尾巴（索引状态、心跳），等它落定再收数，否则读到的是半途
  await page.waitForTimeout(1_500);
  const out = { calls: m.count(), novelList: m.repeatOf("/api/novels") };
  m.off();
  return out;
}

test.describe("真后端：开机成本与书架规模脱钩", () => {
  test("R-B6 一次开机的 /api 请求数是常数：书架 1 本 vs 8 本", async ({ page, baseURL }) => {
    test.setTimeout(6 * 60_000);
    await signIn(page, baseURL!, USER);

    // 书名取自文件名（`src/parsers/txt.ts:215`），不是正文里的第一行
    const t = (i: number) => `perf书-${i}-${RUN}`;
    await importFiles(page, [txtFile(`${t(1)}.txt`, miniNovel())]);
    await expect(shelfCard(page, t(1))).toBeVisible({ timeout: 30_000 });
    const small = await bootOnce(page, t(1));

    for (let i = 2; i <= 8; i++) {
      await importFiles(page, [txtFile(`${t(i)}.txt`, miniNovel())]);
      await expect(shelfCard(page, t(i))).toBeVisible({ timeout: 30_000 });
    }
    const big = await bootOnce(page, t(1));

    // 反向：两次都必须真的量到请求（读成 0 的话整条判据恒真，那才是最坏的那种绿）
    expect(small.calls, "一次开机一个 /api 请求都没量到：量测器或书架路径没跑到").toBeGreaterThan(0);
    expect(big.calls, "第二次开机没量到任何请求：多半是量测器挂错窗口").toBeGreaterThan(0);
    // 8 本只多 1 本的那点量：多出来的部分必须是常数级，不许是每本书一发
    console.log(`[R-B6] 一次开机：书架 1 本 ${small.calls} 发 /api（其中 /api/novels ${small.novelList} 次）→ 8 本 ${big.calls} 发（${big.novelList} 次）`);
    expect(big.calls - small.calls, `书架从 1 本涨到 8 本，一次开机多发了 ${big.calls - small.calls} 个请求（${small.calls} → ${big.calls}）——按书一发的形状回来了`).toBeLessThanOrEqual(2);
    expect(big.novelList, `一次开机里 /api/novels 被发了 ${big.novelList} 次：拉平列表这件事又散成多个调用点了`).toBeLessThanOrEqual(3);
  });
});
