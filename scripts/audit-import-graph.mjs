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

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const FROM = getArg("from", "176c21d");
const ALL = args.includes("--all");
/** 浏览器层：`ANR_E2E_MODULE_LOG` 记下来的"这一页真加载过的模块" */
const BROWSER_FILE = getArg("browser", "");
const browserLoaded = new Set(
  BROWSER_FILE && fs.existsSync(BROWSER_FILE)
    ? [...new Set(fs.readFileSync(BROWSER_FILE, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean))]
    : [],
);
if (BROWSER_FILE && !fs.existsSync(BROWSER_FILE)) console.error(`--browser 指向的文件不存在：${BROWSER_FILE}（这一档会被当成空）`);
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

const rows = changed.map((f) => ({ file: f, tests: reachingTests(f), browser: browserLoaded.has(f) }));
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
  // 别把下面这句读成"那 52 只组件有人断言"，也别把 server/ 读成"完全没人看"：
  // 七只探针是**真起 `node server/index.js` 再发 HTTP**、或者 `await import(算出来的 URL)`
  // 加载 `server/database.js`，静态 import 图两种都看不见。server 的地板只能靠"改坏了探针红不红"
  // 来量 —— 那就是 `npm run audit:discrimination` 的活（它自带 PROBE_FOR 映射）。
  console.log("\n注：`server/` 这几只不代表「完全没人看着」。探针是真起后端发 HTTP、或者运行时 import 那些文件的，");
  console.log("    静态图看不见这两件事；服务端地板请用 npm run audit:discrimination（它自带 PROBE_FOR 映射）量。");
}
if (!jsonOut) console.log("\n（加 --json 路径 可导出完整可达表）");
