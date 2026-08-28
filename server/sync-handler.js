import * as db from "./database.js";
import crypto from "node:crypto";

// Active connections: one clientId per username (primary device)
const connections = new Map(); // username → clientId
const connectionLastSeen = new Map(); // username → timestamp
// Known devices: all clientIds that have registered for a username
const knownDevices = new Map(); // username → Set<clientId>
const knownDevicesLastSeen = new Map(); // username → timestamp (last time any device was active)

// Session tokens: token → { username, createdAt }
const sessions = new Map();

const SESSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const CONNECTION_MAX_IDLE = 3 * 60 * 1000; // 3 minutes without heartbeat
const KNOWN_DEVICES_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const MAX_KNOWN_DEVICES_PER_USER = 10; // 每个用户最多保留的已知设备数（防止 clientId 无限膨胀）

// Periodic cleanup of stale sessions, connections, and known devices
setInterval(() => {
  const now = Date.now();
  // 清理过期的 session
  for (const [token, s] of sessions) {
    if (now - s.createdAt > SESSION_MAX_AGE) sessions.delete(token);
  }
  // 清理空闲的连接
  for (const [username, lastSeen] of connectionLastSeen) {
    if (now - lastSeen > CONNECTION_MAX_IDLE) {
      connections.delete(username);
      connectionLastSeen.delete(username);
    }
  }
  // 清理长时间不活跃的已知设备
  for (const [username, lastSeen] of knownDevicesLastSeen) {
    if (now - lastSeen > KNOWN_DEVICES_MAX_AGE) {
      knownDevices.delete(username);
      knownDevicesLastSeen.delete(username);
    }
  }
}, 60_000);

export function createSession(username) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { username, createdAt: Date.now() });
  return token;
}

export function validateSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  return session ? session.username : null;
}

export function removeSession(token) {
  sessions.delete(token);
}

export function register(username, clientId, token) {
  // Track known devices
  if (!knownDevices.has(username)) knownDevices.set(username, new Set());
  const devices = knownDevices.get(username);
  const isKnownDevice = devices.has(clientId);

  // 无论是否已知设备，都踢掉其他 session（单设备在线策略）
  devices.add(clientId);
  // 限制已知设备数量：超出上限时淘汰最旧的设备（按注册顺序，Set 迭代序）
  // 防止异常/恶意客户端用随机 clientId 无限注册导致内存膨胀
  if (devices.size > MAX_KNOWN_DEVICES_PER_USER) {
    const oldest = devices.values().next().value;
    if (oldest) devices.delete(oldest);
  }
  for (const [t, s] of sessions) {
    if (s.username === username && t !== token) {
      sessions.delete(t);
    }
  }
  // 方案A：持久化“活跃设备”。无论是否已知设备都无条件覆盖（后注册者优先，选项①）。
  // 重启后 active_device 仍在 SQLite 中，旧设备（clientId 不匹配）会在下一次
  // heartbeat/push 时因判定为“被顶替”而收到 kicked，从而收敛到单设备。
  db.setSetting(username, "active_device", clientId);
  db.setSetting(username, "active_device_at", Date.now());
  connections.set(username, clientId);
  connectionLastSeen.set(username, Date.now());

  if (isKnownDevice) {
    console.log(`[sync] device reconnected: ${username} (${clientId.slice(0, 8)})`);
  } else {
    console.log(`[sync] new device registered: ${username} (${clientId.slice(0, 8)})`);
  }

  let activeCount = 0;
  for (const [, s] of sessions) {
    if (s.username === username) activeCount++;
  }
  return activeCount || 1;
}

export function disconnect(username, clientId) {
  const c = connections.get(username);
  if (c === clientId) connections.delete(username);
}

export function heartbeat(username, clientId, token) {
  const devices = knownDevices.get(username);
  if (!devices || !devices.has(clientId)) return 0;

  // 方案A：持久化的活跃设备判定。若本设备不是当前 active_device，说明被另一台设备顶替
  // （后注册覆盖后，先注册方在此被识别为被迫下线）。返回 -2（被顶替），区别于 -1（会话过期）。
  const activeDevice = db.getSetting(username, "active_device");
  if (activeDevice && activeDevice !== clientId) {
    console.log(`[sync] heartbeat rejected: displaced by another device for ${username} (${clientId.slice(0, 8)})`);
    return -2; // Displaced by another device (kicked)
  }

  // Verify token belongs to this user
  if (token) {
    const session = sessions.get(token);
    if (!session) {
      console.log(`[sync] heartbeat rejected: session expired for ${username} (${clientId.slice(0, 8)})`);
      return -1; // Session was deleted (kicked by another device)
    }
    if (session.username !== username) {
      console.log(`[sync] heartbeat rejected: token username mismatch for ${username}`);
      return 0; // Token belongs to a different user
    }
  }

  const now = Date.now();
  connectionLastSeen.set(username, now);
  knownDevicesLastSeen.set(username, now);
  return 1;
}

