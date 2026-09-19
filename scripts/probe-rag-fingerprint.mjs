/**
 * RAG 索引失效探针（round 2 批次 4 / R-09、R-28）
 *
 * 旧实现里 `status='ready'` 就是一张永久通行证：重传同一本书、改章节内容之后，
 * 服务端仍然把旧向量发给客户端，检索结果与用户读到的文字长期对不上，而且没有任何
 * 自愈路径。现在 rag_indices 带 source_fingerprint，buildIndex 先比对再决定复用。
 *
 * 全程跑在临时目录里的空库上。用法：node scripts/probe-rag-fingerprint.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbModuleUrl = pathToFileURL(path.join(repoRoot, "server", "database.js")).href;
const builderModuleUrl = pathToFileURL(path.join(repoRoot, "server", "rag-builder.js")).href;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "anr-ragfp-probe-"));
const DB_PATH = path.join(workDir, "novels.db");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function out(r) { return (r.stdout || "") + (r.stderr || ""); }
function val(r, key) {
  const m = out(r).match(new RegExp("^" + key + "=.*$", "m"));
  return m ? m[0].slice(key.length + 1) : null;
}

function runChild(body) {
  const src = `
    (async () => {
      const db = await import(${JSON.stringify(dbModuleUrl)});
      const builder = await import(${JSON.stringify(builderModuleUrl)});
      const sqlite = db.db;
      ${body}
      process.exit(0);
    })().catch((e) => { console.error("CHILD_CRASH=" + (e && e.stack ? e.stack : e)); process.exit(9); });
  `;
  return spawnSync(process.execPath, ["-e", src], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 90000,
    env: { ...process.env, NOVEL_READER_DB_PATH: DB_PATH, NOVEL_READER_BACKUP_DIR: path.join(workDir, "backups") },
  });
}

const seed = `
  db.insertNovel({ id: "n1", title: "指纹测试书", author: null, fileName: "n1.txt", fileFormat: "txt",
    totalChars: 100, chapterCount: 2, createdAt: 1, updatedAt: 1 });
  db.insertChapters([
    { id: "n1-ch0", novelId: "n1", index: 0, title: "第一章", content: "甲".repeat(100), startOffset: 0, endOffset: 100 },
    { id: "n1-ch1", novelId: "n1", index: 1, title: "第二章", content: "乙".repeat(100), startOffset: 100, endOffset: 200 },
  ]);
  const ENGINE = "Xenova/bge-small-zh-v1.5";
  // 直接写一行"已就绪"的索引，指纹取当前正文（等价于一次成功构建后的状态）
  const markReady = (dimValue) => {
    sqlite.prepare(\`INSERT OR REPLACE INTO rag_indices
      (novel_id, engine, status, chunks_json, chunk_count, dim, vectors_blob, source_fingerprint, build_time)
      VALUES (?, ?, 'ready', '[]', 2, ?, X'0000', ?, 1)\`)
      .run("n1", ENGINE, dimValue ?? 384, builder.chapterFingerprint("n1"));
  };
`;

try {
  // ── 指纹本身要能区分"没变"和"改了一个字" ─────────────────
  const fp = runChild(`${seed}
    const before = builder.chapterFingerprint("n1");
    sqlite.prepare("UPDATE chapters SET content = ? WHERE id = 'n1-ch1'").run("乙".repeat(101));
    console.log("BEFORE=" + before);
    console.log("AFTER=" + builder.chapterFingerprint("n1"));
    console.log("OTHER=" + builder.chapterFingerprint("nonexistent"));
  `);
  const before = val(fp, "BEFORE"), after = val(fp, "AFTER");
  check("正文改动会被指纹捕捉", !!before && !!after && before !== after, `${before} → ${after}`);
  check("不存在的书不抛异常", val(fp, "OTHER") === "0:0:0", String(val(fp, "OTHER")));

  // ── 指纹一致 → 复用 ready，不重建 ───────────────────────
  const reuse = runChild(`${seed}
    markReady(384);
    const r = builder.buildIndex("n1", ENGINE);
    console.log("STATUS=" + r.status);
    console.log("ROW=" + sqlite.prepare("SELECT status FROM rag_indices WHERE novel_id='n1' AND engine=?").get(ENGINE).status);
  `);
  check("正文未变时仍复用现成索引", val(reuse, "STATUS") === "ready" && val(reuse, "ROW") === "ready",
    `buildIndex=${val(reuse, "STATUS")} row=${val(reuse, "ROW")}`);

  // ── 正文变了 → ready 行必须作废 ─────────────────────────
  const stale = runChild(`${seed}
    markReady(384);
    sqlite.prepare("UPDATE chapters SET content = ? WHERE id = 'n1-ch1'").run("乙".repeat(300));
    const r = builder.buildIndex("n1", ENGINE);
    const row = sqlite.prepare("SELECT status, source_fingerprint FROM rag_indices WHERE novel_id='n1' AND engine=?").get(ENGINE);
    console.log("STATUS=" + r.status);
    console.log("STILLREADY=" + (row && row.status === "ready" && row.source_fingerprint !== builder.chapterFingerprint("n1") ? "yes" : "no"));
    process.exit(0);
  `);
  check("重传/改章后不再返回旧索引", ["queued","building","busy"].includes(val(stale, "STATUS")),
    `buildIndex=${val(stale, "STATUS")} 输出=${out(stale).slice(-200)}`);
  check("过期的 ready 行被作废", val(stale, "STILLREADY") === "no", String(val(stale, "STILLREADY")));

  // ── 老库（无指纹列的旧行）走重建而非永久复用 ─────────────
  const legacy = runChild(`${seed}
    sqlite.prepare(\`INSERT OR REPLACE INTO rag_indices
      (novel_id, engine, status, chunks_json, chunk_count, dim, vectors_blob, build_time)
      VALUES ('n1', ?, 'ready', '[]', 2, 384, X'0000', 1)\`).run(ENGINE);
    const r = builder.buildIndex("n1", ENGINE);
    console.log("STATUS=" + r.status);
  `);
  check("迁移前的旧 ready 行（指纹 NULL）判定为需重建", ["queued","building","busy"].includes(val(legacy, "STATUS")),
    `buildIndex=${val(legacy, "STATUS")}`);

  // ── 迁移：老库缺列时自动补上 ────────────────────────────
  const migrated = runChild(`
    console.log("HASCOL=" + (sqlite.prepare("PRAGMA table_info(rag_indices)").all().some(c => c.name === "source_fingerprint") ? "yes" : "no"));
    console.log("MAPSPK=" + sqlite.prepare("PRAGMA table_info(maps)").all().filter(c => c.pk > 0).map(c => c.name).join(","));
  `);
  check("rag_indices 具备指纹列", val(migrated, "HASCOL") === "yes", String(val(migrated, "HASCOL")));
  check("maps 复合主键在同一迁移里保持完好", val(migrated, "MAPSPK") === "id,username", String(val(migrated, "MAPSPK")));
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n探针结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
