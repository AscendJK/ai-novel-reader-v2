#!/usr/bin/env node
/**
 * 真库迁移预演：只在**副本**上跑一次真实迁移，打印迁移前后的差异。
 *
 * 为什么需要它：maps/graphs 的主键从 `id` 改成 `(id, username)`、rag_indices 增加
 * `source_fingerprint` 列，都发生在 `server/database.js` 的 import 期——也就是
 * "后端第一次被启动"的那一刻。这两条是有去无回的：迁移后的表没有单列 `id` 的
 * 唯一约束，旧版后端的 `ON CONFLICT(id)` 在上面写不进去，所以"试一下不行就退回
 * 旧版"必须靠冷拷贝才成立。
 *
 * 安全边界：脚本只 **read** 真库文件（copyFileSync），从不用 better-sqlite3 打开真库；
 * 所有 SQL 都跑在临时目录里的副本上，跑完删除（--keep 保留）。真库文件本身零改动。
 *
 * 用法：
 *   npm run preview:migration
 *   node scripts/preview-db-migration.mjs [--db <真库路径>] [--keep]
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
};

const SRC = path.resolve(opt("db") || path.join(REPO, "server", "data", "novels.db"));

/** 表级"事实"：结构 + 行数 + 每用户行数 + 行内容指纹（证明迁移没丢行、没改行） */
const TABLES = ["novels", "chapters", "summaries", "notes", "maps", "graphs", "rag_indices", "reading_progress", "users"];

/** 本次迁移会新增的列：行指纹要比对"迁移前后都存在的那些列"，否则新增列本身就成了假警报 */
const ADDED_BY_MIGRATION = new Set(["source_fingerprint"]);

