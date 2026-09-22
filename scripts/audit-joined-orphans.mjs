#!/usr/bin/env node
/**
 * R-72 的收尾体检：真库里有没有"书架关系被掏空"的书。
 *
 * 起因（round 3 R-72，已修）：`insertNovel` 原先用 `INSERT OR REPLACE`，同 id 命中等于
 * 先 DELETE 再插，而 `user_novels` / `maps` / `graphs` / `rag_indices` 都挂着
 * `ON DELETE CASCADE` —— 于是"重传同一本书"那一刻会把这本书的**所有书架关系**连带删掉，
 * 路由只重建章节。代码已改成 `ON CONFLICT(id) DO UPDATE`（常驻探针 `probe:novel-reupload`），
 * 但**修不回历史**：在修复之前被重传过的书，那行 `user_novels` 可能早就不在了，
 * 症状是用户那边"我书架上那本书自己不见了"。
 *
 * 这个脚本干三件事：
 *   1. 找出 `novels` 里没有任何 `user_novels` 行的书（孤儿）；
 *   2. 顺手找反向的脏数据（`user_novels` 指向已不存在的书）；
 *   3. 拿 `backups/` 里的历史快照回找孤儿曾经的主人，**只报证据、不写库**。
 *
 * 安全边界（与 `preview-db-migration.mjs` 同口径，而且更严）：
 *   - 真库只以 `readonly: true` 打开，并且只用来做 SQLite 自己的**在线备份**
 *     （`db.backup()`，走 backup API，所以复制到的是一致的瞬间快照；手工 copy 三个文件
 *     在 WAL 模式下会拿到 db 与 wal 不同步的半成品）；
 *   - 所有 SELECT 都跑在临时目录里的那份副本上，真库零写入、零改动；
 *   - 不修数据：修复要 `INSERT INTO user_novels`，那得停应用并由人确认归属，脚本只出报告。
 *
 * 用法：
 *   node scripts/audit-joined-orphans.mjs [--db <真库路径>] [--no-backups] [--keep]
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};
const flag = (name) => argv.includes(`--${name}`);

// 真库位置与后端同源：`server/lib/data-paths.mjs` 认 `NOVEL_READER_DATA_DIR`
const DATA_DIR = path.resolve(
  opt("db") ? path.dirname(path.resolve(opt("db"))) : process.env.NOVEL_READER_DATA_DIR || path.join(REPO, "server", "data"),
);
const SRC = opt("db") ? path.resolve(opt("db")) : path.join(DATA_DIR, "novels.db");

function openReadonly(file) {
  return new Database(file, { readonly: true, fileMustExist: true });
}

function orphansOf(db) {
  const orphans = db
    .prepare(
      `SELECT n.id, n.title, n.file_name, n.chapter_count, n.created_at, n.updated_at
         FROM novels n
         LEFT JOIN user_novels un ON un.novel_id = n.id
        WHERE un.novel_id IS NULL
        ORDER BY n.updated_at DESC`,
    )
    .all();
  const dangling = db
    .prepare(
      `SELECT un.username, un.novel_id
         FROM user_novels un LEFT JOIN novels n ON n.id = un.novel_id
        WHERE n.id IS NULL ORDER BY un.username`,
    )
    .all();
  const totals = db.prepare(`SELECT (SELECT COUNT(*) FROM novels) AS novels,
    (SELECT COUNT(*) FROM user_novels) AS joined, (SELECT COUNT(DISTINCT username) FROM user_novels) AS owners`).get();
  return { orphans, dangling, totals };
}

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`[体检] 找不到库文件：${SRC}\n     （用 --db <路径> 指定，或设 NOVEL_READER_DATA_DIR）`);
    process.exitCode = 1;
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anr-orphan-audit-"));
  const copy = path.join(tmp, "copy.db");
  console.log(`[体检] 真库：${SRC}`);
  console.log(`[体检] 只读打开并做在线备份 → ${copy}（真库不写一个字节）`);

  const src = openReadonly(SRC);
  await src.backup(copy);
  src.close();

  const db = openReadonly(copy);
  const now = orphansOf(db);
  const novels = db.prepare(`SELECT COUNT(*) AS c FROM novels`).get().c;
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => r.name);
  db.close();

  console.log(`\n=== 现状（${novels} 本书 / ${now.totals.joined} 行书架关系 / ${now.totals.owners} 个主人）===`);
  console.log(`表：${tables.join(", ")}`);

  if (now.orphans.length === 0) {
    console.log("孤儿书：0 本 —— R-72 没有留下历史欠账，这条可以划掉了。");
  } else {
    console.log(`\n=== 孤儿书 ${now.orphans.length} 本（在 novels 里，但没有任何人 join）===`);
    for (const o of now.orphans) {
      const when = new Date(o.updated_at || 0).toISOString().slice(0, 19).replace("T", " ");
      console.log(`  ${o.id.slice(0, 8)}  「${o.title}」  ${o.chapter_count} 章  最后更新 ${when}`);
    }
  }
  if (now.dangling.length > 0) {
    console.log(`\n=== 反向脏数据：${now.dangling.length} 行 user_novels 指向已不存在的书 ===`);
    for (const d of now.dangling.slice(0, 20)) console.log(`  ${d.username} → ${d.novel_id.slice(0, 8)}`);
    if (now.dangling.length > 20) console.log(`  …另外 ${now.dangling.length - 20} 行`);
  }

  // 回找主人：历史快照里这些书有 join 行的，就是证据
  let candidates = [];
  if (now.orphans.length > 0 && !flag("no-backups")) {
    const bakDir = path.join(DATA_DIR, "backups");
    const snaps = fs.existsSync(bakDir)
      ? fs
          .readdirSync(bakDir)
          .filter((f) => /\.(db|sqlite|sqlite3)$/.test(f) || /novels/.test(f))
          .map((f) => ({ file: path.join(bakDir, f), mtime: fs.statSync(path.join(bakDir, f)).mtimeMs }))
          .sort((a, b) => a.mtime - b.mtime)
      : [];
    console.log(`\n=== 从 ${snaps.length} 份历史快照回找孤儿的主人（只读，不写回）===`);
    if (snaps.length === 0) console.log(`  没找到快照目录或里面没有库文件：${bakDir}`);
    const ids = now.orphans.map((o) => o.id);
    for (const s of snaps) {
      let sdb;
      try {
        sdb = openReadonly(s.file);
      } catch (e) {
        console.log(`  ${path.basename(s.file)}：打不开（${e.message}），跳过`);
        continue;
      }
      const hit = [];
      try {
        for (const id of ids) {
          const rows = sdb.prepare(`SELECT username FROM user_novels WHERE novel_id = ?`).all(id);
          for (const r of rows) hit.push({ id, username: r.username });
        }
      } catch (e) {
        console.log(`  ${path.basename(s.file)}：查不了（${e.message}）`);
      }
      sdb.close();
      const when = new Date(s.mtime).toISOString().slice(0, 19).replace("T", " ");
      console.log(`  ${path.basename(s.file)}（${when}）：${hit.length ? `${hit.length} 条 join 证据` : "无"}`);
      for (const h of hit) {
        const o = now.orphans.find((x) => x.id === h.id);
        console.log(`     快照里「${o?.title ?? h.id.slice(0, 8)}」的主人是 ${h.username}`);
        candidates.push({ ...h, title: o?.title ?? "", snapshot: path.basename(s.file) });
      }
    }
  }

  const covered = new Set(candidates.map((c) => c.id));
  const unresolved = now.orphans.filter((o) => !covered.has(o.id));
  if (now.orphans.length > 0) {
    console.log(`\n=== 结论 ===`);
    console.log(`  有快照证据、可以接回的：${candidates.length} 本`);
    console.log(`  没有任何证据、需要你亲自认的：${unresolved.length} 本`);
    for (const o of unresolved) console.log(`     ${o.id}  「${o.title}」（${o.chapter_count} 章）`);
    if (candidates.length > 0) {
      console.log(`\n  要接回的话（**先停应用**，再拿这份清单逐条核对）：`);
      const sample = candidates[0];
      console.log(`    INSERT OR IGNORE INTO user_novels (username, novel_id, added_at) VALUES ('${sample.username}', '${sample.id}', ${Date.now()});`);
      console.log(`    （其余各条同形；这份脚本不替你写库。）`);
    }
  }
  if (flag("keep")) console.log(`\n副本留在 ${copy}（--keep）`);
  else fs.rmSync(tmp, { recursive: true, force: true });
}

await main();
