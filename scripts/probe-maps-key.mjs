/**
 * maps/graphs 主键迁移探针（round 2 批次 1 / R-05）
 *
 * 在系统临时目录里造一个"旧结构"（maps/graphs 主键只有 id）的库，插入数据后
 * 让 database.js 的迁移逻辑接管，验证：
 *   1. 旧行原样保留（内容、username、行数都不丢）
 *   2. 迁移后主键变成 (id, username)——两个用户共读同一本书时能各存一份
 *   3. 迁移可重复执行（幂等），二次导入不报错也不改数据
 *   4. 同一用户的 upsert 仍按 updatedAt 做最后写入胜出
 * 全程不触碰 server/data 下的真实库。
 *
 * 用法：node scripts/probe-maps-key.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "anr-mapskey-probe-"));
const DB_PATH = path.join(workDir, "novels.db");
const dbModuleUrl = pathToFileURL(path.join(repoRoot, "server", "database.js")).href;
const createReq = createRequire(path.join(repoRoot, "package.json"));
const Database = createReq("better-sqlite3");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── 1. 造旧结构库（与 v2.3.0 的 schema 一致：id 单列主键） ─────
const OLD_SCHEMA = `
  CREATE TABLE novels (id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT, file_name TEXT,
    file_format TEXT DEFAULT 'txt', total_chars INTEGER DEFAULT 0, chapter_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
  CREATE TABLE chapters (id TEXT PRIMARY KEY, novel_id TEXT NOT NULL, index_num INTEGER NOT NULL,
    title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', start_offset INTEGER DEFAULT 0,
    end_offset INTEGER DEFAULT 0, FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE);
  CREATE TABLE summaries (id TEXT PRIMARY KEY, novel_id TEXT NOT NULL, chapter_id TEXT, chapter_title TEXT,
    username TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', tokens_used INTEGER DEFAULT 0,
    created_at INTEGER, type TEXT DEFAULT 'chapter', updated_at INTEGER, deleted INTEGER DEFAULT 0,
    used_fallback INTEGER DEFAULT 0);
  CREATE TABLE notes (id TEXT PRIMARY KEY, novel_id TEXT NOT NULL, chapter_id TEXT, chapter_title TEXT,
    username TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', source TEXT DEFAULT 'user',
    source_label TEXT, created_at INTEGER, updated_at INTEGER, deleted INTEGER DEFAULT 0);
  CREATE TABLE maps (id TEXT PRIMARY KEY, novel_id TEXT NOT NULL, username TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}', created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0, FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE);
  CREATE TABLE graphs (id TEXT PRIMARY KEY, novel_id TEXT NOT NULL, username TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}', created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0, FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE);
`;

function buildOldDb() {
  const d = new Database(DB_PATH);
  d.exec(OLD_SCHEMA);
  d.prepare("INSERT INTO novels (id,title,created_at,updated_at) VALUES ('novel-1','共享的书',1,1)").run();
  // 旧结构下同一本书全库只能存一份地图：这就是 R-05 的表现
  d.prepare("INSERT INTO maps (id,novel_id,username,data,created_at,updated_at) VALUES ('novel-1','novel-1','alice','{\"places\":[\"酒馆\"]}',1,500)").run();
  d.prepare("INSERT INTO graphs (id,novel_id,username,data,created_at,updated_at) VALUES ('novel-1','novel-1','alice','{\"nodes\":[\"甲\"]}',1,500)").run();
  d.close();
}

// ── 子进程：导入 database.js（触发迁移）并做后续断言 ───────────
function runChild(body) {
  const src = `
    (async () => {
      const mod = await import(${JSON.stringify(dbModuleUrl)});
      const sqlite = mod.db;
      ${body}
      process.exit(0);
    })().catch((e) => { console.error("CHILD_CRASH=" + (e && e.stack ? e.stack : e)); process.exit(9); });
  `;
  return spawnSync(process.execPath, ["-e", src], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, NOVEL_READER_DB_PATH: DB_PATH, NOVEL_READER_BACKUP_DIR: path.join(workDir, "backups") },
  });
}

function out(r) { return (r.stdout || "") + (r.stderr || ""); }
function val(r, key) {
  const m = out(r).match(new RegExp("^" + key + "=.*$", "m"));
  return m ? m[0].slice(key.length + 1) : null;
}

try {
  buildOldDb();

  // ── 迁移并检查结构 ──────────────────────────────────────
  const first = runChild(`
    const pkCols = (t) => sqlite.prepare("PRAGMA table_info(" + t + ")").all().filter((c) => c.pk > 0).map((c) => c.name + ":" + c.pk).join(",");
    console.log("MAPS_PK=" + pkCols("maps"));
    console.log("GRAPHS_PK=" + pkCols("graphs"));
    console.log("MAP_ROWS=" + sqlite.prepare("SELECT count(*) c FROM maps").get().c);
    console.log("ALICE_MAP=" + JSON.stringify(sqlite.prepare("SELECT data,username FROM maps WHERE username='alice' AND novel_id='novel-1'").get()));
    console.log("LEFTOVER=" + sqlite.prepare("SELECT count(*) c FROM sqlite_master WHERE name LIKE '%__new'").get().c);
  `);
  check("迁移把 maps 主键改为 (id, username)", val(first, "MAPS_PK") === "id:1,username:2", String(val(first, "MAPS_PK")));
  check("迁移把 graphs 主键改为 (id, username)", val(first, "GRAPHS_PK") === "id:1,username:2", String(val(first, "GRAPHS_PK")));
  check("旧数据行数不变", val(first, "MAP_ROWS") === "1", String(val(first, "MAP_ROWS")));
  check("旧行的内容与归属保持不变", val(first, "ALICE_MAP") === '{"data":"{\\"places\\":[\\"酒馆\\"]}","username":"alice"}', String(val(first, "ALICE_MAP")));
  check("迁移不留 __new 残表", val(first, "LEFTOVER") === "0", String(val(first, "LEFTOVER")));
  check("迁移过程本身无异常", first.status === 0, out(first).slice(0, 200));

  // ── 核心行为：两个用户共读同一本书，各存一份互不覆盖 ───────
  const both = runChild(`
    mod.upsertMap({ id: "novel-1", novelId: "novel-1", username: "bob", data: JSON.stringify({ places: ["铁匠铺"] }), createdAt: 2, updatedAt: 600 });
    mod.upsertGraph({ id: "novel-1", novelId: "novel-1", username: "bob", data: JSON.stringify({ nodes: ["乙"] }), createdAt: 2, updatedAt: 600 });
    const a = mod.getMaps("alice", "novel-1");
    const b = mod.getMaps("bob", "novel-1");
    console.log("ALICE=" + (a[0] ? a[0].data : "none"));
    console.log("BOB=" + (b[0] ? b[0].data : "none"));
    console.log("GA=" + mod.getGraphs("alice", "novel-1").length);
    console.log("GB=" + mod.getGraphs("bob", "novel-1").length);
    // LWW：alice 用更旧的 updatedAt 覆写必须失败
    mod.upsertMap({ id: "novel-1", novelId: "novel-1", username: "alice", data: "STALE", createdAt: 1, updatedAt: 100 });
    console.log("AFTER_STALE=" + mod.getMaps("alice", "novel-1")[0].data);
    mod.upsertMap({ id: "novel-1", novelId: "novel-1", username: "alice", data: "NEWER", createdAt: 1, updatedAt: 9999 });
    console.log("AFTER_FRESH=" + mod.getMaps("alice", "novel-1")[0].data);
  `);
  check("bob 存地图不再覆盖 alice 的", (val(both, "ALICE") || "").includes("酒馆") && (val(both, "BOB") || "").includes("铁匠铺"),
    `alice=${val(both, "ALICE")} bob=${val(both, "BOB")}`);
  check("两人各有一份 graphs", val(both, "GA") === "1" && val(both, "GB") === "1", String(val(both, "GA")) + "/" + String(val(both, "GB")));
  check("同一用户仍按 updatedAt 做最后写入胜出", val(both, "AFTER_STALE") === '{"places":["酒馆"]}' && val(both, "AFTER_FRESH") === "NEWER",
    `${val(both, "AFTER_STALE")} / ${val(both, "AFTER_FRESH")}`);
  check("双用户写入过程无异常", both.status === 0, out(both).slice(0, 200));

  // ── 幂等：再次导入不得重复迁移或改数据 ───────────────────
  const second = runChild(`
    console.log("ROWS=" + sqlite.prepare("SELECT count(*) c FROM maps").get().c);
    console.log("BOB_STILL=" + (mod.getMaps("bob", "novel-1")[0] || {}).updated_at);
  `);
  check("重复启动不改变数据", val(second, "ROWS") === "2", String(val(second, "ROWS")));
  check("bob 的数据在二次启动后仍在", val(second, "BOB_STILL") === "600", String(val(second, "BOB_STILL")));
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n探针结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
