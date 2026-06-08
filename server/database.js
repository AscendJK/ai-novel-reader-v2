import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = path.join(__dirname, "data", "novels.db");

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("defensive = ON");
export { db };

// ── Schema ──────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS novels (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    file_name TEXT,
    file_format TEXT DEFAULT 'txt',
    total_chars INTEGER DEFAULT 0,
    chapter_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY,
    novel_id TEXT NOT NULL,
    index_num INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    start_offset INTEGER DEFAULT 0,
    end_offset INTEGER DEFAULT 0,
    FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_chapters_novel ON chapters(novel_id, index_num);

  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    created_at INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS user_novels (
    username TEXT NOT NULL,
    novel_id TEXT NOT NULL,
    added_at INTEGER DEFAULT 0,
    PRIMARY KEY (username, novel_id),
    FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reading_progress (
    username TEXT NOT NULL,
    novel_id TEXT NOT NULL,
    chapter_id TEXT,
    chapter_index INTEGER DEFAULT 0,
    last_opened INTEGER DEFAULT 0,
    PRIMARY KEY (username, novel_id)
  );

  CREATE TABLE IF NOT EXISTS summaries (
    id TEXT PRIMARY KEY,
    novel_id TEXT NOT NULL,
    chapter_id TEXT,
    chapter_title TEXT,
    username TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    tokens_used INTEGER DEFAULT 0,
    created_at INTEGER,
    type TEXT DEFAULT 'chapter'
  );
  CREATE INDEX IF NOT EXISTS idx_summaries_novel_user ON summaries(novel_id, username, type);

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    novel_id TEXT NOT NULL,
    chapter_id TEXT,
    chapter_title TEXT,
    username TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    source TEXT DEFAULT 'user',
    source_label TEXT,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_notes_novel_user ON notes(novel_id, username, chapter_id);

  CREATE TABLE IF NOT EXISTS user_settings (
    username TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (username, key)
  );

  CREATE TABLE IF NOT EXISTS rag_indices (
    novel_id TEXT NOT NULL,
    engine TEXT NOT NULL DEFAULT 'bge-small-zh',
    status TEXT NOT NULL DEFAULT 'none',
    chunks_json TEXT NOT NULL DEFAULT '[]',
    vectors_blob BLOB,
    dim INTEGER DEFAULT 0,
    chunk_count INTEGER DEFAULT 0,
    build_time INTEGER DEFAULT 0,
    error_msg TEXT,
    PRIMARY KEY (novel_id, engine),
    FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
  );
`);

// ── Migration: add updated_at to summaries/notes ──────────
try { db.exec("ALTER TABLE summaries ADD COLUMN updated_at INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE notes ADD COLUMN updated_at INTEGER DEFAULT 0"); } catch {}
db.exec("UPDATE summaries SET updated_at = created_at WHERE updated_at = 0");
db.exec("UPDATE notes SET updated_at = created_at WHERE updated_at = 0");

// ── Migration: add deleted flag to notes (soft delete) ────
try { db.exec("ALTER TABLE notes ADD COLUMN deleted INTEGER DEFAULT 0"); } catch {}

// ── Migration: add deleted/used_fallback to summaries ─────
try { db.exec("ALTER TABLE summaries ADD COLUMN deleted INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE summaries ADD COLUMN used_fallback INTEGER DEFAULT 0"); } catch {}

// ── Migration: add maps table ────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS maps (
    id TEXT PRIMARY KEY,
    novel_id TEXT NOT NULL,
    username TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0,
    FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_maps_novel_user ON maps(novel_id, username);
`);

// ── Migration: add graphs table (character graph, per-user) ──
db.exec(`
  CREATE TABLE IF NOT EXISTS graphs (
    id TEXT PRIMARY KEY,
    novel_id TEXT NOT NULL,
    username TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0,
    FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_graphs_novel_user ON graphs(novel_id, username);
`);

// ── Prepared statements ─────────────────────────────────────

// ── Novels (shared library) ──

