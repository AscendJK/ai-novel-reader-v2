/**
 * 备份 / 恢复链端到端探针（round 2 批次 2 的 DoD）
 *
 * 覆盖此前零测试、且反复引入 P0 的那条链：
 *   R-02 恢复前快照后的 cleanOldBackups 会删掉用户正选的那份备份
 *   R-03 换库失败时调不存在的 db.open() → 整个后端 exit(1)
 *   R-19 stale WAL/-shm 未清、预检缺失
 *
 * 全部跑在系统临时目录里的副本上，不碰 server/data 下的真实库。
 * 用法：node scripts/probe-backup-restore.mjs   （失败时退出码非 0）
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const repoRoot = path.resolve(scriptDir, "..");
const dbModule = pathToFileURL(path.join(repoRoot, "server", "database.js")).href;
const AGE_MS = 30 * 24 * 60 * 60 * 1000; // 远超默认 retainDays=7

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "anr-backup-probe-"));
const DB_PATH = path.join(workDir, "novels.db");
const BACKUP_DIR = path.join(workDir, "backups");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** 子命令：在独立进程里操作数据库（restoreBackup 会自行 process.exit） */
async function runCase(name, arg) {
  const child = `
    const { spawnSync } = require("node:child_process");
    (async () => {
      const mod = await import(${JSON.stringify(dbModule)});
      const sqlite = mod.db;
      const mode = ${JSON.stringify(name)};
      const arg = ${JSON.stringify(arg ?? null)};
      const put = (title) => sqlite
        .prepare("INSERT OR REPLACE INTO novels (id,title,created_at,updated_at) VALUES (?,?," + Date.now() + "," + Date.now() + ")")
        .run("novel-" + title, title);
      const titles = () => sqlite.prepare("SELECT title FROM novels ORDER BY title").all().map((r) => r.title);

      if (mode === "setup") {
        put("BOOK-ONE");
        const file = await mod.createBackup();
        console.log("BACKUP_FILE=" + file);
        put("BOOK-TWO");            // 让真库比备份多一条，恢复后应只剩 ONE
        console.log("SETUP_OK=" + titles().join(","));
        return 0;
      }
      if (mode === "restore") {
        const before = titles();
        const res = await mod.restoreBackup(arg);
        console.log("RESTORE_MSG=" + res.message);
        console.log("BEFORE_RESTORE=" + before.join(","));
        return 0;                    // 函数自己会 500ms 后 exit(0)
      }
      if (mode === "verify") {
        console.log("AFTER_RESTORE=" + titles().join(","));
        return 0;
      }
      if (mode === "junk") {
        try {
          await mod.restoreBackup(arg);
          console.log("UNEXPECTED_SUCCESS");
        } catch (e) {
          console.log("REJECTED=" + e.message);
          // 关键断言：主库连接没被 close，进程没退出，数据还在
          console.log("STILL_USABLE=" + titles().join(","));
        }
        return 0;
      }
      if (mode === "blocked-swap") {
        try {
          await mod.restoreBackup(arg);
          console.log("UNEXPECTED_SUCCESS");
        } catch (e) {
          console.log("REJECTED=" + e.message);
          console.log("STILL_USABLE=" + titles().join(","));
        }
        return 0;
      }
      throw new Error("unknown case " + mode);
    })().catch((e) => { console.error("CHILD_CRASH=" + (e && e.stack ? e.stack : e)); process.exit(9); });
  `;
  const r = spawnSync(process.execPath, ["-e", child], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NOVEL_READER_DB_PATH: DB_PATH, NOVEL_READER_BACKUP_DIR: BACKUP_DIR },
    timeout: 60000,
  });
  return { out: (r.stdout || "") + (r.stderr || ""), code: r.status };
}

function field(out, key) {
  const m = out.match(new RegExp("^" + key + "=.*$", "m"));
  return m ? m[0].slice(key.length + 1) : null;
}

