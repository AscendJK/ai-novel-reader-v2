import type { SyncData, RegisterResult, HeartbeatResult, PushResult } from "./types";
import { useUIStore } from "@/stores/ui-store";
import { hasMoreChanges } from "./sync-bridge";
import { broadcast } from "@/lib/broadcast";
import { apiFetch } from "@/lib/api-client";

/** API 错误响应格式 */
interface ApiErrorResponse {
  error?: string;
  kicked?: boolean;
}

const SYNC_INTERVAL = 30_000;
const HEARTBEAT_INTERVAL = 15_000;

type ChangeCallback = (data: SyncData) => Promise<void>;

export class SyncClient {
  private username: string | null = null;
  private clientId: string | null = null;
  private token: string | null = null;
  private activeCount = 0;
  private lastSyncTime = 0;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private gatherChanges: ((lastSyncTime: number) => Promise<Partial<SyncData>>) | null = null;
  private applyData: ChangeCallback | null = null;
  private isAiRunning: () => boolean = () => false;
  private onKicked: ((username: string) => void) | null = null;
  private onConflict: ((username: string) => Promise<"overwrite" | "rename">) | null = null;
  private reRegistering = false;
  private syncing = false;
  private heartbeatFailCount = 0;
  private autoOffline = false; // true if offlineMode was auto-enabled by heartbeat failure
  private conflictCooldownUntil = 0; // timestamp until which conflict dialog is suppressed


  /** 获取按用户隔离的 last-sync-time localStorage key */
  private get syncTimeKey() {
    return this.username ? `novel-reader-last-sync-time:${this.username}` : "novel-reader-last-sync-time";
  }

  constructor() {
    this.username = localStorage.getItem("sync-username");
    this.clientId = localStorage.getItem("sync-clientId");
    this.token = localStorage.getItem("sync-token");
    this.lastSyncTime = parseInt(localStorage.getItem(this.syncTimeKey) || "0", 10) || 0;
    // If we have username but no token, clear username (but keep clientId)
    if (this.username && !this.token) {
      this.username = null;
      localStorage.removeItem("sync-username");
    }
    // 恢复自动离线状态（刷新前如果是自动离线的，刷新后继续检测服务器）
    if (localStorage.getItem("sync-auto-offline") === "true") {
      this.autoOffline = true;
      this.heartbeatFailCount = 3;
    }
  }

  get isLoggedIn() { return !!this.username && !!this.clientId && !!this.token; }
  get user() { return this.username; }
  get cid() { return this.clientId; }
  get connectionCount() { return this.activeCount; }
  /** 是否因为服务器不可达而自动进入离线模式 */
  get isAutoOffline() { return this.autoOffline; }

  /** Update the local username (for conflict rename flow) */
  setUsername(username: string) {
    this.username = username;
    localStorage.setItem("sync-username", username);
  }