export function insertNovel(novel) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO novels (id, title, author, file_name, file_format, total_chars, chapter_count, created_at, updated_at)
    VALUES (@id, @title, @author, @fileName, @fileFormat, @totalChars, @chapterCount, @createdAt, @updatedAt)
  `);
  return stmt.run(novel);
}

export function insertChapters(chapters) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO chapters (id, novel_id, index_num, title, content, start_offset, end_offset)
    VALUES (@id, @novelId, @index, @title, @content, @startOffset, @endOffset)
  `);
  const tx = db.transaction((chaps) => {
    for (const c of chaps) stmt.run(c);
  });
  tx(chapters);
}

export function listNovels() {
  return db.prepare(`
    SELECT id, title, author, file_name AS \"fileName\", file_format AS \"fileFormat\",
           total_chars AS \"totalChars\", chapter_count AS \"chapterCount\",
           created_at AS \"createdAt\", updated_at AS \"updatedAt\"
    FROM novels ORDER BY updated_at DESC
  `).all();
}

export function getNovel(novelId) {
  return db.prepare(`
    SELECT id, title, author, file_name AS \"fileName\", file_format AS \"fileFormat\",
           total_chars AS \"totalChars\", chapter_count AS \"chapterCount\",
           created_at AS \"createdAt\", updated_at AS \"updatedAt\"
    FROM novels WHERE id = ?
  `).get(novelId);
}

export function getChapterList(novelId) {
  return db.prepare(`
    SELECT id, novel_id AS \"novelId\", index_num AS \"index\", title,
           start_offset AS \"startOffset\", end_offset AS \"endOffset\"
    FROM chapters WHERE novel_id = ? ORDER BY index_num
  `).all(novelId);
}

export function getAllChapters(novelId) {
  return db.prepare(`
    SELECT id, novel_id AS \"novelId\", index_num AS \"index\", title, content,
           start_offset AS \"startOffset\", end_offset AS \"endOffset\"
    FROM chapters WHERE novel_id = ? ORDER BY index_num
  `).all(novelId);
}

export function getChapter(novelId, indexNum) {
  return db.prepare(`
    SELECT id, novel_id AS \"novelId\", index_num AS \"index\", title, content,
           start_offset AS \"startOffset\", end_offset AS \"endOffset\"
    FROM chapters WHERE novel_id = ? AND index_num = ?
  `).get(novelId, indexNum);
}

export function deleteNovel(novelId) {
  db.transaction(() => {
    db.prepare("DELETE FROM user_novels WHERE novel_id = ?").run(novelId);
    db.prepare("DELETE FROM summaries WHERE novel_id = ?").run(novelId);
    db.prepare("DELETE FROM notes WHERE novel_id = ?").run(novelId);
    db.prepare("DELETE FROM maps WHERE novel_id = ?").run(novelId);
    db.prepare("DELETE FROM graphs WHERE novel_id = ?").run(novelId);
    db.prepare("DELETE FROM reading_progress WHERE novel_id = ?").run(novelId);
    db.prepare("DELETE FROM chapters WHERE novel_id = ?").run(novelId);
    db.prepare("DELETE FROM novels WHERE id = ?").run(novelId);
  })();
}

// ── User-novel association ──

export function joinNovel(username, novelId) {
  db.prepare("INSERT OR IGNORE INTO user_novels (username, novel_id, added_at) VALUES (?, ?, ?)").run(username, novelId, Date.now());
}

export function leaveNovel(username, novelId) {
  db.transaction(() => {
    db.prepare("DELETE FROM user_novels WHERE username = ? AND novel_id = ?").run(username, novelId);
    db.prepare("DELETE FROM summaries WHERE username = ? AND novel_id = ?").run(username, novelId);
    db.prepare("DELETE FROM notes WHERE username = ? AND novel_id = ?").run(username, novelId);
    db.prepare("DELETE FROM maps WHERE username = ? AND novel_id = ?").run(username, novelId);
    db.prepare("DELETE FROM graphs WHERE username = ? AND novel_id = ?").run(username, novelId);
    db.prepare("DELETE FROM reading_progress WHERE username = ? AND novel_id = ?").run(username, novelId);
  })();
}