/** Get online status for all users based on heartbeat timestamps */
export function getUsersOnlineStatus() {
  const now = Date.now();
  const result = {};
  for (const [username, lastSeen] of connectionLastSeen) {
    result[username] = {
      online: (now - lastSeen) < CONNECTION_MAX_IDLE,
      lastSeen,
    };
  }
  return result;
}

export function isActive(username, clientId) {
  // 方案A：默认以持久化的 active_device 为准（单设备在线）。
  // 若无持久化记录（历史数据/迁移前），回退到内存 knownDevices 判定，保证兼容。
  const activeDevice = db.getSetting(username, "active_device");
  if (activeDevice) {
    return activeDevice === clientId;
  }
  const devices = knownDevices.get(username);
  if (!devices) return false;
  return devices.has(clientId);
}

/**
 * 检查用户是否有活跃的在线设备
 * @param {string} username
 * @returns {{ online: boolean, deviceCount: number, lastSeen: number | null }}
 */
export function checkUserOnline(username) {
  const lastSeen = connectionLastSeen.get(username);
  const devices = knownDevices.get(username);
  const deviceCount = devices ? devices.size : 0;

  // 检查是否有活跃连接（3分钟内有心跳）
  const online = lastSeen ? (Date.now() - lastSeen) < CONNECTION_MAX_IDLE : false;

  return {
    online,
    deviceCount,
    lastSeen: lastSeen || null,
  };
}

/**
 * Get all device clientIds for a user
 * @param {string} username
 * @returns {string[]} Array of clientId strings
 */
export function getUserDevices(username) {
  const devices = knownDevices.get(username);
  return devices ? Array.from(devices) : [];
}

// Settings that contain sensitive data (API keys) — never sync these (prefix match for user-specific keys like "api-providers:user1")
const SENSITIVE_PREFIXES = ["api-providers", "api-active-provider"];
function isSensitiveKey(key) {
  return SENSITIVE_PREFIXES.some((p) => key === p || key.startsWith(p + ":"));
}

// Merge changes into SQLite (last write wins by updatedAt)
// Returns { data, orphanedNovelIds } — orphanedNovelIds is the set of novelIds
// whose data was skipped because the novel doesn't exist on the server yet.
// The frontend should retry after uploading the missing novels.
export function mergeAndSave(username, changes, lastSyncTime = 0) {
  const orphanedNovelIds = new Set();

  db.db.transaction(() => {
    if (changes.summaries?.length) {
      for (const s of changes.summaries) {
        if (!s.id || !s.novelId) continue;
        if (!db.getNovel(s.novelId)) {
          orphanedNovelIds.add(s.novelId);
          continue; // skip orphaned records, track for retry
        }
        db.upsertSummary({ ...s, username });
      }
    }
    if (changes.notes?.length) {
      for (const n of changes.notes) {
        if (!n.id || !n.novelId) continue;
        if (!db.getNovel(n.novelId)) {
          orphanedNovelIds.add(n.novelId);
          continue;
        }
        db.upsertNote({ ...n, username });
      }
    }
    if (changes.maps?.length) {
      for (const m of changes.maps) {
        if (!m.id || !m.novelId) continue;
        if (!db.getNovel(m.novelId)) {
          orphanedNovelIds.add(m.novelId);
          continue;
        }
        db.upsertMap({ ...m, username, data: JSON.stringify(m.data) });
      }
    }
    if (changes.graphs?.length) {
      for (const g of changes.graphs) {
        if (!g.id || !g.novelId) continue;
        if (!db.getNovel(g.novelId)) {
          orphanedNovelIds.add(g.novelId);
          continue;
        }
        db.upsertGraph({ ...g, username, data: JSON.stringify(g.data) });
      }
    }
    if (changes.settings && Object.keys(changes.settings).length > 0) {
      for (const [key, value] of Object.entries(changes.settings)) {
        if (value !== undefined && value !== null && !isSensitiveKey(key)) {
          db.setSetting(username, key, value);
        }
      }
    }
    if (changes.progress?.readingPositions && Object.keys(changes.progress.readingPositions).length > 0) {
      for (const [novelId, pos] of Object.entries(changes.progress.readingPositions)) {
        if (pos && pos.chapterId) {
          db.saveProgress(username, novelId, pos.chapterId, pos.chapterIndex ?? 0);
        }
      }
    }
    // 修复根因4：同步 lastOpened（最后打开时间），仅更新该字段，不覆盖已有 chapterId/chapterIndex
    if (changes.progress?.lastOpened && Object.keys(changes.progress.lastOpened).length > 0) {
      for (const [novelId, openedAt] of Object.entries(changes.progress.lastOpened)) {
        if (openedAt) {
          db.db.prepare(
            `UPDATE reading_progress SET last_opened = ? WHERE username = ? AND novel_id = ?`
          ).run(openedAt, username, novelId);
        }
      }
    }
  })();

  // Capture AFTER transaction — upserts use Date.now() so updated_at <= lastSyncAt
  const lastSyncAt = Date.now();
  const data = db.gatherSyncData(username, lastSyncTime);
  data.lastSyncAt = lastSyncAt;

  return { data, orphanedNovelIds: Array.from(orphanedNovelIds) };
}
