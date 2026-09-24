#!/usr/bin/env node
/**
 * 「直接判据」审计（地板的第 1 档拆开看）
 *
 * 为什么要有这只：`audit:floor` 的第 1 档按 **import 传递闭包** 算，于是补一只组件的单测
 * 会把它顺带 import 到的东西一起抬进"有覆盖"。2026-09-25 实测到这句话的代价：第 1 档 179 只
 * 里 **50 只没有任何测试文件直接指着**——包括被改动最多的一只（`src/rag/model-loader.ts`，
 * 40 笔提交，而 4 个用它的测试文件各写了一份 `vi.mock` 把它整只桩掉）。
 * 也就是说"地板数字涨了"与"有人断言过它"是两件事，前者可以全靠转手。
 *
 * 这一只问一个更窄的问题：**有没有一只测试文件，跨过薄壳（barrel）之后仍然直接指着这只模块，
 * 而且没有 `vi.mock` 掉它**（桩掉的不是判据对象）。没有的，就是"改坏了不会有东西红"的那一列。
 *
 * 用法：npm run audit:direct
 *      （浏览器那一列读上一次 `audit:floor` 留在临时目录的加载记录；没有它会明说"那一列是空"，
 *       而不是静默给你一个看起来完整的读数）
 *
 * 读数口径：
 *  - 排序按「改动笔数」倒序（2026-06-01 之后这只文件被提交碰过几笔），同笔数按行数倒序
 *    ——要钉的是"既常被改又没人看着"的那几只，不是最长的或最古老的。
 *  - `PROBE_FOR` 映射过的服务端文件算"有直接判据"：探针是另起进程发真 HTTP 的，静态 import
 *    图跨不过那条边界，映射表（`lib/probe-map.mjs`）里有的就在这一步放行。
 *  - 「浏览器 N 只 spec 加载过」**不等于**有人断言过它，只是指出该去哪只 spec 里找。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PROBE_FOR } from "./lib/probe-map.mjs";

const ROOT = process.cwd();
// 仓内路径一律正斜杠：Windows 上 path.join 会掺反斜杠，混用会让候选路径全匹配不上
const pj = (...parts) => parts.join("/").replace(/\/+/g, "/");
const rel = (p) => {
  const out = [];
  for (const s of p.split("/")) {
    if (s === "..") out.pop();
    else if (s !== "." && s !== "") out.push(s);
  }
  return out.join("/");
};
const EXTS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];

const allFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n")
  .filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f) && fs.existsSync(path.join(ROOT, f)));

/** 判据层：vitest 用例、e2e 旅程，以及直接 import 服务端模块的探针（与地板同口径） */
const isTest = (f) => /__tests__|[.]test[.]/.test(f) || /^scripts[/]probe-[a-z-]+\.mjs$/.test(f);
const prod = allFiles.filter((f) => /^(src|server)\//.test(f) && !isTest(f));

/**
 * 抽说明符之前先剥注释：判据文件的头注释里常会出现 `vi.mock("@/...")`、`import … from "@/..."`
 * 这类**句子**（本仓 2026-09-25 实测到一处：`AudioPlayer-bar.test.tsx` 的注释写了
 * `vi.mock("@/components/tts/AudioPlayer")`，于是那只栏被读成"被本文件桩掉"，从裸奔名单里
 * 漏算一格）。剥掉块注释与行注释之后，正则只看真代码。
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 抽出 import/export-from/动态 import 的模块说明符 */
function specsOf(file) {
  const src = stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));
  const out = new Set();
  const re = /(?:^|[\s;}])(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1] ?? m[2] ?? m[3]);
  return [...out];
}

function resolve(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = pj("src", spec.slice(2));
  else if (spec.startsWith(".")) base = rel(pj(path.posix.dirname(fromFile), spec));
  else return null; // 裸包名：不是仓内模块
  for (const e of EXTS) if (allFiles.includes(base + e)) return base + e;
  return null;
}

/** 这只测试 `vi.mock` 掉了哪些模块——被桩掉的不算它盯着的对象（同样先剥注释） */
function mockedOf(file) {
  const src = stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));
  const out = new Set();
  const re = /vi\.mock\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    const t = resolve(m[1], file);
    if (t) out.add(t);
  }
  return out;
}

/**
 * 薄壳（barrel / 纯 re-export）：剥掉 import-export 与注释后基本不剩代码。
 * 测试从 `@/components/ui` 拿东西 = 测的是它 re-export 的那只，所以只穿透薄壳；
 * 穿透任何文件就退回成第 1 档那个传递闭包，这一只问的问题也就没了意义。
 */