export function getUserNovelIds(username) {
  return db.prepare("SELECT novel_id FROM user_novels WHERE username = ?").all(username).map(r => r.novel_id);
}

export function listNovelsWithUserStatus(username) {
  const novels = db.prepare(`
    SELECT n.*, un.username IS NOT NULL as joined
    FROM novels n
    LEFT JOIN user_novels un ON n.id = un.novel_id AND un.username = ?
    ORDER BY n.updated_at DESC
  `).all(username);

  return novels.map(n => ({
    id: n.id, title: n.title, author: n.author,
    fileName: n.file_name, fileFormat: n.file_format,
    totalChars: n.total_chars, chapterCount: n.chapter_count,
    createdAt: n.created_at, updatedAt: n.updated_at,
    joined: !!n.joined,
  }));
}

// ── Users ──

export function userExists(username) {
  return !!db.prepare("SELECT 1 FROM users WHERE username = ?").get(username);
}

export function createUser(username) {
  db.prepare("INSERT OR IGNORE INTO users (username, created_at) VALUES (?, ?)").run(username, Date.now());
}

// ── Reading progress ──

export function getProgress(username) {
  const rows = db.prepare(`
    SELECT novel_id AS \"novelId\", chapter_id AS \"chapterId\", chapter_index AS \"chapterIndex\", last_opened AS \"lastOpened\"
    FROM reading_progress WHERE username = ?
  `).all(username);
  const readingPositions = {};
  const lastOpened = {};
  for (const r of rows) {
    readingPositions[r.novelId] = { chapterId: r.chapterId, chapterIndex: r.chapterIndex };
    lastOpened[r.novelId] = r.lastOpened;
  }
  return { readingPositions, lastOpened };
}

export function saveProgress(username, novelId, chapterId, chapterIndex) {
  db.prepare(`
    INSERT OR REPLACE INTO reading_progress (username, novel_id, chapter_id, chapter_index, last_opened)
    VALUES (?, ?, ?, ?, ?)
  `).run(username, novelId, chapterId, chapterIndex, Date.now());
}

// ── Summaries ──

export function getSummaries(username, novelId) {
  return db.prepare("SELECT * FROM summaries WHERE username = ? AND novel_id = ? AND (deleted IS NULL OR deleted = 0) ORDER BY created_at").all(username, novelId);
}

export function upsertSummary(s) {
  db.prepare(`
    INSERT INTO summaries (id, novel_id, chapter_id, chapter_title, username, content, tokens_used, created_at, type, updated_at, deleted, used_fallback)
    VALUES (@id, @novelId, @chapterId, @chapterTitle, @username, @content, @tokensUsed, @createdAt, @type, @updatedAt, @deleted, @usedFallback)
    ON CONFLICT(id) DO UPDATE SET
      content = @content, tokens_used = @tokensUsed, type = @type, updated_at = @updatedAt, deleted = @deleted, used_fallback = @usedFallback
    WHERE @updatedAt >= updated_at
  `).run({ ...s, updatedAt: s.updatedAt || Date.now(), deleted: s.deleted || 0, usedFallback: s.usedFallback ? 1 : 0 });
}

// ── Notes ──

export function getNotes(username, novelId) {
  return db.prepare("SELECT * FROM notes WHERE username = ? AND novel_id = ? AND (deleted IS NULL OR deleted = 0) ORDER BY created_at DESC").all(username, novelId);
}

export function upsertNote(n) {
  db.prepare(`
    INSERT INTO notes (id, novel_id, chapter_id, chapter_title, username, content, source, source_label, created_at, updated_at, deleted)
    VALUES (@id, @novelId, @chapterId, @chapterTitle, @username, @content, @source, @sourceLabel, @createdAt, @updatedAt, @deleted)
    ON CONFLICT(id) DO UPDATE SET
      content = @content, source = @source, source_label = @sourceLabel, updated_at = @updatedAt, deleted = @deleted
    WHERE @updatedAt >= updated_at
  `).run({ ...n, updatedAt: n.updatedAt || Date.now(), deleted: n.deleted || 0 });
}

