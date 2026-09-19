/**
 * 判别力审计（round 3 阶段 A）
 *
 * 要回答的问题：**把修复按回去，有没有用例会变红？** 不变红就说明那条修复裸奔。
 *
 * 第一版（逐提交还原）已失败并作废，教训写在这里：
 *  - `git apply --3way` 在冲突时会把冲突标记**留在工作区**，而失败分支没有还原 →
 *    从第 1 个提交起整轮被污染，后面所有"全绿"都是假的；
 *  - 靠正则抓 vitest 的 `FAIL` 行会把"23 个文件失败"读成 0 失败 → 假阴性；
 *  - 逐提交还原本身也不成立：后续提交反复改写同一段，30 个提交里 5 个根本还原不动。
 *
 * 现在的设计：
 *  1. 以 **文件** 为单位（`git diff FROM HEAD -- file` 永远能干净反向应用）；
 *  2. 只用 `git apply -R`（原子：要么全改要么不动），不碰 --3way；
 *  3. 结果从 vitest 的 JSON reporter 读，不猜文本；
 *  4. 每轮结束 `git restore --source=HEAD --worktree -- <file>` 并**校验工作区真的干净**，
 *     不干净立即中止整轮，绝不在污染状态下继续；
 *  5. 先跑模块内子集（快），若一个都没红再跑全量确认（防止跨模块保护被漏判）。
 *
 * 用法：node scripts/audit-discrimination.mjs [--from 176c21d] [--scope src|server|all]
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const FROM = getArg("from", "176c21d");
const SCOPE = getArg("scope", "src");

/** audit-import-graph.mjs 产出的可达表：file → 能到达它的测试文件列表 */
const REACH_FILE = getArg("reach", "");
const reachMap = REACH_FILE && fs.existsSync(REACH_FILE)
  ? Object.fromEntries(JSON.parse(fs.readFileSync(REACH_FILE, "utf8")).map((r) => [r.file, r.tests]))
  : {};

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const outDir = path.join(os.tmpdir(), "anr-discrimination");
fs.mkdirSync(outDir, { recursive: true });
const report = path.join(outDir, "result.json");
const rows = [];
const save = () => fs.writeFileSync(report, JSON.stringify(rows, null, 2));
const record = (row) => { rows.push(row); save(); };

// 崩溃/被强杀时留话：本脚本会临时改源码，没还原就是脏的（第一版正是在这里被
// SIGKILL 留下 30 个带冲突标记的文件，事后只能靠 git restore 收拾）
let inFlight = null;
process.on("exit", () => {
  if (!inFlight) return;
  try {
    execFileSync("git", ["restore", "--source=HEAD", "--staged", "--worktree", "--", inFlight], { stdio: "ignore" });
    console.log(`\n退出时强制还原了 ${inFlight}`);
  } catch {
    console.log(`\n注意：${inFlight} 可能仍是还原态，请执行 git restore --source=HEAD --staged --worktree .`);
  }
});

if (git("status", "--porcelain", "-uno").trim()) {
  console.error("已跟踪文件不干净，拒绝执行（每轮都会改源码）。");
  process.exit(2);
}

/** 跑一次 vitest，返回 {failed, total, exit, failedFiles, error} */
function runVitest(filter) {
  const jsonFile = path.join(outDir, "last.json");
  try { fs.rmSync(jsonFile, { force: true }); } catch { /* ignore */ }
  // 不用 --silent：它是布尔开关，会把后面的位置参数吃掉（"Unexpected value --silent=src/agents"）
  const cliArgs = ["node_modules/vitest/vitest.mjs", "run", "--reporter=json", `--outputFile=${jsonFile}`];
  const targets = filter == null ? [] : Array.isArray(filter) ? filter : [filter];
  cliArgs.push(...targets.filter(Boolean));
  const run = spawnSync(process.execPath, cliArgs, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    cwd: process.cwd(),
    timeout: 240_000,
    killSignal: "SIGKILL",
  });
  if (run.error?.code === "ETIMEDOUT" || run.status === null || Boolean(run.signal)) {
    return { failed: -1, total: 0, exit: null, failedFiles: [], error: "超时（180–240s 封顶）" };
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
  } catch {
    // 读不到结构化结果就当"不确定"，绝不返回 0 失败
    return { failed: -1, total: 0, exit: run.status, failedFiles: [], error: "无法解析 vitest JSON 输出" };
  }
  const failedFiles = (json.testResults ?? [])
    .filter((t) => (t.assertionResults ?? []).some((a) => a.status === "failed") || t.status === "failed")
    .map((t) => path.relative(process.cwd(), t.name).replace(/\\/g, "/"));
  // exit 非 0 但 0 失败 = 集合期错误（import 解析不了、unhandled error）：
  // 新增文件被"还原"就是被删除，此时测试根本没跑起来，不能算无保护
  return { failed: json.numFailedTests ?? failedFiles.length, total: json.numTotalTests ?? 0, exit: run.status, failedFiles };
}

