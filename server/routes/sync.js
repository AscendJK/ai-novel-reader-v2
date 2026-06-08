/**
 * 同步相关路由
 */

import { Router } from "express";
import crypto from "node:crypto";
import * as db from "../database.js";
import {
  register,
  disconnect,
  heartbeat,
  isActive,
  mergeAndSave,
  createSession,
  validateSession,
  removeSession,
  checkUserOnline,
} from "../sync-handler.js";
import { rateLimit } from "../middleware/index.js";

const router = Router();

// GET /api/sync/check-user/:username - 检查用户是否在线
router.get("/check-user/:username", (req, res) => {
  const { username } = req.params;
  if (!username || typeof username !== "string") {
    return res.status(400).json({ error: "username required" });
  }

  const trimmed = username.trim();
  if (trimmed.length < 2 || trimmed.length > 30) {
    return res.status(400).json({ error: "用户名需 2-30 个字符" });
  }

  // 检查用户是否存在
  const exists = db.userExists(trimmed);

  // 检查用户是否在线
  const onlineStatus = checkUserOnline(trimmed);

  res.json({
    exists,
    online: onlineStatus.online,
    deviceCount: onlineStatus.deviceCount,
    lastSeen: onlineStatus.lastSeen,
  });
});

// POST /api/sync/register (with rate limiting)
router.post("/register", rateLimit(30), (req, res) => {
  const { username, mode } = req.body;
  if (!username || typeof username !== "string") {
    return res.status(400).json({ error: "username required" });
  }

  // Validate username: 2-30 chars, no control characters
  const trimmed = username.trim();
  if (trimmed.length < 2 || trimmed.length > 30) {
    return res.status(400).json({ error: "用户名需 2-30 个字符" });
  }
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    return res.status(400).json({ error: "用户名包含非法字符" });
  }

  const exists = db.userExists(trimmed);

  if (mode === "create" && exists) {
    return res.status(409).json({ error: "用户名已存在，请返回并点击'加入已有'" });
  }
  if (mode === "join" && !exists) {
    return res.status(404).json({ error: "用户名不存在，请先创建" });
  }

  if (!exists) db.createUser(trimmed);

  // 优先使用客户端发送的 clientId，没有则生成新的
  const clientId = req.body.clientId || crypto.randomBytes(12).toString("hex");
  const token = createSession(trimmed);
  const activeCount = register(trimmed, clientId, token);
  const lastSyncAt = Date.now();
  const data = db.gatherSyncData(trimmed);
  data.lastSyncAt = lastSyncAt;

  res.json({ clientId, token, activeCount, data, isNew: !exists });
});

// POST /api/sync/heartbeat
router.post("/heartbeat", (req, res) => {
  const { username, clientId, token } = req.body;
  if (!username || !clientId) return res.status(400).json({ error: "username and clientId required" });
  // Check if this is a known device and session is still valid
  const activeCount = heartbeat(username, clientId, token);
  if (activeCount === -1) {
    // Session expired (kicked by another device)
    return res.status(401).json({ error: "kicked", kicked: true });
  }
  if (activeCount > 0) {
    return res.json({ activeCount });
  }
  // Unknown device — require valid token belonging to this user
  if (!token) return res.status(401).json({ error: "token required" });
  const sessionUser = validateSession(token);
  if (!sessionUser || sessionUser !== username) return res.status(401).json({ error: "session expired" });
  res.json({ activeCount: 1 });
});

// POST /api/sync/push
router.post("/push", (req, res) => {
  try {
    const { username, clientId, token, changes, lastSyncTime } = req.body;
    if (!username || !clientId) return res.status(400).json({ error: "username and clientId required" });
    // Validate token and verify it belongs to this user
    if (!token) return res.status(401).json({ error: "token required" });
    const sessionUser = validateSession(token);
    if (!sessionUser) return res.status(401).json({ error: "session expired" });
    if (sessionUser !== username) return res.status(403).json({ error: "token username mismatch" });
    if (!isActive(username, clientId)) return res.status(403).json({ error: "kicked", kicked: true });
    if (!changes) {
      const now = Date.now();
      const data = db.gatherSyncData(username, lastSyncTime || 0);
      data.lastSyncAt = now;
      return res.json({ merged: false, data });
    }

    const merged = mergeAndSave(username, changes, lastSyncTime || 0);
    res.json({ merged: !!merged, data: merged });
  } catch (e) {
    console.error("[sync] push error:", e);
    res.status(500).json({ error: "同步失败" });
  }
});

// POST /api/sync/disconnect
router.post("/disconnect", (req, res) => {
  const { username, clientId, token } = req.body;
  if (!username || !clientId || !token) return res.status(400).json({ error: "username, clientId, and token required" });
  // Validate token belongs to this user
  const sessionUser = validateSession(token);
  if (!sessionUser || sessionUser !== username) return res.status(401).json({ error: "invalid token" });
  disconnect(username, clientId);
  removeSession(token);
  res.json({ ok: true });
});

// GET /api/sync/status
router.get("/status", (_req, res) => {
  res.json({ ok: true });
});

export default router;