export function deleteNote(noteId, username) {
  if (username) {
    db.prepare("DELETE FROM notes WHERE id = ? AND username = ?").run(noteId, username);
  } else {
    db.prepare("DELETE FROM notes WHERE id = ?").run(noteId);
  }
}

export function deleteNotesByChapter(username, novelId, chapterId) {
  db.prepare("DELETE FROM notes WHERE username = ? AND novel_id = ? AND chapter_id = ?").run(username, novelId, chapterId);
}

// ── Maps ──

export function getMaps(username, novelId) {
  return db.prepare("SELECT * FROM maps WHERE username = ? AND novel_id = ? AND (deleted IS NULL OR deleted = 0) ORDER BY updated_at").all(username, novelId);
}

export function upsertMap(m) {
  db.prepare(`
    INSERT INTO maps (id, novel_id, username, data, created_at, updated_at, deleted)
    VALUES (@id, @novelId, @username, @data, @createdAt, @updatedAt, @deleted)
    ON CONFLICT(id) DO UPDATE SET
      data = @data, updated_at = @updatedAt, deleted = @deleted
    WHERE @updatedAt >= updated_at
  `).run({ ...m, updatedAt: m.updatedAt || Date.now(), deleted: m.deleted || 0 });
}

// ── Graphs ──

export function getGraphs(username, novelId) {
  return db.prepare("SELECT * FROM graphs WHERE username = ? AND novel_id = ? AND (deleted IS NULL OR deleted = 0) ORDER BY updated_at").all(username, novelId);
}

export function upsertGraph(g) {
  db.prepare(`
    INSERT INTO graphs (id, novel_id, username, data, created_at, updated_at, deleted)
    VALUES (@id, @novelId, @username, @data, @createdAt, @updatedAt, @deleted)
    ON CONFLICT(id) DO UPDATE SET
      data = @data, updated_at = @updatedAt, deleted = @deleted
    WHERE @updatedAt >= updated_at
  `).run({ ...g, updatedAt: g.updatedAt || Date.now(), deleted: g.deleted || 0 });
}

// ── Settings ──

export function getSetting(username, key) {
  try {
    const r = db.prepare("SELECT value FROM user_settings WHERE username = ? AND key = ?").get(username, key);
    return r ? JSON.parse(r.value) : null;
  } catch { return null; }
}

export function setSetting(username, key, value) {
  try {
    const v = JSON.stringify(value);
    db.prepare("INSERT OR REPLACE INTO user_settings (username, key, value) VALUES (?, ?, ?)").run(username, key, v);
  } catch (e) {
    // Log SQLite errors; ignore JSON.stringify errors for corrupt data
    if (!e.code || e.code.startsWith("SQLITE_")) {
      console.error("[db] setSetting error:", e);
    }
  }
}

// ── Sync: gather all user data for push (return camelCase for client) ──