try {
  // ── 用例 1：备份能创建，且备份内容自洽 ──────────────────────
  const setup = await runCase("setup");
  const backupPathPrinted = field(setup.out, "BACKUP_FILE");
  const backupFile = backupPathPrinted ? path.basename(backupPathPrinted) : null;
  check("createBackup 返回落盘路径", !!backupFile && fs.existsSync(path.join(BACKUP_DIR, backupFile || "")), backupFile || setup.out.slice(0, 200));
  check("备份前主库有两条记录", field(setup.out, "SETUP_OK") === "BOOK-ONE,BOOK-TWO", String(field(setup.out, "SETUP_OK")));

  // ── 用例 2（R-02）：把这份备份"放老"到超出保留期，再恢复它 ──
  // 修复前：restoreBackup 快照后先 cleanOldBackups，会把这份超期备份删掉，
  // 随后 copyFileSync ENOENT → 走 db.open() → TypeError → 进程 exit(1)
  const agedPath = path.join(BACKUP_DIR, backupFile);
  const old = Date.now() - AGE_MS;
  fs.utimesSync(agedPath, new Date(old), new Date(old));
  const restore = await runCase("restore", backupFile);
  check("恢复超期备份不再被清理逻辑删掉（退出码 0）", restore.code === 0, `exit=${restore.code}`);
  check("恢复成功返回提示", (field(restore.out, "RESTORE_MSG") || "").includes("备份已恢复"), String(field(restore.out, "RESTORE_MSG")));
  check("恢复时源备份文件仍在（未被 cleanOldBackups 删除）", fs.existsSync(agedPath));
  const snapshots = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db") && f !== backupFile);
  check("恢复前快照真实落盘", snapshots.length >= 1, snapshots.join(","));
  check("无 .restoring 残留", !fs.existsSync(DB_PATH + ".restoring"));

  // ── 用例 3：恢复确实把数据换成了备份里的样子 ────────────────
  const after = await runCase("verify");
  check("恢复后主库只剩备份里的 BOOK-ONE", field(after.out, "AFTER_RESTORE") === "BOOK-ONE", String(field(after.out, "AFTER_RESTORE")));
  check("恢复后无 stale -wal/-shm", !fs.existsSync(DB_PATH + "-wal") && !fs.existsSync(DB_PATH + "-shm"));

  // ── 用例 4（R-19 预检）：非法文件必须在动主库之前被拒 ───────
  const junkName = "junk.db";
  fs.writeFileSync(path.join(BACKUP_DIR, junkName), "这不是 sqlite 文件");
  const junk = await runCase("junk", junkName);
  check("非本项目的备份被预检拒绝", (field(junk.out, "REJECTED") || "").includes("无法读取"), String(field(junk.out, "REJECTED") || junk.out.slice(0, 160)));
  check("预检失败后主库仍可读写且未退出", field(junk.out, "STILL_USABLE") === "BOOK-ONE", String(field(junk.out, "STILL_USABLE")));

  // ── 用例 5（R-03）：换库阶段失败也不能谎称能"重开" ──────────
  // 用同名目录占住 .restoring，使 copyFileSync 失败（发生在 close 之前）
  const realBackup = fs.readdirSync(BACKUP_DIR).find((f) => f.startsWith("novels-") && f.endsWith(".db"));
  fs.mkdirSync(DB_PATH + ".restoring");
  const blocked = await runCase("blocked-swap", realBackup);
  check("复制阶段失败时明确说明数据库未改动", (field(blocked.out, "REJECTED") || "").includes("未做任何改动"), String(field(blocked.out, "REJECTED") || blocked.out.slice(0, 160)));
  check("失败后进程未退出且库仍可用", blocked.code === 0 && field(blocked.out, "STILL_USABLE") === "BOOK-ONE", `exit=${blocked.code} usable=${field(blocked.out, "STILL_USABLE")}`);
  fs.rmSync(DB_PATH + ".restoring", { recursive: true, force: true });

  // ── 用例 6（R-04）：statfs 字段口径 ─────────────────────────
  const s = fs.statfsSync(workDir);
  const freeBytes = Number(s.bsize) * Number(s.bavail);
  const oldExpr = s.available * s.size;
  check("新实现能算出有限余量", Number.isFinite(freeBytes) && freeBytes > 0, `${Math.round(freeBytes / 1048576)}MB`);
  check("旧实现（available*size）恒为 NaN，即守卫从未生效", Number.isNaN(oldExpr), String(oldExpr));
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n探针结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