const LIMIT = Number(getArg("limit", 0));
const ONLY_FILES = getArg("files", "").split(",").map((s) => s.trim()).filter(Boolean);
const changedRaw = git("diff", "--name-only", `${FROM}..HEAD`).trim().split("\n")
  .filter((f) => f.startsWith(SCOPE === "server" ? "server/" : "src/"))
  .filter((f) => !/__tests__|[.]test[.]/.test(f))
  .filter((f) => fs.existsSync(f))
  .filter((f) => ONLY_FILES.length === 0 || ONLY_FILES.some((o) => f === o || f.endsWith(`/${o}`)));
const changed = LIMIT > 0 ? changedRaw.slice(0, LIMIT) : changedRaw;

console.log(`范围内 ${changed.length} 个源文件（scope=${SCOPE}）。先取基线…`);
const baseline = runVitest(null);
if (baseline.error || baseline.failed !== 0) {
  console.error("基线就不是全绿，审计结果无法解释。先修好当前 HEAD。", baseline);
  process.exit(3);
}
console.log("基线全绿，开始逐文件还原。\n");

for (const [i, file] of changed.entries()) {
  // 先判"要不要跑"，再动文件。上一版把可达性判断放在 revert 之后却直接 continue，
  // 于是 4 个文件留在还原态被守卫抓到、整轮中止。
  const reach = reachMap[file] ?? [];
  if (SCOPE === "server" || (REACH_FILE && reach.length === 0)) {
    const why = SCOPE === "server" ? "服务端：无 vitest 面，由探针判定" : "★ 无保护（无任何测试可达）";
    record({ file, status: why });
    console.log(`[${i + 1}/${changed.length}] ${file} — ${why}`);
    continue;
  }
  const targets = reach.length ? reach : [`src/${file.split("/")[1] ?? ""}`];

  const patchFile = path.join(outDir, "hunk.patch");
  const diff = git("diff", FROM, "HEAD", "--", file);
  if (!diff.trim()) { record({ file, status: "无 diff" }); continue; }
  fs.writeFileSync(patchFile, diff);

  const applied = spawnSync("git", ["apply", "-R", patchFile], { encoding: "utf8" });
  if (applied.status !== 0) {
    record({ file, status: "无法反向应用（跳过）", detail: (applied.stderr || "").split("\n")[0] });
    console.log(`[${i + 1}/${changed.length}] ${file} — 跳过：无法还原`);
    continue;
  }
  inFlight = file;
  let res = runVitest(targets);
  let stage = reach.length ? `reach(${targets.length})` : "subset";
  if (!res.error && res.failed === 0 && res.exit === 0 && reach.length === 0) {
    res = runVitest(null);
    stage = "full";
  }

  git("restore", "--source=HEAD", "--worktree", "--", file);
  inFlight = null;
  const dirty = git("status", "--porcelain", "-uno").trim();
  if (dirty) {
    console.error(`\n还原失败，工作区仍脏：\n${dirty}\n立即中止，不再产生任何结论。请执行 git restore --source=HEAD --staged --worktree .`);
    record({ file, status: "中止：还原后工作区仍脏" });
    process.exit(4);
  }

  const broken = !res.error && res.failed === 0 && res.exit !== 0;
  const status = res.error
    ? `不确定（${res.error}）`
    : res.failed > 0
      ? "有保护"
      : broken
        ? "不确定（还原后测试跑不起来）"
        : "★ 无保护";
  record({ file, status, stage, failed: res.failed, total: res.total, exit: res.exit, failedFiles: res.failedFiles.slice(0, 12) });
  console.log(`[${i + 1}/${changed.length}] ${file} — ${status}${res.failed > 0 ? ` (${res.failed} 红, ${stage})` : ` (跑了 ${res.total} 条, exit=${res.exit})`}`);
}

console.log(`\n明细：${report}`);
const naked = rows.filter((r) => r.status === "★ 无保护");
console.log(`\n无保护文件 ${naked.length} / ${rows.length}：`);
for (const n of naked) console.log(`  ${n.file}`);