export function gatherSyncData(username, since = 0) {
  const summaries = since > 0
    ? db.prepare(`
        SELECT id, novel_id AS "novelId", chapter_id AS "chapterId", chapter_title AS "chapterTitle",
               username, content, tokens_used AS "tokensUsed", created_at AS "createdAt", updated_at AS "updatedAt", type,
               deleted, used_fallback AS "usedFallback"
        FROM summaries WHERE username = ? AND updated_at > ?
      `).all(username, since)
    : db.prepare(`
        SELECT id, novel_id AS "novelId", chapter_id AS "chapterId", chapter_title AS "chapterTitle",
               username, content, tokens_used AS "tokensUsed", created_at AS "createdAt", updated_at AS "updatedAt", type,
               deleted, used_fallback AS "usedFallback"
        FROM summaries WHERE username = ?
      `).all(username);

  const notes = since > 0
    ? db.prepare(`
        SELECT id, novel_id AS "novelId", chapter_id AS "chapterId", chapter_title AS "chapterTitle",
               username, content, source, source_label AS "sourceLabel", created_at AS "createdAt", updated_at AS "updatedAt", deleted
        FROM notes WHERE username = ? AND updated_at > ?
      `).all(username, since)
    : db.prepare(`
        SELECT id, novel_id AS "novelId", chapter_id AS "chapterId", chapter_title AS "chapterTitle",
               username, content, source, source_label AS "sourceLabel", created_at AS "createdAt", updated_at AS "updatedAt", deleted
        FROM notes WHERE username = ?
      `).all(username);

  const maps = since > 0
    ? db.prepare(`
        SELECT id, novel_id AS "novelId", username, data, created_at AS "createdAt", updated_at AS "updatedAt", deleted
        FROM maps WHERE username = ? AND updated_at > ? AND (deleted IS NULL OR deleted = 0)
      `).all(username, since)
    : db.prepare(`
        SELECT id, novel_id AS "novelId", username, data, created_at AS "createdAt", updated_at AS "updatedAt", deleted
        FROM maps WHERE username = ? AND (deleted IS NULL OR deleted = 0)
      `).all(username);

  const graphs = since > 0
    ? db.prepare(`
        SELECT id, novel_id AS "novelId", username, data, created_at AS "createdAt", updated_at AS "updatedAt", deleted
        FROM graphs WHERE username = ? AND updated_at > ? AND (deleted IS NULL OR deleted = 0)
      `).all(username, since)
    : db.prepare(`
        SELECT id, novel_id AS "novelId", username, data, created_at AS "createdAt", updated_at AS "updatedAt", deleted
        FROM graphs WHERE username = ? AND (deleted IS NULL OR deleted = 0)
      `).all(username);

  const progress = getProgress(username);

  // Never return API key settings to clients (prefix match for user-specific keys)
  const SENSITIVE_PREFIXES = ["api-providers", "api-active-provider"];
  const settingRows = db.prepare("SELECT key, value FROM user_settings WHERE username = ?").all(username);
  const settings = {};
  for (const s of settingRows) {
    if (SENSITIVE_PREFIXES.some((p) => s.key === p || s.key.startsWith(p + ":"))) continue;
    try { settings[s.key] = JSON.parse(s.value); } catch { settings[s.key] = s.value; }
  }

  // Novel IDs the user has joined (novel deleted from server → ID disappears via CASCADE)
  const joinedNovelIds = db.prepare("SELECT novel_id FROM user_novels WHERE username = ?").all(username).map(r => r.novel_id);

  // Convert integer flags back to client-expected types
  for (const s of summaries) {
    s.usedFallback = !!s.usedFallback;
    s.deleted = s.deleted || undefined;
  }
  for (const n of notes) {
    n.deleted = n.deleted || undefined;
  }
  // Parse map data JSON
  for (const m of maps) {
    try { m.data = JSON.parse(m.data); } catch { m.data = {}; }
    m.deleted = m.deleted || undefined;
  }
  // Parse graph data JSON
  for (const g of graphs) {
    try { g.data = JSON.parse(g.data); } catch { g.data = {}; }
    g.deleted = g.deleted || undefined;
  }

  return { summaries, notes, maps, graphs, settings, progress, joinedNovelIds };
}

// ── Sync: apply merged data from server ──

export function applySyncData(username, summaries, notes, settings, progress) {
  db.transaction(() => {
    if (summaries?.length) {
      for (const s of summaries) { s.username = username; upsertSummary(s); }
    }
    if (notes?.length) {
      for (const n of notes) { n.username = username; upsertNote(n); }
    }
    if (settings) {
      for (const [key, value] of Object.entries(settings)) {
        setSetting(username, key, value);
      }
    }
    if (progress?.readingPositions) {
      for (const [novelId, pos] of Object.entries(progress.readingPositions)) {
        saveProgress(username, novelId, pos.chapterId, pos.chapterIndex);
      }
    }
  })();
}

// ── Backup & maintenance ────────────────────────────────────

export function checkpointWAL() {
  db.pragma("wal_checkpoint(TRUNCATE)");
}

// ── Backup management ──