const thinCache = new Map();
function isThin(file) {
  if (thinCache.has(file)) return thinCache.get(file);
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const body = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\bexport\s+[\s\S]*?\bfrom\s*["'][^"']+["'][\s\S]*?;/g, "")
    .replace(/\bexport\s+[\s\S]*?\bfrom\s*["'][^"']+["']/g, "")
    .replace(/\bimport\s+[\s\S]*?\bfrom\s*["'][^"']+["'][\s\S]*?;/g, "")
    .replace(/\bimport\s+[\s\S]*?\bfrom\s*["'][^"']+["']/g, "")
    .replace(/\bimport\s+["'][^"']+["']/g, "")
    .replace(/\bimport\s*\([^)]*\)\s*;?/g, "")
    .trim();
  const thin = body.length < 80; // 允许只剩一句 `export default X` 之类
  thinCache.set(file, thin);
  return thin;
}

/** 生产模块 → 哪些测试直接指着它（跨薄壳、未被 mock） */
const directOf = new Map();
for (const t of allFiles.filter(isTest)) {
  const mocks = mockedOf(t);
  const seen = new Set();
  const queue = specsOf(t).map((s) => resolve(s, t)).filter(Boolean);
  const hits = new Set();
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    if (prod.includes(cur)) hits.add(cur);
    if (isThin(cur)) for (const s of specsOf(cur)) { const r = resolve(s, cur); if (r) queue.push(r); }
  }
  for (const m of hits) if (!mocks.has(m)) {
    if (!directOf.has(m)) directOf.set(m, new Set());
    directOf.get(m).add(t);
  }
}

/** 反向边（谁 import 了我）→ 复算第 1 档的"传递可达" */
const importers = new Map();
for (const f of allFiles) for (const s of specsOf(f)) {
  const target = resolve(s, f);
  if (!target) continue;
  if (!importers.has(target)) importers.set(target, new Set());
  importers.get(target).add(f);
}
function reachingTests(file) {
  const seen = new Set([file]);
  const queue = [file];
  const tests = [];
  while (queue.length) {
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

/** 浏览器层：上一次 `audit:floor` 记下的"这一页真加载过的模块 → 哪只 spec" */
const LOG = path.join(os.tmpdir(), "anr-src-modules.jsonl");
const browserSpecs = new Map();
if (fs.existsSync(LOG)) {
  for (const line of fs.readFileSync(LOG, "utf8").split(/\r?\n/)) {
    const [mod, spec] = line.trim().split("\t");
    if (!mod || !spec) continue;
    if (!browserSpecs.has(mod)) browserSpecs.set(mod, new Set());
    browserSpecs.get(mod).add(spec);
  }
} else console.error(`没有浏览器记录：${LOG}（这一列会是空——先跑一次 npm run audit:floor）`);

const since = "2026-06-01";
const tier1 = [];
const noDirect = [];
for (const f of prod) {
  const hasProbe = (PROBE_FOR[f] ?? []).length > 0;
  if (!hasProbe && reachingTests(f).length === 0) continue; // 不在第 1 档，归地板管
  tier1.push(f);
  if (hasProbe) continue; // 探针映射过的算有直接判据
  if (directOf.has(f)) continue;
  const lines = fs.readFileSync(path.join(ROOT, f), "utf8").split(/\r?\n/).length;
  const churn = execFileSync("git", ["log", "--oneline", `--since=${since}`, "--", f], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean).length;
  noDirect.push({
    file: f, lines, churn,
    specs: [...(browserSpecs.get(f) ?? [])].map((s) => path.basename(s)),
  });
}

noDirect.sort((a, b) => b.churn - a.churn || b.lines - a.lines);

console.log(`第 1 档（测试传递可达或探针映射过）：${tier1.length} 只`);
console.log(`其中没有任何测试文件直接指着（跨薄壳、未被 vi.mock）：${noDirect.length} 只`);
console.log(`\n按「${since} 之后被碰的笔数」倒序——要钉的是既常被改又没人直接看着的那几只：\n`);
for (const r of noDirect) {
  console.log(`  改 ${String(r.churn).padStart(2)} 笔 / ${String(r.lines).padStart(5)} 行  ${r.file}`);
  console.log(`           浏览器：${r.specs.length ? `${r.specs.length} 只 spec 加载过（${r.specs.join(" ")}）` : "e2e 记录里没有它"}`);
}
console.log("\n注：这一列只说「没有测试文件直接 import 到它」。行为有没有被间接断言，得逐个看上面那列 spec 或用例——别把「转手可达」读成「有人看着」，也别反过来读成「一定没测」。");
