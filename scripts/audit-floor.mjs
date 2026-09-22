#!/usr/bin/env node
/**
 * 覆盖地板（一条命令跑完三层）
 *
 * 为什么要有这只脚本：2026-09-19 那句"26 个文件没有任何测试可达"是**只看 vitest 静态
 * import 图**量的，而那一年浏览器层还不存在。到 2026-09-22，`e2e/` 有 62 条真浏览器旅程，
 * 组件的"有没有人看着"必须按三层分开说：
 *   1. 单测/探针能到达（静态 import 图）；
 *   2. 单测到不了、但跑着的应用真加载过（`ANR_E2E_MODULE_LOG` 记的 `/src/**` 模块请求）；
 *   3. 两层都没碰到 —— 这一层才是真地板。
 * 第 2 档只证明"界面跑到了"，**不证明有人断言过它的行为**，所以脚本把它单列，
 * 不并进"有覆盖"。Worker 之类的模块不在页面模块图里，只会出现在第 3 档——这正是
 * `src/rag/encode.worker.ts` 当初躲在"52 个组件其实都被 E2E 跑过"后面没被发现的原因。
 *
 * 用法：npm run audit:floor [-- --no-e2e]（--no-e2e 复用上一次那份加载记录，不重跑 1.5 分钟）
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const LOG = path.join(os.tmpdir(), "anr-src-modules.jsonl");
const skipE2E = process.argv.includes("--no-e2e");

/**
 * 不经 `npx` 起 Playwright：Windows 上 `spawnSync("npx", …)` 会以 ENOENT 失败（状态 null），
 * 于是浏览器那一档整层不存在，地板只剩单测那一档——2026-09-22 一次性全面复跑时实测到的形状。
 * 取 `@playwright/test` 自己的 cli.js，用当前 node 可执行文件起，两侧分隔符与 PATHEXT 都不参与。
 */
function playwrightCli() {
  return path.join(path.dirname(createRequire(import.meta.url).resolve("@playwright/test")), "cli.js");
}

if (skipE2E && !fs.existsSync(LOG)) {
  console.error(`--no-e2e 但记录不存在：${LOG}（先不带这个开关跑一次）`);
  process.exit(2);
}

if (!skipE2E) {
  fs.rmSync(LOG, { force: true });
  console.log(`[地板] 跑 dev 那一层（--project=chromium）并记录加载过的 src 模块 → ${LOG}`);
  const run = spawnSync(process.execPath, [playwrightCli(), "test", "-c", "e2e/playwright.config.ts", "--project=chromium"], {
    stdio: "inherit",
    env: { ...process.env, ANR_E2E_MODULE_LOG: LOG },
  });
  // 用例红了也继续算地板：地板这件事与"哪条用例挂了"是两回事，而且挂掉的用例同样加载过模块
  if (run.status !== 0) console.log(`[地板] 浏览器层退出码 ${run.status}（不影响地板计算，但那一层的记录可能不全）`);
}

if (!fs.existsSync(LOG)) {
  console.error(`[地板] 没拿到加载记录：${LOG}`);
  process.exit(2);
}
const modules = new Set(fs.readFileSync(LOG, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
console.log(`[地板] 浏览器真加载过的 src 模块：${modules.size} 只`);

const audit = spawnSync(process.execPath, ["scripts/audit-import-graph.mjs", "--all", "--browser", LOG], { stdio: "inherit" });
process.exit(audit.status ?? 1);