function digest(rows) {
  // djb2 就够：这里要的是"变没变"，不是抗碰撞
  let h = 5381;
  const s = JSON.stringify(rows);
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** 主键列：用 PRAGMA table_info 的 pk 序号（列级 `id TEXT PRIMARY KEY` 也认，
 *  之前只匹配表级 `PRIMARY KEY (...)` 会把 novels/users 报成"无显式 PK"） */
function pkColumns(db, table) {
  const ordered = db.prepare(`PRAGMA table_info(${table})`).all()
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  return ordered.length ? ordered.join(",") : "(无主键)";
}

function collectFacts(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const out = { integrity: "?", tables: {} };
  try {
    out.integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "?";
    for (const t of TABLES) {
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (!exists) continue;
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      const count = db.prepare(`SELECT count(*) AS c FROM ${t}`).get().c;
      // 固定比对列：排除本次迁移新增的列，使前后两次指纹可直接相等比较
      const stableCols = cols.filter((c) => !ADDED_BY_MIGRATION.has(c));
      const selectList = stableCols.map((c) => `"${c}"`).join(", ");
      let perUser = "-";
      if (cols.includes("username")) {
        perUser = digest(db.prepare(`SELECT username AS u, count(*) AS c FROM ${t} GROUP BY username ORDER BY u`).all());
      }
      const rowDigest = digest(db.prepare(`SELECT ${selectList} FROM ${t} ORDER BY 1`).all());
      out.tables[t] = {
        cols,
        count,
        perUser,
        rowDigest,
        pk: pkColumns(db, t),
      };
    }
    // 迁移后 ready 行没有指纹 = 下次构建请求会重建一次（安全方向，但要提前知道）
    if (out.tables.rag_indices && out.tables.rag_indices.cols.includes("source_fingerprint")) {
      out.readyNoFingerprint = db.prepare(
        "SELECT count(*) AS c FROM rag_indices WHERE status='ready' AND source_fingerprint IS NULL"
      ).get().c;
    }
    if (out.tables.rag_indices) {
      out.readyTotal = db.prepare("SELECT count(*) AS c FROM rag_indices WHERE status='ready'").get().c;
    }
  } finally {
    db.close();
  }
  return out;
}

function pad(s, n) {
  return String(s).padEnd(n, " ");
}

function diff(before, after) {
  const lines = [];
  let regressions = 0;
  for (const t of Object.keys(before.tables)) {
    const b = before.tables[t];
    const a = after.tables[t];
    if (!a) { lines.push(`  ${t}: 迁移后表消失！`); regressions++; continue; }
    const same = b.count === a.count && b.rowDigest === a.rowDigest && b.perUser === a.perUser;
    lines.push(
      `  ${pad(t, 18)}行数 ${pad(`${b.count} → ${a.count}`, 16)} ` +
      `行内容 ${same ? "未变" : "★ 变了"}  主键 (${b.pk}) → (${a.pk})` +
      (b.cols.join(",") === a.cols.join(",") ? "" : `  列新增: ${a.cols.filter((c) => !b.cols.includes(c)).join(",")}`)
    );
    if (!same) regressions++;
    if (b.cols.join(",") !== a.cols.join(",") && a.cols.filter((c) => !b.cols.includes(c)).length === 0) regressions++;
  }
  return { lines, regressions };
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`找不到数据库文件：${SRC}\n（首次运行还没有真库时不需要预演：全新库直接按新 schema 建表。）`);
    process.exit(2);
  }
  const srcSize = fs.statSync(SRC).size;
  const walPath = SRC + "-wal";
  const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;

  console.log(`源库：${SRC}（${(srcSize / 1048576).toFixed(1)}MB，WAL ${walSize}B）`);
  if (walSize > 0) {
    console.warn("⚠️  WAL 非空：后端此刻可能正在写库。请先停服（stop.bat / stop.sh）再跑，否则副本可能不一致。");
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anr-migration-preview-"));
  const copy = path.join(tmpRoot, "novels.db");
  const t0 = Date.now();
  fs.copyFileSync(SRC, copy);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(SRC + suffix) && fs.statSync(SRC + suffix).size > 0) fs.copyFileSync(SRC + suffix, copy + suffix);
  }
  console.log(`副本：${copy}（拷贝耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）\n`);

  let before;
  try {
    before = collectFacts(copy);
  } catch (e) {
    console.error(`副本打开失败（integrity=${before?.integrity ?? "?"}）：${e.message}`);
    console.error("→ 多半是拷贝时后端正在写库。停服后重试。");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(2);
  }
  console.log(`副本完整性检查（迁移前）：${before.integrity}`);
  console.log(`已就绪索引：${before.readyTotal ?? 0} 条，其中无指纹（迁移后首次构建会重建）：${before.readyNoFingerprint ?? 0} 条\n`);

  // 迁移发生在 server/database.js 的 import 期；用子进程跑，父进程不碰那个模块
  console.log("在副本上执行迁移（import server/database.js）...");
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(path.join(REPO, "server", "database.js")).href)});`],
    { env: { ...process.env, NOVEL_READER_DB_PATH: copy }, stdio: "inherit" }
  );
  if (child.status !== 0) {
    console.error(`迁移子进程退出码 ${child.status} —— 不要在真库上执行，先查这里的报错。`);
    if (!flag("keep")) fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(1);
  }

  const after = collectFacts(copy);
  console.log(`\n副本完整性检查（迁移后）：${after.integrity}`);
  console.log("\n迁移前后对比：");
  const { lines, regressions } = diff(before, after);
  for (const l of lines) console.log(l);

  const mapsPk = after.tables.maps?.pk ?? "";
  const graphsPk = after.tables.graphs?.pk ?? "";
  const structuralOk =
    /id,username/i.test(mapsPk) && /id,username/i.test(graphsPk) &&
    (after.tables.rag_indices?.cols ?? []).includes("source_fingerprint");

  console.log("\n结论：");
  console.log(`  maps 主键 = (${mapsPk})  graphs 主键 = (${graphsPk})  rag_indices 含 source_fingerprint = ${(after.tables.rag_indices?.cols ?? []).includes("source_fingerprint")}`);
  console.log(`  结构迁移${structuralOk ? "已生效" : "★ 未生效"}；行数/行内容差异 ${regressions} 处；完整性 ${after.integrity === "ok" ? "ok" : after.integrity}`);

  if (flag("keep")) {
    console.log(`\n副本已保留：${copy}`);
  } else {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    console.log("\n副本已删除（--keep 可保留下来自己查）。真库全程未被打开或写入。");
  }

  const clean = structuralOk && regressions === 0 && after.integrity === "ok";
  console.log(clean
    ? "\n预演通过：可以放心在真库上首次启动。仍建议先冷拷贝一份（停服 → 复制 novels.db*），因为迁移不可逆。"
    : "\n预演未通过：不要直接对真库启动，把上面的差异发给我。");
  process.exit(clean ? 0 : 1);
}

main();
