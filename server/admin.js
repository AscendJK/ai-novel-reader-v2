import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "./database.js";
import { getTimeoutConfig, setPerChunkTimeout } from "./rag-builder.js";
import { getUsersOnlineStatus, getUserDevices } from "./sync-handler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, "data", ".admin_token");

function getOrCreateToken() {
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, "utf-8").trim();
  const token = crypto.randomBytes(12).toString("hex");
  fs.writeFileSync(TOKEN_FILE, token, "utf-8");
  return token;
}

const ADMIN_TOKEN = getOrCreateToken();
console.log("[admin] Token:", ADMIN_TOKEN.slice(0, 4) + "..." + ADMIN_TOKEN.slice(-4));

function auth(req, res) {
  const authH = req.headers.authorization;
  const t = authH?.startsWith("Bearer ") ? authH.slice(7) : (req.query.token || req.body?.token);
  if (t !== ADMIN_TOKEN) { res.status(403).json({ error: "无效 token" }); return false; }
  return true;
}

export function mountAdminRoutes(app) {
  // ── Stats ──

  app.get("/api/admin/stats", (req, res) => {
    if (!auth(req, res)) return;
    const dbPath = path.join(__dirname, "data", "novels.db");
    const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    const userCount = db.db.prepare("SELECT COUNT(*) as c FROM users").get().c;
    const novelCount = db.db.prepare("SELECT COUNT(*) as c FROM novels").get().c;
    const summaryCount = db.db.prepare("SELECT COUNT(*) as c FROM summaries").get().c;
    const mapCount = db.db.prepare("SELECT COUNT(*) as c FROM maps WHERE deleted IS NULL OR deleted = 0").get().c;
    const graphCount = db.db.prepare("SELECT COUNT(*) as c FROM graphs WHERE deleted IS NULL OR deleted = 0").get().c;
    res.json({ userCount, novelCount, summaryCount, mapCount, graphCount, dbSize, dbSizeMB: (dbSize / 1048576).toFixed(1) });
  });

  // ── Users ──

  app.get("/api/admin/users", (req, res) => {
    if (!auth(req, res)) return;
    const rows = db.db.prepare(`
      SELECT u.username, u.created_at,
        (SELECT COUNT(*) FROM user_novels un WHERE un.username = u.username) as novel_count,
        (SELECT COUNT(*) FROM summaries s WHERE s.username = u.username) as summary_count,
        (SELECT COUNT(*) FROM notes n WHERE n.username = u.username) as note_count,
        (SELECT COUNT(*) FROM maps m WHERE m.username = u.username AND (m.deleted IS NULL OR m.deleted = 0)) as map_count,
        (SELECT COUNT(*) FROM graphs g WHERE g.username = u.username AND (g.deleted IS NULL OR g.deleted = 0)) as graph_count
      FROM users u ORDER BY u.created_at DESC
    `).all();
    const onlineMap = getUsersOnlineStatus();
    res.json(rows.map(r => ({
      ...r,
      online: onlineMap[r.username]?.online || false,
      lastSeen: onlineMap[r.username]?.lastSeen || null,
      devices: getUserDevices(r.username),
    })));
  });

  app.delete("/api/admin/users/:name", (req, res) => {
    if (!auth(req, res)) return;
    const { name } = req.params;
    db.db.transaction(() => {
      db.db.prepare("DELETE FROM summaries WHERE username = ?").run(name);
      db.db.prepare("DELETE FROM notes WHERE username = ?").run(name);
      db.db.prepare("DELETE FROM reading_progress WHERE username = ?").run(name);
      db.db.prepare("DELETE FROM user_settings WHERE username = ?").run(name);
      db.db.prepare("DELETE FROM user_novels WHERE username = ?").run(name);
      db.db.prepare("DELETE FROM users WHERE username = ?").run(name);
    })();
    res.json({ ok: true });
  });

  // ── Novels ──

  app.get("/api/admin/novels", (req, res) => {
    if (!auth(req, res)) return;
    const novels = db.db.prepare(`
      SELECT n.*,
        (SELECT COUNT(*) FROM user_novels un WHERE un.novel_id = n.id) as join_count
      FROM novels n
      ORDER BY n.updated_at DESC
    `).all();
    // Fetch all rag indices grouped by novel
    const allIndices = db.db.prepare(`SELECT novel_id, engine, status, chunk_count, build_time, dim FROM rag_indices WHERE engine != 'tfidf'`).all();
    const indexMap = new Map();
    for (const ri of allIndices) {
      if (!indexMap.has(ri.novel_id)) indexMap.set(ri.novel_id, []);
      indexMap.get(ri.novel_id).push({ engine: ri.engine, status: ri.status, chunkCount: ri.chunk_count, buildTime: ri.build_time, dim: ri.dim });
    }
    res.json(novels.map(n => ({
      id: n.id, title: n.title, author: n.author,
      fileName: n.file_name, fileFormat: n.file_format,
      totalChars: n.total_chars, chapterCount: n.chapter_count,
      createdAt: n.created_at, updatedAt: n.updated_at,
      joinCount: n.join_count,
      ragIndices: indexMap.get(n.id) || [],
    })));
  });

  app.delete("/api/admin/novels/:id", (req, res) => {
    if (!auth(req, res)) return;
    db.deleteNovel(req.params.id);
    res.json({ ok: true });
  });

  app.delete("/api/admin/novels/:id/rag/:engine", (req, res) => {
    if (!auth(req, res)) return;
    try {
      db.db.prepare("DELETE FROM rag_indices WHERE novel_id = ? AND engine = ?").run(req.params.id, req.params.engine);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: "删除失败" }); }
  });

  // ── Settings ──

  app.get("/api/admin/settings", (req, res) => {
    if (!auth(req, res)) return;
    const timeout = getTimeoutConfig();
    res.json({ timeout });
  });

  app.put("/api/admin/settings/timeout", (req, res) => {
    if (!auth(req, res)) return;
    const { perChunkMs } = req.body;
    if (perChunkMs == null) return res.status(400).json({ error: "缺少 perChunkMs 参数" });
    const val = setPerChunkTimeout(perChunkMs);
    res.json({ ok: true, perChunkMs: val });
  });

  // ── Backups ──

  app.get("/api/admin/backups", (req, res) => {
    if (!auth(req, res)) return;
    try {
      const backups = db.listBackups();
      const totalSize = backups.reduce((sum, b) => sum + b.size, 0);
      res.json({ backups, totalSize, totalSizeMB: (totalSize / 1048576).toFixed(1) });
    } catch (e) { res.status(500).json({ error: "获取备份列表失败" }); }
  });

  app.get("/api/admin/backups/config", (req, res) => {
    if (!auth(req, res)) return;
    res.json(db.getBackupConfig());
  });

  app.put("/api/admin/backups/config", (req, res) => {
    if (!auth(req, res)) return;
    try {
      const config = db.setBackupConfig(req.body);
      res.json({ ok: true, config });
    } catch (e) { res.status(500).json({ error: "保存配置失败" }); }
  });

  app.post("/api/admin/backups/create", (req, res) => {
    if (!auth(req, res)) return;
    try {
      db.createBackup();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: "创建备份失败" }); }
  });

  app.post("/api/admin/backups/:filename/restore", (req, res) => {
    if (!auth(req, res)) return;
    try {
      const result = db.restoreBackup(req.params.filename);
      res.json(result);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.delete("/api/admin/backups/:filename", (req, res) => {
    if (!auth(req, res)) return;
    try {
      db.deleteBackup(req.params.filename);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post("/api/admin/backups/clean", (req, res) => {
    if (!auth(req, res)) return;
    try {
      db.cleanOldBackups();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: "清理失败" }); }
  });

  // ── Token ──

  app.get("/api/admin/token", (req, res) => {
    if (!auth(req, res)) return;
    res.json({ token: ADMIN_TOKEN });
  });
}