  /**
   * 检查用户是否在线
   * @param username 用户名
   * @returns 用户在线状态
   */
  async checkUserOnline(username: string): Promise<{
    exists: boolean;
    online: boolean;
    deviceCount: number;
    lastSeen: number | null;
  } | null> {
    try {
      const resp = await apiFetch(`/api/sync/check-user/${encodeURIComponent(username)}`);
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }

  async login(username: string, mode: "create" | "join" = "create"): Promise<{ success: boolean; isNew: boolean; activeCount: number; error?: string }> {
    try {
      console.log("[sync] login:", username, mode);
      // 提前保存 username，这样即使网络错误，心跳也能用它来重连
      this.username = username;
      localStorage.setItem("sync-username", username);
      const resp = await apiFetch("/api/sync/register", {
        method: "POST",
        body: JSON.stringify({ username, mode, clientId: this.clientId }),
      });
      console.log("[sync] register response:", resp.status);
      if (resp.status === 404) {
        const err: ApiErrorResponse = await resp.json().catch(() => ({}));
        return { success: false, isNew: false, activeCount: 0, error: err.error || "用户名不存在" };
      }
      if (resp.status === 409) {
        const err: ApiErrorResponse = await resp.json().catch(() => ({}));
        return { success: false, isNew: false, activeCount: 0, error: err.error || "用户名已存在" };
      }
      if (!resp.ok) {
        const err: ApiErrorResponse = await resp.json().catch(() => ({}));
        return { success: false, isNew: false, activeCount: 0, error: err.error || `服务器错误 (${resp.status})` };
      }
      const result: RegisterResult = await resp.json();
      console.log("[sync] registered:", result.isNew ? "new" : "existing");

      this.username = username;
      this.clientId = result.clientId;
      this.token = result.token;
      this.activeCount = result.activeCount;
      this.lastSyncTime = 0; // full sync on login
      localStorage.setItem("sync-username", username);
      localStorage.setItem("sync-clientId", result.clientId);
      if (result.token) localStorage.setItem("sync-token", result.token);
      localStorage.setItem(this.syncTimeKey, "0");

      return { success: true, isNew: result.isNew, activeCount: result.activeCount };
    } catch (e) {
      console.error("[sync] login error:", e);
      throw e; // 让调用方区分网络错误和服务器业务错误
    }
  }

  start(opts: {
    gatherChanges: (lastSyncTime: number) => Promise<Partial<SyncData>>;
    applyData: ChangeCallback;
    isAiRunning: () => boolean;
    onKicked: (username: string) => void;
    onConflict?: (username: string) => Promise<"overwrite" | "rename">;
  }) {
    // 防止重复创建定时器
    this.stop();
    this.gatherChanges = opts.gatherChanges;
    this.applyData = opts.applyData;
    this.isAiRunning = opts.isAiRunning;
    this.onKicked = opts.onKicked;
    this.onConflict = opts.onConflict || null;

    this.heartbeatTimer = setInterval(() => this.doHeartbeat(), HEARTBEAT_INTERVAL);
    this.syncTimer = setInterval(() => this.doSync(), SYNC_INTERVAL);
  }

  stop() {
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  async pushNow() {
    await this.doSync();
  }

  /** Reset auto-offline detection (call when user manually toggles offline mode) */
  resetAutoOffline() {
    this.autoOffline = false;
    this.heartbeatFailCount = 0;
    localStorage.removeItem("sync-auto-offline");
  }

  /** Mark server as unreachable and enable offline mode immediately (e.g. after login failure) */
  markServerUnreachable() {
    this.autoOffline = true;
    this.heartbeatFailCount = 3;
    localStorage.setItem("sync-auto-offline", "true");
    if (!useUIStore.getState().offlineMode) {
      useUIStore.getState().setOfflineMode(true);
      window.dispatchEvent(new CustomEvent("sync-offline"));
    }
  }

  logout() {
    if (this.username && this.clientId) {
      apiFetch("/api/sync/disconnect", {
        method: "POST",
        body: JSON.stringify({ username: this.username, clientId: this.clientId, token: this.token }),
      }).catch((e) => console.warn("[sync] disconnect failed:", e));
    }
    this.stop();
    this.username = null;
    // 保留 clientId，这样重新登录时会被识别为已知设备（与 handleKicked 一致）
    this.token = null;
    this.activeCount = 0;
    this.lastSyncTime = 0;
    this.autoOffline = false;
    this.heartbeatFailCount = 0;
    localStorage.removeItem("sync-username");
    localStorage.removeItem("sync-token");
    localStorage.removeItem(this.syncTimeKey);
    localStorage.removeItem("sync-auto-offline");
    useUIStore.getState().setOfflineMode(false);
    // 通知其他标签页
    try { broadcast.send('logout'); } catch { /* ignore */ }
  }

  // ── Full sync round ──

  async syncOnce(): Promise<boolean> {
    if (!this.username || !this.clientId || !this.gatherChanges || !this.applyData) {
      console.warn("[sync] syncOnce skipped — not ready");
      return false;
    }
    if (this.reRegistering || this.syncing) {
      console.log("[sync] syncOnce skipped — busy");
      return false;
    }
    this.syncing = true;
    try {
      const changes = await this.gatherChanges(this.lastSyncTime);
      const pushS = changes.summaries?.length || 0;
      const pushN = changes.notes?.length || 0;
      const pushM = changes.maps?.length || 0;
      const pushSt = changes.settings ? Object.keys(changes.settings).length : 0;
      console.log(`[sync] pushing: s=${pushS} n=${pushN} m=${pushM} settings=${pushSt}`);
      const resp = await apiFetch("/api/sync/push", {
        method: "POST",
        body: JSON.stringify({ username: this.username, clientId: this.clientId, token: this.token, changes, lastSyncTime: this.lastSyncTime }),
      });
      console.log(`[sync] push response: ${resp.status}`);
      if (resp.status === 409) {
        // Username conflict — another device has the same username
        console.warn("[sync] 409 username conflict");
        // Respect cooldown to avoid spamming the user with conflict dialogs
        if (Date.now() < this.conflictCooldownUntil) {
          console.log("[sync] conflict cooldown active, skipping push");
          return false;
        }
        if (this.onConflict && this.username) {
          const usernameBefore = this.username;
          const choice = await this.onConflict(this.username);
          if (choice === "overwrite") {
            // Register on server (kicks other device), then pull data
            console.log("[sync] overwrite: registering on server...");
            const regResult = await this.login(this.username, "join");
            if (regResult.success) {
              console.log("[sync] overwrite: registered, pulling server data...");
              const retryResp = await apiFetch("/api/sync/push", {
                method: "POST",
                body: JSON.stringify({ username: this.username, clientId: this.clientId, token: this.token, changes, lastSyncTime: 0 }),
              });
              if (retryResp.ok) {
                const r: PushResult = await retryResp.json();
                if (r.data) {
                  await this.applyData(r.data);
                  if (r.data.lastSyncAt) {
                    this.lastSyncTime = r.data.lastSyncAt;
                    localStorage.setItem(this.syncTimeKey, String(this.lastSyncTime));
                  }
                }
                return true;
              } else {
                console.warn("[sync] overwrite: retry push failed, cooldown 5 min");
                this.conflictCooldownUntil = Date.now() + 5 * 60 * 1000;
              }
            } else {
              console.warn("[sync] overwrite: register failed, cooldown 5 min");
              this.conflictCooldownUntil = Date.now() + 5 * 60 * 1000;
            }
          } else {
            // Rename — caller may have updated username
            if (this.username !== usernameBefore) {
              console.log("[sync] rename: username changed, will retry on next sync");
            } else {
              // User cancelled rename — set cooldown to avoid re-triggering
              console.log("[sync] rename: user cancelled, conflict cooldown 5 min");
              this.conflictCooldownUntil = Date.now() + 5 * 60 * 1000;
            }
          }
        }
        return false;
      }
      if (resp.status === 403 || resp.status === 401) {
        // Check if kicked by another device
        const errData = await resp.json().catch(() => ({}));
        if (errData.kicked) {
          console.warn("[sync] kicked by another device during push");
          this.handleKicked();
          return false;
        }
        console.warn(`[sync] ${resp.status} from push, attempting re-register...`);
        const reRegistered = await this.tryReRegister();
        if (reRegistered) {
          // Retry the push with new credentials (full sync after re-register)
          console.log("[sync] re-registered, retrying push with new credentials...");
          try {
            const retryResp = await apiFetch("/api/sync/push", {
              method: "POST",
              body: JSON.stringify({ username: this.username, clientId: this.clientId, token: this.token, changes, lastSyncTime: 0 }),
            });
            console.log("[sync] retry response:", retryResp.status);
            if (retryResp.ok) {
              const r: PushResult = await retryResp.json();
              const pullS = r.data?.summaries?.length || 0;
              const pullN = r.data?.notes?.length || 0;
              console.log(`[sync] retry ok, pulled: s=${pullS} n=${pullN}`);
              if (r.data) {
                await this.applyData(r.data);
                if (r.data.lastSyncAt) {
                  this.lastSyncTime = r.data.lastSyncAt;
                  localStorage.setItem(this.syncTimeKey, String(this.lastSyncTime));
                }
              }
              return true;
            } else {
              const errText = await retryResp.text().catch(() => "unknown");
              console.error("[sync] retry failed:", retryResp.status, errText);
            }
          } catch (retryErr) {
            console.error("[sync] retry error:", retryErr);
          }
        } else {
          // Re-register failed — this is a real kick (another device logged in)
          console.warn("[sync] re-register failed, kicked");
          this.handleKicked();
        }
        return false;
      }
      if (resp.ok) {
        const r: PushResult = await resp.json();
        const pullS = r.data?.summaries?.length || 0;
        const pullN = r.data?.notes?.length || 0;
        if (pushS || pushN || pullS || pullN) {
          console.log(`[sync] push: s=${pushS} n=${pushN} | pull: s=${pullS} n=${pullN}`);
        }
        // Always apply server data (even if merged=false, server returns new data for incremental sync)
        if (r.data) {
          await this.applyData(r.data);
        }
        // Update lastSyncTime from server response
        if (r.data?.lastSyncAt) {
          this.lastSyncTime = r.data.lastSyncAt;
          localStorage.setItem(this.syncTimeKey, String(this.lastSyncTime));
        }
        // 通知其他标签页同步完成
        try {
          broadcast.send('sync-complete');
        } catch { /* ignore */ }

        // 检查是否还有更多数据需要同步
        let hasMore = false;
        try {
          hasMore = await hasMoreChanges(this.lastSyncTime);
          if (hasMore) {
            console.log("[sync] more data to sync, scheduling next batch...");
          }
        } catch { /* ignore */ }

        // 释放锁后，如果有更多数据，延迟触发下一批
        if (hasMore) {
          setTimeout(() => this.syncOnce(), 1000);
        }

        return true;
      } else {
        const errText = await resp.text().catch(() => "unknown");
        console.error("[sync] push failed:", resp.status, errText);
      }
    } catch (e) { console.error("[sync] syncOnce error:", e); }
    finally {
      this.syncing = false;
    }
    return false;
  }

  // ── private ──

  private async tryReRegister(): Promise<boolean> {
    if (!this.username) return false;
    this.reRegistering = true;
    try {
      // Try "join" first (user exists on server)
      let resp = await apiFetch("/api/sync/register", {
        method: "POST",
        body: JSON.stringify({ username: this.username, mode: "join", clientId: this.clientId }),
      });
      // If 404, user doesn't exist on server — try "create"
      if (resp.status === 404) {
        console.log("[sync] user not found on server, creating...");
        resp = await apiFetch("/api/sync/register", {
          method: "POST",
          body: JSON.stringify({ username: this.username, mode: "create", clientId: this.clientId }),
        });
      }
      if (resp.ok) {
        const result = await resp.json();
        this.clientId = result.clientId;
        this.token = result.token;
        this.activeCount = result.activeCount;
        localStorage.setItem("sync-clientId", result.clientId);
        if (result.token) localStorage.setItem("sync-token", result.token);
        console.log("[sync] re-registered successfully");
        return true;
      }
    } catch { /* re-register failed */ }
    finally { this.reRegistering = false; }
    return false;
  }

  private async doHeartbeat() {
    if (!this.username) return;
    // Skip if user manually enabled offline mode (heartbeatFailCount === 0 means manual)
    if (useUIStore.getState().offlineMode && this.heartbeatFailCount === 0) return;
    if (this.reRegistering) return;

    // No credentials yet (server was offline during login) — try to register
    if (!this.clientId) {
      try {
        const ok = await this.tryReRegister();
        if (ok) {
          const wasOffline = useUIStore.getState().offlineMode;
          this.heartbeatFailCount = 0;
          this.autoOffline = false;
          localStorage.removeItem("sync-auto-offline");
          if (wasOffline) {
            useUIStore.getState().setOfflineMode(false);
            window.dispatchEvent(new CustomEvent("sync-reconnected"));
          }
          console.log("[sync] registered from heartbeat, syncing now...");
          this.syncOnce().catch((e) => console.warn("[sync] syncOnce failed:", e));
        }
      } catch { /* server still offline */ }
      return;
    }

    try {
      const resp = await apiFetch("/api/sync/heartbeat", {
        method: "POST",
        body: JSON.stringify({ username: this.username, clientId: this.clientId, token: this.token }),
      });
      if (resp.status === 401 || resp.status === 403) {
        // Check if kicked by another device
        const data = await resp.json().catch(() => ({}));
        if (data.kicked) {
          console.warn("[sync] kicked by another device");
          this.handleKicked();
          return;
        }
        // Session expired (not kicked) — try re-register
        console.warn(`[sync] heartbeat ${resp.status}, attempting re-register...`);
        const ok = await this.tryReRegister();
        if (!ok) {
          console.warn("[sync] re-register failed, kicking");
          this.handleKicked();
        } else {
          console.log("[sync] re-registered from heartbeat, syncing now...");
          this.syncOnce().catch((e) => console.warn("[sync] syncOnce failed:", e));
        }
        return;
      }
      if (resp.ok) {
        // If heartbeat was failing (auto-offline), disable offline mode on recovery
        const wasAutoOffline = this.heartbeatFailCount >= 3;
        this.heartbeatFailCount = 0;
        if (wasAutoOffline) {
          this.autoOffline = false;
          localStorage.removeItem("sync-auto-offline");
          useUIStore.getState().setOfflineMode(false);
          window.dispatchEvent(new CustomEvent("sync-reconnected"));
          console.log("[sync] server reachable, offline mode auto-disabled");
        }
        const r: HeartbeatResult = await resp.json();
        if (r.activeCount === 0) {
          console.warn("[sync] heartbeat 0, attempting re-register...");
          const ok = await this.tryReRegister();
          if (!ok) {
            console.warn("[sync] re-register failed, kicking");
            this.handleKicked();
          } else {
            console.log("[sync] re-registered from heartbeat, syncing now...");
            this.syncOnce().catch((e) => console.warn("[sync] syncOnce failed:", e));
          }
          return;
        }
        this.activeCount = r.activeCount;
      }
    } catch {
      // Server unreachable — count failures and auto-enable offline mode
      this.heartbeatFailCount++;
      if (this.heartbeatFailCount >= 3 && !useUIStore.getState().offlineMode) {
        this.autoOffline = true;
        localStorage.setItem("sync-auto-offline", "true");
        useUIStore.getState().setOfflineMode(true);
        window.dispatchEvent(new CustomEvent("sync-offline"));
        console.log("[sync] server unreachable after 3 heartbeats, offline mode auto-enabled");
      }
    }
  }

  private async doSync() {
    if (!this.username || !this.clientId || !this.gatherChanges || !this.applyData) return;
    if (useUIStore.getState().offlineMode) return;
    if (this.isAiRunning()) return;
    if (this.reRegistering) return;
    await this.syncOnce();
  }

  private async handleKicked() {
    const kickedUser = this.username;
    this.stop();
    this.username = null;
    // 保留 clientId，这样重新登录时会被识别为已知设备
    this.token = null;
    this.activeCount = 0;
    this.lastSyncTime = 0;
    this.autoOffline = false;
    this.heartbeatFailCount = 0;
    localStorage.removeItem("sync-username");
    localStorage.removeItem("sync-token");
    localStorage.removeItem(this.syncTimeKey);
    localStorage.removeItem("sync-auto-offline");
    useUIStore.getState().setOfflineMode(false);
    // 通知其他标签页用户已登出
    try {
      broadcast.send('logout');
    } catch { /* ignore */ }
    if (this.onKicked && kickedUser) this.onKicked(kickedUser);
  }
}

export const syncClient = new SyncClient();
