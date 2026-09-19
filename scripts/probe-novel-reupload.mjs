/**
 * 同 id 二次上传不得删掉派生数据（round 3 批次 A / R-72）
 *
 * 症状：`insertNovel` 用 `INSERT OR REPLACE`，在 `foreign_keys = ON` 下命中同 id 会先
 * DELETE 再 INSERT，于是 `chapters / user_novels / rag_indices / maps / graphs` 五张
 * `ON DELETE CASCADE` 的子表被一起清掉。上传路由随后只重建章节，所以**共享关系、地图、
 * 人物关系图、服务端 RAG 索引没有任何重建路径**——别人书架上这本书会直接消失。
 * 自动触发器是同步侧的孤儿补传（`useSyncOrchestration.ts handleOrphaned`）与登录补传，
 * 它们都拿客户端 id 再 POST 一次。
 *
 * 断言的是"重传之后派生数据还在、元数据以后到的为准、created_at 不被改写"，
 * 而不是某条 SQL 的写法。全程只在系统临时目录建库，不触碰 server/data 下的真实库。
 *
 * 用法：node scripts/probe-novel-reupload.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "anr-reupload-probe-"));
const DB_PATH = path.join(workDir, "novels.db");
const dbModuleUrl = pathToFileURL(path.join(repoRoot, "server", "database.js")).href;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// 一次"上传"= 路由里对 db 的那两次调用（novels.js: insertNovel → insertChapters）
// createdAt 由客户端带来：重传时它可能与库里已存的值不同，用来验"created_at 不被改写"
const UPLOAD = `
  const upload = (title, updatedAt, createdAt) => {
    mod.insertNovel({
      id: "book-1", title, author: "作者", fileName: "book.txt", fileFormat: "txt",
      totalChars: 20, chapterCount: 2, createdAt, updatedAt,
    });
    mod.insertChapters([
      { id: "book-1-ch0", novelId: "book-1", index: 0, title: "第一章", content: "aa", startOffset: 0, endOffset: 2 },
      { id: "book-1-ch1", novelId: "book-1", index: 1, title: "第二章", content: "bb", startOffset: 2, endOffset: 4 },
    ]);
  };
`;

const CHILD = `
  (async () => {
    const mod = await import(${JSON.stringify(dbModuleUrl)});
    const sqlite = mod.db;
    const count = (sql, ...a) => sqlite.prepare(sql).get(...a).c;
    ${UPLOAD}

    // ── 首传：两个人加入书架，并各自产出派生数据 ──
    upload("书（首传）", 100, 1000);
    mod.joinNovel("alice", "book-1");
    mod.joinNovel("bob", "book-1");
    mod.upsertMap({ id: "map-1", novelId: "book-1", username: "alice", data: JSON.stringify({ places: ["酒馆"] }), createdAt: 1, updatedAt: 1, deleted: 0 });
    mod.upsertGraph({ id: "graph-1", novelId: "book-1", username: "alice", data: JSON.stringify({ nodes: ["甲"] }), createdAt: 1, updatedAt: 1, deleted: 0 });
    sqlite.prepare("INSERT INTO rag_indices (novel_id, engine, status, chunks_json, chunk_count, source_fingerprint) VALUES ('book-1','tfidf','ready','[]',3,'fp-1')").run();
    mod.upsertSummary({ id: "sum-1", novelId: "book-1", chapterId: "book-1-ch0", chapterTitle: "第一章", content: "第一章的总结", tokensUsed: 5, createdAt: 1, updatedAt: 1, type: "chapter", username: "alice" });

    const before = {
      chapters: count("SELECT COUNT(*) c FROM chapters"),
      members: count("SELECT COUNT(*) c FROM user_novels"),
      maps: count("SELECT COUNT(*) c FROM maps"),
      graphs: count("SELECT COUNT(*) c FROM graphs"),
      rag: count("SELECT COUNT(*) c FROM rag_indices"),
    };

    // ── 二次上传（孤儿补传就是这个形状：同 id 再入库一次） ──
    upload("书（重传）", 200, 7777);
    const after = {
      chapters: count("SELECT COUNT(*) c FROM chapters"),
      members: count("SELECT COUNT(*) c FROM user_novels"),
      maps: count("SELECT COUNT(*) c FROM maps"),
      graphs: count("SELECT COUNT(*) c FROM graphs"),
      rag: count("SELECT COUNT(*) c FROM rag_indices"),
    };
    const members = sqlite.prepare("SELECT username FROM user_novels WHERE novel_id='book-1' ORDER BY username").all().map((r) => r.username);
    const mapData = (mod.getMaps("alice", "book-1")[0] || {}).data;
    const summarySurvives = count("SELECT COUNT(*) c FROM summaries");

    // ── 第三次：幂等，不得"第一次重传删、第二次不删" ──
    upload("书（再传）", 300, 8888);
    const third = {
      members: count("SELECT COUNT(*) c FROM user_novels"),
      maps: count("SELECT COUNT(*) c FROM maps"),
      rag: count("SELECT COUNT(*) c FROM rag_indices"),
    };
    const novel = mod.getNovel("book-1");

    console.log("RESULT=" + JSON.stringify({
      before, after, third, members, mapData, summarySurvives,
      title: novel && novel.title, createdAt: novel && novel.createdAt, updatedAt: novel && novel.updatedAt,
    }));
    process.exit(0);
  })().catch((e) => { console.error("CHILD_CRASH=" + (e && e.stack ? e.stack : e)); process.exit(9); });
`;

let parsed = null;
try {
  const r = spawnSync(process.execPath, ["-e", CHILD], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, NOVEL_READER_DB_PATH: DB_PATH, NOVEL_READER_BACKUP_DIR: path.join(workDir, "backups") },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const line = out.match(/^RESULT=(.*)$/m);
  if (line) parsed = JSON.parse(line[1]);
  check("补传链路全程不抛错", r.status === 0, out.replace(/\s+/g, " ").slice(0, 180));
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}

if (!parsed) {
  console.log("\n探针结果：0/1 通过（子进程没给出数据，按失败算）");
  process.exit(1);
}

const { before, after, third, members, mapData, summarySurvives, title, createdAt, updatedAt } = parsed;
check("前置条件：首传后五张表都有数据", before.chapters === 2 && before.members === 2 && before.maps === 1 && before.graphs === 1 && before.rag === 1,
  JSON.stringify(before));
check("重传后两位成员的书架关系都还在", after.members === 2 && members.join(",") === "alice,bob", `user_novels=${after.members} [${members.join(",")}]`);
check("重传后 alice 的地图还在（内容未变）", after.maps === 1 && mapData === JSON.stringify({ places: ["酒馆"] }), `maps=${after.maps} data=${mapData}`);
check("重传后人物关系图还在", after.graphs === 1, `graphs=${after.graphs}`);
check("重传后服务端 RAG 索引还在", after.rag === 1, `rag_indices=${after.rag}`);
check("重传后章节仍可正常读到", after.chapters === 2, `chapters=${after.chapters}`);
check("第三次重传同样不删派生数据（幂等）", third.members === 2 && third.maps === 1 && third.rag === 1, JSON.stringify(third));
check("元数据以后到那次为准（正文重传生效）", title === "书（再传）" && updatedAt === 300, `title=${title} updatedAt=${updatedAt}`);
check("created_at 不被重传改写", createdAt === 1000, `createdAt=${createdAt}`);
check("无 FK 级联的 summaries 不受影响", summarySurvives === 1, `summaries=${summarySurvives}`);

const failed = results.filter((x) => !x.ok);
console.log(`\n探针结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