const BACKUP_DIR = path.join(__dirname, "data", "backups");
const BACKUP_CONFIG_FILE = path.join(__dirname, "data", "backup-config.json");

const DEFAULT_BACKUP_CONFIG = {
  maxCount: 5,
  retainDays: 7,
  intervalHours: 24,
};

export function getBackupConfig() {
  try {
    if (fs.existsSync(BACKUP_CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(BACKUP_CONFIG_FILE, "utf-8"));
      return { ...DEFAULT_BACKUP_CONFIG, ...raw };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_BACKUP_CONFIG };
}

export function setBackupConfig(config) {
  const current = getBackupConfig();
  const updated = {
    maxCount: Math.max(1, Math.min(50, parseInt(config.maxCount, 10) || current.maxCount)),
    retainDays: Math.max(1, Math.min(365, parseInt(config.retainDays, 10) || current.retainDays)),
    intervalHours: Math.max(1, Math.min(720, parseInt(config.intervalHours, 10) || current.intervalHours)),
  };
  fs.writeFileSync(BACKUP_CONFIG_FILE, JSON.stringify(updated, null, 2), "utf-8");
  return updated;
}

export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith(".db"))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return {
        filename: f,
        size: stat.size,
        createdAt: stat.mtimeMs,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function createBackup() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = path.join(BACKUP_DIR, `novels-${timestamp}.db`);
  db.backup(backupPath);
  console.log(`[backup] created: ${backupPath}`);
  cleanOldBackups();
}

export function restoreBackup(filename) {
  // Validate filename FIRST before constructing path
  if (!filename.endsWith(".db") || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    throw new Error("无效的文件名");
  }
  const backupPath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(backupPath)) throw new Error("备份文件不存在");
  // Create a pre-restore backup first
  createBackup();
  // Close current connection, replace DB
  db.close();
  fs.copyFileSync(backupPath, DB_PATH);
  console.log(`[backup] restored: ${filename}`);
  // Schedule graceful shutdown so the response can be sent first
  setTimeout(() => {
    console.log("[backup] shutting down for restore...");
    process.exit(0);
  }, 500);
  return { ok: true, message: "备份已恢复，服务器即将重启..." };
}

export function deleteBackup(filename) {
  // Validate filename FIRST before constructing path
  if (!filename.endsWith(".db") || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    throw new Error("无效的文件名");
  }
  const backupPath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(backupPath)) throw new Error("备份文件不存在");
  fs.unlinkSync(backupPath);
  console.log(`[backup] deleted: ${filename}`);
}

export function cleanOldBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const config = getBackupConfig();
  const cutoff = Date.now() - config.retainDays * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith(".db"))
    .map((f) => {
      try {
        return { name: f, path: path.join(BACKUP_DIR, f), mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs };
      } catch { return null; } // File may have been deleted between readdir and stat
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime); // newest first

  let cleaned = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const tooOld = f.mtime < cutoff;
    const overLimit = i >= config.maxCount;
    if (tooOld || overLimit) {
      try { fs.unlinkSync(f.path); cleaned++; } catch { /* already deleted */ }
    }
  }
  if (cleaned > 0) console.log(`[backup] cleaned ${cleaned} old backup(s)`);
}

// ── Garbage collection for soft-deleted records ──

const GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function cleanupDeletedRecords() {
  const cutoff = Date.now() - GC_MAX_AGE_MS;
  const s = db.prepare("DELETE FROM summaries WHERE deleted > 0 AND updated_at < ?").run(cutoff);
  const n = db.prepare("DELETE FROM notes WHERE deleted > 0 AND updated_at < ?").run(cutoff);
  const m = db.prepare("DELETE FROM maps WHERE deleted > 0 AND updated_at < ?").run(cutoff);
  const g = db.prepare("DELETE FROM graphs WHERE deleted > 0 AND updated_at < ?").run(cutoff);
  if (s.changes || n.changes || m.changes || g.changes) {
    console.log(`[gc] cleaned ${s.changes} summaries, ${n.changes} notes, ${m.changes} maps, ${g.changes} graphs (deleted > 30 days ago)`);
  }
}
