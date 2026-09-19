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
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const FROM = getArg("from", "176c21d");
const ROOT = process.cwd();

const allFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n")
  .filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f) && fs.existsSync(path.join(ROOT, f)));

const isTest = (f) => /__tests__|[.]test[.]/.test(f);

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

const changed = execFileSync("git", ["diff", "--name-only", `${FROM}..HEAD`], { encoding: "utf8" })
  .trim().split("\n")
  .filter((f) => /^(src|server)\//.test(f) && !isTest(f) && fs.existsSync(path.join(ROOT, f)));

const rows = changed.map((f) => ({ file: f, tests: reachingTests(f) }));
const naked = rows.filter((r) => r.tests.length === 0);

const jsonOut = getArg("json", "");
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 2));

console.log(`本轮改动的源文件：${rows.length}`);
console.log(`没有任何测试能到达（= 修复 100% 无用例守着）：${naked.length}\n`);
for (const n of naked) console.log(`  ${n.file}`);
if (!jsonOut) console.log("\n（加 --json 路径 可导出完整可达表）");
