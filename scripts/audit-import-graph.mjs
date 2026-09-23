/**
 * 可达性审计（round 3 阶段 A 的第二块地基）
 *
 * 回答一个不需要跑测试就能确定的问题：**哪些源文件没有任何测试文件能到达它？**
 * 这类文件里的修复 100% 没有用例守着——不用试也知道。反过来，能到达它的测试文件清单
 * 正好指出"该跑哪几个文件"，比整模块、整仓跑便宜两个数量级。
 *
 * 上一版审计的教训就在这里：按模块子集 + 全量确认跑，61 个文件要跑上百轮全量，
 * 机器扛不住（实测一次全量从 52s 恶化到 461s），基线一飘结论就作废。
 *
 * 用法：node scripts/audit-import-graph.mjs [--from 176c21d] [--json out.json]
 *      --all      算全部 `src/`+`server/` 生产文件，而不是"某提交之后改过的"——
 *                 要看**当前**覆盖地板就用它（`FROM` 那个口径是 2026-09 那轮审计的遗留）。
 *      --browser <jsonl>  叠上浏览器层：文件每行一个 `src/...` 路径，来自
 *                 `ANR_E2E_MODULE_LOG=<路径> npx playwright test -c e2e/playwright.config.ts`。
 *                 这一档只说明"这个模块真在跑的应用里被加载过"，**不等于有断言看着它**；
 *                 分档就是为了不把"加载过"读成"测过了"。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PROBE_FOR } from "./lib/probe-map.mjs";

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const FROM = getArg("from", "176c21d");
const ALL = args.includes("--all");
/**
 * 浏览器层：`ANR_E2E_MODULE_LOG` 记下来的"这一页真加载过的模块"。
 * 每行是 `模块路径\t用例文件`（老格式只有一列，照样吃得下），第二列留着给"哪几条用例
 * 加载了它"用——地板第 2 档要逐只核"有没有断言穿过"，没有这一列就只能盲读整套 spec。
 */
const BROWSER_FILE = getArg("browser", "");
const browserPairs =
  BROWSER_FILE && fs.existsSync(BROWSER_FILE)
    ? [...new Set(fs.readFileSync(BROWSER_FILE, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean))]
    : [];
if (BROWSER_FILE && !fs.existsSync(BROWSER_FILE)) console.error(`--browser 指向的文件不存在：${BROWSER_FILE}（这一档会被当成空）`);
const browserLoaded = new Set(browserPairs.map((l) => l.split("\t")[0]));
/** 模块 → 加载过它的用例文件（去重） */
export const browserSpecs = new Map();
for (const line of browserPairs) {
  const [mod, spec] = line.split("\t");
  if (!spec) continue;
  if (!browserSpecs.has(mod)) browserSpecs.set(mod, new Set());
  browserSpecs.get(mod).add(spec);
}
const ROOT = process.cwd();

const allFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n")
  .filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f) && fs.existsSync(path.join(ROOT, f)));

// 判据层算三样：vitest 用例、`e2e/` 旅程的静态可达（多半到不了，浏览器层另记），
// 以及**七只服务端探针**——它们直接 `import` server 里的模块（`probe-novel-reupload` 就是
// 直接调 `db.insertNovel`），所以按 import 图算得到它们，且它们本来就是服务端那层的判据。
// 不这么算的话 `server/rag-builder.js`、`admin.js` 会被误报成"没人看着"。
const isTest = (f) => /__tests__|[.]test[.]/.test(f) || /^scripts[/]probe-[a-z-]+\.mjs$/.test(f);

const EXTS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];
// 仓内路径一律用正斜杠（git ls-files 给的就是正斜杠）；Windows 上 path.join 会掺反斜杠，
// 混用会让所有候选路径匹配失败——第一版就是这样把 71 个文件全判成"无测试可达"的
const pj = (...parts) => parts.join("/").replace(/\/+/g, "/");
const rel = (p) => {
  const segs = p.split("/");
  const out = [];
  for (const s of segs) {
    if (s === "..") out.pop();
    else if (s !== "." && s !== "") out.push(s);
  }
  return out.join("/");
};
function resolve(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = pj("src", spec.slice(2));
  else if (spec.startsWith(".")) base = rel(pj(path.posix.dirname(fromFile), spec));
  else return null; // 裸包名：不是仓内模块
  for (const e of EXTS) {
    const cand = base + e;
    if (allFiles.includes(cand)) return cand;
  }
  return null;
}

