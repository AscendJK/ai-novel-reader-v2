/**
 * 小说相关路由
 */

import { Router } from "express";
import crypto from "node:crypto";
import * as db from "../database.js";
import { authNovel } from "../middleware/auth.js";

const router = Router();

// GET /api/novels?username=xxx — list all novels with user join status
router.get("/", (req, res) => {
  try {
    const username = req.query.username;
    if (username) {
      res.json(db.listNovelsWithUserStatus(username));
    } else {
      res.json(db.listNovels());
    }
  } catch (e) {
    console.error("[novels] list error:", e);
    res.status(500).json({ error: "查询失败" });
  }
});

// GET /api/novels/:id — novel meta + chapter list (titles only, no content)
router.get("/:id", (req, res) => {
  try {
    const novel = db.getNovel(req.params.id);
    if (!novel) return res.status(404).json({ error: "小说未找到" });
    const chapters = db.getChapterList(req.params.id);
    res.json({ novel, chapters });
  } catch (e) {
    console.error("[novels] get error:", e);
    res.status(500).json({ error: "查询失败" });
  }
});

// GET /api/novels/:id/chapters — all chapters with content (for auto-join)
router.get("/:id/chapters", (req, res) => {
  if (!authNovel(req, res)) return;
  try {
    const chapters = db.getAllChapters(req.params.id);
    res.json(chapters);
  } catch (e) {
    console.error("[novels] get chapters error:", e);
    res.status(500).json({ error: "获取章节失败" });
  }
});

// GET /api/novels/:id/chapters/:index — single chapter content
router.get("/:id/chapters/:index", (req, res) => {
  if (!authNovel(req, res)) return;
  try {
    const ch = db.getChapter(req.params.id, parseInt(req.params.index, 10));
    if (!ch) return res.status(404).json({ error: "章节未找到" });
    res.json(ch);
  } catch (e) {
    console.error("[novels] get chapter error:", e);
    res.status(500).json({ error: "获取章节失败" });
  }
});

// POST /api/novels — upload/import a novel (parsed JSON from frontend)
router.post("/", (req, res) => {
  if (!authNovel(req, res)) return;
  try {
    const { novel, chapters } = req.body;
    if (!novel || !chapters) return res.status(400).json({ error: "novel and chapters required" });

    // Always generate server-side ID to prevent client ID spoofing
    const novelId = novel.id || crypto.randomUUID();

    db.insertNovel({
      id: novelId,
      title: novel.title,
      author: novel.author || null,
      fileName: novel.fileName || "",
      fileFormat: novel.fileFormat || "txt",
      totalChars: novel.totalChars || 0,
      chapterCount: novel.chapterCount || chapters.length,
      createdAt: novel.createdAt || Date.now(),
      updatedAt: Date.now(),
    });
    // Map chapters to use server-generated novel ID
    const mappedChapters = chapters.map((ch, i) => ({
      ...ch,
      novelId: novelId,
      id: ch.id || `${novelId}-ch${i}`,
    }));
    db.insertChapters(mappedChapters);
    console.log(`[novel] uploaded: "${novel.title}" (${chapters.length} chapters, ${novel.totalChars || 0} chars) → ${novelId.slice(0, 8)}`);
    res.json({ ok: true, novelId });
  } catch (e) {
    console.error("[novel] upload failed:", e);
    res.status(500).json({ error: "上传失败" });
  }
});

// POST /api/novels/:id/join — user adds novel to their bookshelf
router.post("/:id/join", (req, res) => {
  if (!authNovel(req, res)) return;
  try {
    const novel = db.getNovel(req.params.id);
    if (!novel) return res.status(404).json({ error: "小说未找到" });
    db.joinNovel(req._username, req.params.id);
    console.log(`[novel] ${req._username} joined: "${novel.title}" (${req.params.id.slice(0, 8)})`);
    res.json({ ok: true });
  } catch (e) {
    console.error("[novel] join failed:", e);
    res.status(500).json({ error: "加入书架失败" });
  }
});

// POST /api/novels/:id/leave — user removes novel from bookshelf (keeps novel on server)
router.post("/:id/leave", (req, res) => {
  if (!authNovel(req, res)) return;
  try {
    db.leaveNovel(req._username, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error("[novel] leave failed:", e);
    res.status(500).json({ error: "操作失败" });
  }
});

export default router;