/** 抽出 import/export-from/动态 import 的模块说明符 */
function specsOf(file) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const out = new Set();
  const re = /(?:^|[\s;}])(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1] ?? m[2] ?? m[3]);
  return [...out];
}

// 反向边：谁 import 了我
const importers = new Map();
for (const f of allFiles) {
  for (const spec of specsOf(f)) {
    const target = resolve(spec, f);
    if (!target) continue;
    if (!importers.has(target)) importers.set(target, new Set());
    importers.get(target).add(f);
  }
}

/** 从文件出发，向上找能到达它的测试文件（BFS，防环） */
function reachingTests(file, limit = 40) {
  const seen = new Set([file]);
  const queue = [file];
  const tests = [];
  while (queue.length && tests.length < limit) {
    const cur = queue.shift();
    for (const up of importers.get(cur) ?? []) {
      if (seen.has(up)) continue;
      seen.add(up);
      if (isTest(up)) tests.push(up);
      queue.push(up);
    }
  }
  return tests;
}

const changed = ALL
  ? allFiles.filter((f) => /^(src|server)\//.test(f) && !isTest(f))
  : execFileSync("git", ["diff", "--name-only", `${FROM}..HEAD`], { encoding: "utf8" })
      .trim().split("\n")
      .filter((f) => /^(src|server)\//.test(f) && !isTest(f) && fs.existsSync(path.join(ROOT, f)));

const rows = changed.map((f) => {
  const tests = reachingTests(f);
  // 探针是**另起进程** `node server/index.js` 再发真 HTTP 的，静态 import 图跨不过这条边界，
  // 于是 `server/routes/*.js` 这类会被误报成"没人看着"。映射表里有的补上，带 `探针映射:` 前缀
  // 与真 import 分开——那张表每只都经手工变异证过"改坏了探针会红"，见 lib/probe-map.mjs 头上。
  for (const p of PROBE_FOR[f] ?? []) if (!tests.includes(`探针映射:${p}`)) tests.push(`探针映射:${p}`);
  // `specs`：哪几条用例加载过它——第 2 档要逐只核"有没有断言穿过"，靠这个挑用例才不用盲读整套
  return { file: f, tests, browser: browserLoaded.has(f), specs: [...(browserSpecs.get(f) ?? [])] };
});
const naked = rows.filter((r) => r.tests.length === 0 && !r.browser);
const onlyBrowser = rows.filter((r) => r.tests.length === 0 && r.browser);

const jsonOut = getArg("json", "");
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 2));

console.log(`算进来的源文件：${rows.length}${ALL ? "（--all：全部 src/ + server/）" : `（${FROM}..HEAD 改过的）`}`);
console.log(`单测/探针可达：${rows.filter((r) => r.tests.length > 0).length}`);
console.log(`单测/探针到不了、浏览器跑到过（只证明界面加载过它；断言有没有穿过它要人看用例）：${onlyBrowser.length}`);
for (const n of onlyBrowser) console.log(`  ${n.file}`);
console.log(`\n两层都没碰到（= 改动 100% 无用例守着）：${naked.length}\n`);
for (const n of naked) console.log(`  ${n.file}`);
if (naked.some((n) => n.file.startsWith("server/"))) {
  // 走到这里还没被算进"有人看着"的 server 文件，意味着三件事同时成立：没有测试静态 import 到它、
  // 浏览器层没加载它（server 文件本来也不会被浏览器加载）、**探针映射表里也没有它**。
  // 最后那张表是人工维护的（`lib/probe-map.mjs`），漏填会在这里报成假地板——先照那张表头上的
  // 量法手工变异一次（改坏 → 看 `probe:boot` 红不红 → 还原），确认了再动手补判据。
  console.log("\n注：`server/` 这几只是「映射表里也没有」——先手工变异确认一次，别直接读成裸奔（量法见 lib/probe-map.mjs 头上）。");
}
if (!jsonOut) console.log("\n（加 --json 路径 可导出完整可达表）");
