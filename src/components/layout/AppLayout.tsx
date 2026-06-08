import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { Header } from "./Header";
import { BookSelect } from "./BookSelect";
import { ReadingPanel } from "@/components/reader/ReadingPanel";
import { ApiSettings } from "@/components/settings/ApiSettings";
import { UsernameLogin } from "@/components/login/UsernameLogin";
import { DebugPanel } from "@/components/common/DebugPanel";
import { ShortcutHelp } from "@/components/common/ShortcutHelp";
import { GlobalNotes } from "@/components/notes/GlobalNotes";
import { LocalErrorBoundary } from "@/components/common/LocalErrorBoundary";
import { useKeyboardShortcuts, type ShortcutBinding } from "@/hooks/useKeyboardShortcuts";
import { useRAGStore } from "@/stores/rag-store";
import { setupModelLoader, downloadModel } from "@/rag/model-loader";
import { dedupSummaries } from "@/lib/dedup-utils";
import { broadcast } from "@/lib/broadcast";
import { setCurrentNovelIdGetter } from "@/rag/rag-cache-utils";

// Configure Transformers.js to load models from local public/models/
setupModelLoader();
import { useUIStore } from "@/stores/ui-store";
import { useNovelStore } from "@/stores/novel-store";
import { loadAllNovels, loadSummaries, deleteNovel, cleanupDeletedRecords, getLocalUsers, addLocalUser, deleteUserData, removeLocalUser } from "@/db/repositories";
import { useSummaryStore } from "@/stores/summary-store";
import { useAPIStore } from "@/stores/api-store";
import { sharedDB, getUserDB, setCurrentUser, deleteUserDB } from "@/db/database";
import { syncClient } from "@/sync/sync-client";
import { gatherChanges, applyServerData } from "@/sync/sync-bridge";
import type { SyncData } from "@/sync/types";
import { authHeaders } from "@/lib/auth-headers";
import { apiFetch, getServerUrl } from "@/lib/api-client";
import { getAiRunning } from "@/lib/ai-state";

export function AppLayout() {
  const { theme, debugMode, offlineMode } = useUIStore();
  const { currentNovel, setCurrentNovel, addNovel } = useNovelStore();
  const { setSummaries } = useSummaryStore();
  const [showSettings, setShowSettings] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [syncReady, setSyncReady] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [localUsers, setLocalUsers] = useState<string[]>(getLocalUsers);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const syncStarted = useRef(false);
  const dbInitialized = useRef(false);

  // 同步初始化用户数据库（只在首次渲染时执行）
  if (!dbInitialized.current) {
    dbInitialized.current = true;
    const storedUser = localStorage.getItem("sync-username");
    if (storedUser) {
      try {
        setCurrentUser(storedUser);
      } catch { /* ignore */ }
    }
    // 设置 RAG 缓存淘汰的保护函数
    setCurrentNovelIdGetter(() => useNovelStore.getState().currentNovel?.id);
  }

  const globalShortcuts = useMemo<ShortcutBinding[]>(() => [
    { key: "t", action: () => useUIStore.getState().toggleTheme(), description: "切换主题" },
    { key: "Escape", action: () => { setShowSettings(false); setShowNotes(false); setShowShortcutHelp(false); }, description: "关闭弹窗" },
    { key: "?", shift: true, action: () => setShowShortcutHelp((v) => !v), description: "显示快捷键帮助" },
  ], []);
  useKeyboardShortcuts(globalShortcuts);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const kickedRef = useRef(false);
  const handleKicked = useCallback(async (kickedUser: string) => {
    if (kickedRef.current) return;
    kickedRef.current = true;
    alert("该账号已在另一设备登录，当前会话已下线。\n\n您的本地数据已保留，重新登录后可继续使用。");
    // 只清除登录状态，保留本地数据（小说、笔记、总结等）
    // 保留 sync-clientId，这样重新登录时会被识别为已知设备
    // novel-reader-offline-mode 已由 SyncClient.handleKicked 处理（setOfflineMode(false)）
    ["sync-username", "sync-token", "novel-reader-last-sync-time"
    ].forEach((k) => localStorage.removeItem(k));
    // 不删除用户数据库，保留本地数据
    // 刷新页面回到登录界面
    window.location.reload();
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    // 数据库已在组件体中初始化，这里只加载数据
    useAPIStore.getState().loadFromDB();
    const currentUser = localStorage.getItem("sync-username");
    if (currentUser) {
      loadAllNovels().then((novels) => {
        novels.forEach((n) => addNovel(n));
      });
    }
    // Initialize cachedKeys and ragCacheSizeBytes from IndexedDB on startup
    (async () => {
      try {
        const all = await sharedDB.ragCache.toArray();
        const validKeys = new Set<string>();
        let totalBytes = 0;
        for (const entry of all) {
          if (entry.vectorsBuffer && entry.dim && entry.chunkCount) {
            totalBytes += entry.chunkCount * entry.dim * 4;
            if (entry.id) validKeys.add(entry.id);
          }
        }
        useRAGStore.setState({ cachedKeys: validKeys, ragCacheSizeBytes: totalBytes });
      } catch { /* ignore */ }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (currentNovel) {
      loadSummaries(currentNovel.id).then((dbSummaries) => {
        if (dbSummaries.length > 0) setSummaries(dbSummaries);
      });
    }
  }, [currentNovel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync integration (auto-login from stored session) ──
  useEffect(() => {
    const hasStoredSession = !!localStorage.getItem("sync-username");
    if (hasStoredSession) setSyncReady(true);
    if (offlineMode || !hasStoredSession) return;

    const applySyncData = async (data: SyncData) => {
      await applyServerData(data);
      if (data.progress?.readingPositions) {
        useNovelStore.setState((s) => ({
          readingPositions: { ...s.readingPositions, ...data.progress!.readingPositions },
        }));
      }
      const { currentNovel: cn } = useNovelStore.getState();
      if (cn) {
        const s = await loadSummaries(cn.id);
        if (s.length > 0) {
          setSummaries(dedupSummaries(s));
        }
      }
      syncJoinedNovels();
    };

    const startSync = () => {
      if (syncStarted.current) return;
      syncStarted.current = true;
      syncClient.start({
        gatherChanges,
        applyData: applySyncData,
        isAiRunning: getAiRunning,
        onKicked: handleKicked,
        onConflict: handleSyncConflict,
      });
      setTimeout(() => {
        syncClient.syncOnce().then(() => syncJoinedNovels()).catch((e) => {
        console.warn("[AppLayout] syncOnce failed, retrying syncJoinedNovels:", e);
        syncJoinedNovels();
      });
        // Clean up soft-deleted records older than 30 days
        cleanupDeletedRecords().catch((e) => console.warn("[AppLayout] cleanupDeletedRecords failed:", e));
      }, 0);
    };

    // Always start sync — heartbeat handles no-credentials case by trying to register
    startSync();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Register visibility change → refresh data from server (skip in offline mode)
  useEffect(() => {
    if (offlineMode) return;
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && syncClient.isLoggedIn) {
        syncClient.pushNow();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [offlineMode]);

  // 多标签页通信：监听其他标签页的事件
  useEffect(() => {
    const unsubs = [
      // 其他标签页完成同步后，当前标签页也拉取最新数据
      broadcast.onSyncComplete(() => {
        if (syncClient.isLoggedIn && !offlineMode) {
          console.log('[broadcast] other tab synced, pulling latest...');
          syncClient.pushNow();
        }
      }),
      // 其他标签页切换用户后，当前标签页刷新
      broadcast.onUserSwitched((username) => {
        console.log('[broadcast] user switched to:', username);
        // 如果用户名不同，刷新页面
        const currentUser = localStorage.getItem('sync-username');
        if (currentUser !== username) {
          window.location.reload();
        }
      }),
      // 其他标签页登出后，当前标签页也登出
      broadcast.onLogout(() => {
        console.log('[broadcast] logout from other tab');
        window.location.reload();
      }),
    ];

    return () => unsubs.forEach(unsub => unsub());
  }, [offlineMode]);

  const handleSyncConflict = async (conflictUsername: string): Promise<"overwrite" | "rename"> => {
    const choice = window.confirm(
      `服务器上已存在用户名 "${conflictUsername}"（可能来自其他设备）。\n\n` +
      `点击"确定"拉取服务器数据覆盖本地（另一设备将被踢下线）\n` +
      `点击"取消"修改本地用户名`
    );
    if (choice) return "overwrite";
    const newName = prompt("请输入新的用户名：", conflictUsername + "-2");
    if (newName && newName.trim() && newName.trim() !== conflictUsername) {
      const trimmedName = newName.trim();
      // Migrate data from old user DB to new user DB before switching
      try {
        const oldDb = getUserDB();
        const [novels, chapters, summaries, notes, maps, graphs] = await Promise.all([
          oldDb.novels.toArray(),
          oldDb.chapters.toArray(),
          oldDb.summaries.toArray(),
          oldDb.notes.toArray(),
          oldDb.maps.toArray(),
          oldDb.graphs.toArray(),
        ]);
        syncClient.setUsername(trimmedName);
        setCurrentUser(trimmedName);
        const newDb = getUserDB();
        await newDb.transaction("rw", newDb.novels, newDb.chapters, newDb.summaries, newDb.notes, newDb.maps, newDb.graphs, async () => {
          if (novels.length) await newDb.novels.bulkPut(novels);
          if (chapters.length) await newDb.chapters.bulkPut(chapters);
          if (summaries.length) await newDb.summaries.bulkPut(summaries);
          if (notes.length) await newDb.notes.bulkPut(notes);
          if (maps.length) await newDb.maps.bulkPut(maps);
          if (graphs.length) await newDb.graphs.bulkPut(graphs);
        });
        // Clean up old user's DB
        await deleteUserDB(conflictUsername).catch((e) => console.warn("[AppLayout] deleteUserDB failed:", e));
        removeLocalUser(conflictUsername);
        addLocalUser(trimmedName);
      } catch (e) {
        console.error("[sync] data migration failed:", e);
        syncClient.setUsername(trimmedName);
        setCurrentUser(trimmedName);
      }
      return "rename";
    }
    // User cancelled rename — keep local data, skip push this cycle
    return "rename";
  };

  const handleLogin = async (username: string) => {
    setLoginError(null);

    // ── 检查用户是否在其他设备上在线 ──
    const onlineStatus = await syncClient.checkUserOnline(username);
    if (onlineStatus && onlineStatus.online) {
      const kick = window.confirm(
        `用户 "${username}" 当前在其他设备上在线（${onlineStatus.deviceCount} 个设备）。\n\n` +
        `点击"确定"：踢掉其他设备，继续登录\n` +
        `点击"取消"：取消本次登录`
      );
      if (!kick) {
        return; // 用户取消登录
      }
    }

    // ── Handle user switching ──
    const existingUser = localStorage.getItem("sync-username");
    if (existingUser && existingUser !== username) {
      const hasLocalData = await getUserDB().novels.count().then((c) => c > 0).catch((e) => {
        console.warn("[AppLayout] check local data failed:", e);
        return false;
      });
      if (hasLocalData) {
        const keep = window.confirm(
          `检测到本地有 "${existingUser}" 的数据。\n\n` +
          `点击"确定"：保留 "${existingUser}" 的数据（可通过下拉菜单切回）\n` +
          `点击"取消"：清除 "${existingUser}" 的数据，为 "${username}" 腾出空间`
        );
        if (!keep) {
          await clearLocalData();
        }
      }
    }

    // ── Set local session ──
    // If switching users, disconnect old session and reset sync
    if (existingUser && existingUser !== username) {
      syncClient.logout();
      syncStarted.current = false;
    }
    localStorage.setItem("sync-username", username);
    setCurrentUser(username);
    addLocalUser(username);
    setLocalUsers(getLocalUsers());

    // Clear old user's novels from store
    useNovelStore.setState({ novels: [], currentNovel: null });

    // ── Start sync ──
    if (!syncStarted.current) {
      syncStarted.current = true;
      syncClient.start({
        gatherChanges,
        applyData: async (data: SyncData) => {
          await applyServerData(data);
          if (data.progress?.readingPositions) {
            useNovelStore.setState((s) => ({
              readingPositions: { ...s.readingPositions, ...data.progress!.readingPositions },
            }));
          }
          const { currentNovel: cn2 } = useNovelStore.getState();
          if (cn2) {
            const s = await loadSummaries(cn2.id);
            if (s.length > 0) {
              setSummaries(dedupSummaries(s));
            }
          }
          syncJoinedNovels();
        },
        isAiRunning: getAiRunning,
        onKicked: handleKicked,
        onConflict: handleSyncConflict,
      });
    }

    // Try server login (join first, create if not found)
    let serverSynced = false;
    let loginResult: { success: boolean; error?: string } = { success: false };
    try {
      loginResult = await syncClient.login(username, "join");
      if (!loginResult.success) {
        loginResult = await syncClient.login(username, "create");
      }
    } catch {
      // 网络错误 — 服务器不可达
      syncClient.markServerUnreachable();
    }
    if (loginResult.success) {
      // 登录成功说明服务器可达，清除自动离线状态
      syncClient.resetAutoOffline();
      if (offlineMode) useUIStore.getState().setOfflineMode(false);

      // ── 检查服务器和本地是否都有数据（冲突检测）──
      const localNovelCount = await getUserDB().novels.count().catch(() => 0);
      let serverNovelCount = 0;
      try {
        const resp = await apiFetch(`/api/novels?username=${encodeURIComponent(username)}`);
        if (resp.ok) {
          const list = await resp.json();
          serverNovelCount = list.length;
        }
      } catch { /* ignore */ }

      if (localNovelCount > 0 && serverNovelCount > 0) {
        // 两边都有数据，让用户选择
        const choice = window.prompt(
          `服务器上已有用户 "${username}" 的数据（${serverNovelCount} 本小说），本地也有数据（${localNovelCount} 本小说）。\n\n` +
          `请选择处理方式（输入数字）：\n` +
          `1 - 合并：两边数据合并（推荐）\n` +
          `2 - 覆盖：用服务器数据覆盖本地\n` +
          `3 - 改名：本地数据改名存为新用户`,
          "1"
        );

        if (choice === "2") {
          // 覆盖：清除本地数据，拉取服务器数据
          await clearLocalData();
          useNovelStore.setState({ novels: [], currentNovel: null });
          try {
            await syncClient.syncOnce();
            await syncJoinedNovels();
            serverSynced = true;
          } catch { /* syncOnce 内部已处理错误 */ }
        } else if (choice === "3") {
          // 改名：本地数据迁移到新用户名
          const newName = window.prompt("请输入新的用户名：", username + "-local");
          if (newName && newName.trim() && newName.trim() !== username) {
            const trimmedName = newName.trim();
            try {
              const oldDb = getUserDB();
              const [novels, chapters, summaries, notes, maps, graphs] = await Promise.all([
                oldDb.novels.toArray(),
                oldDb.chapters.toArray(),
                oldDb.summaries.toArray(),
                oldDb.notes.toArray(),
                oldDb.maps.toArray(),
                oldDb.graphs.toArray(),
              ]);
              syncClient.setUsername(trimmedName);
              setCurrentUser(trimmedName);
              localStorage.setItem("sync-username", trimmedName);
              addLocalUser(trimmedName);
              const newDb = getUserDB();
              await newDb.transaction("rw", newDb.novels, newDb.chapters, newDb.summaries, newDb.notes, newDb.maps, newDb.graphs, async () => {
                if (novels.length) await newDb.novels.bulkPut(novels);
                if (chapters.length) await newDb.chapters.bulkPut(chapters);
                if (summaries.length) await newDb.summaries.bulkPut(summaries);
                if (notes.length) await newDb.notes.bulkPut(notes);
                if (maps.length) await newDb.maps.bulkPut(maps);
                if (graphs.length) await newDb.graphs.bulkPut(graphs);
              });
              await deleteUserDB(username).catch((e) => console.warn("[AppLayout] deleteUserDB failed:", e));
              removeLocalUser(username);
              // 以新用户名注册到服务器
              try {
                const regResult = await syncClient.login(trimmedName, "create");
                if (regResult.success) {
                  await syncClient.syncOnce();
                  await syncJoinedNovels();
                  serverSynced = true;
                }
              } catch { /* server unreachable */ }
            } catch (e) {
              console.error("[AppLayout] data migration failed:", e);
            }
          }
        } else {
          // 合并（默认）：两边数据合并
          try {
            await syncClient.syncOnce();
            await syncJoinedNovels();
            serverSynced = true;
          } catch { /* syncOnce 内部已处理错误 */ }
        }
      } else {
        // 只有一边有数据或都没有，正常同步
        try {
          await syncClient.syncOnce();
          await syncJoinedNovels();
          serverSynced = true;
        } catch { /* syncOnce 内部已处理错误 */ }
      }
    }

    // Load novels from local DB (in case sync didn't bring any)
    if (!serverSynced) {
      const novels = await loadAllNovels();
      novels.forEach((n) => addNovel(n));
    }

    // Auto-download default BGE model in background (non-blocking)
    // Only if server is configured (needed for backend proxy)
    const store = useRAGStore.getState();
    const defaultModelKey = "Xenova/bge-small-zh-v1.5";
    const hasServer = !!getServerUrl();
    if (hasServer && !store.isModelDownloaded(defaultModelKey) && !store.currentDownload) {
      console.log("[AppLayout] 自动下载默认引擎 BGE...");
      downloadModel(defaultModelKey).catch((e) => console.warn("[AppLayout] BGE 下载失败:", e));
    } else if (!hasServer) {
      console.log("[AppLayout] 未配置服务器，跳过模型自动下载");
    }

    setSyncReady(true);
    useUIStore.getState().setDebugMode(false);
  };

  const handleDeleteUser = async (username: string) => {
    await deleteUserData(username);
    setLocalUsers(getLocalUsers());
    // If deleted user was the active user, clear session
    if (localStorage.getItem("sync-username") === username) {
      localStorage.removeItem("sync-username");
      localStorage.removeItem("sync-clientId");
      localStorage.removeItem("sync-token");
    }
  };

  const clearLocalData = async () => {
    // Delete current user's database (settings/API keys are in shared DB, preserved)
    const currentUser = localStorage.getItem("sync-username");
    if (currentUser) {
      await deleteUserDB(currentUser).catch((e) => console.warn("[AppLayout] deleteUserDB failed:", e));
      removeLocalUser(currentUser);
    }
  };

  // Download joined novels that are missing from local IndexedDB, and clean up deleted ones
  const syncJoinedNovels = async () => {
    try {
      const username = localStorage.getItem("sync-username");
      if (!username) return;

      const resp = await apiFetch(`/api/novels?username=${encodeURIComponent(username)}`);
      if (!resp.ok) return;
      const list: Array<{ id: string; title: string; author?: string; fileName: string; fileFormat: string; totalChars: number; chapterCount: number; createdAt: number; updatedAt: number; joined?: boolean }> = await resp.json();

      // Server-side novel IDs that still exist
      const serverNovelIds = new Set(list.map((n) => n.id));

      // Upload local novels that don't exist on the server (created offline)
      // 每次操作都重新获取数据库连接，避免使用过期的引用
      const safeGetDB = () => {
        try {
          const db = getUserDB();
          if (!db.isOpen()) return null;
          return db;
        } catch {
          return null;
        }
      };

      let udb = safeGetDB();
      if (!udb) return;

      const localNovels = await udb.novels.toArray().catch((e) => {
        console.warn("[AppLayout] load local novels failed:", e);
        return [];
      });
      // Build title→serverId map for deduplication
      const serverTitleMap = new Map<string, string>();
      for (const n of list) {
        serverTitleMap.set(n.title, n.id);
      }

      for (const local of localNovels) {
        if (serverNovelIds.has(local.id)) continue;
        try {
          // Deduplicate: if a novel with the same title exists on server, merge instead of uploading
          const serverId = serverTitleMap.get(local.title);
          if (serverId) {
            console.log(`[sync] 小说 "${local.title}" 本地ID ${local.id.slice(0,8)} 与服务器ID ${serverId.slice(0,8)} 重复，合并为服务器版本`);
            // Update local novel ID to match server
            const oldId = local.id;
            const chapters = await udb.chapters.where("novelId").equals(oldId).toArray();
            const summaries = await udb.summaries.where("novelId").equals(oldId).toArray();
            const notes = await udb.notes.where("novelId").equals(oldId).toArray();
            const maps = await udb.maps.where("novelId").equals(oldId).toArray();
            const graphs = await udb.graphs.where("novelId").equals(oldId).toArray();
            await udb.transaction("rw", udb.novels, udb.chapters, udb.summaries, udb.notes, udb.maps, udb.graphs, async () => {
              // Delete old local novel
              await udb.novels.delete(oldId);
              await udb.chapters.where("novelId").equals(oldId).delete();
              // Re-save chapters with server ID
              for (const ch of chapters) {
                await udb.chapters.put({ ...ch, novelId: serverId, id: `${serverId}-ch${ch.index}` });
              }
              // Update related data to use server ID
              for (const s of summaries) { await udb.summaries.put({ ...s, novelId: serverId }); }
              for (const n of notes) { await udb.notes.put({ ...n, novelId: serverId }); }
              for (const m of maps) { await udb.maps.put({ ...m, novelId: serverId }); }
              for (const g of graphs) { await udb.graphs.put({ ...g, novelId: serverId }); }
            });
            // Migrate reading position from old ID to server ID
            const { readingPositions } = useNovelStore.getState();
            const oldPos = readingPositions[oldId];
            if (oldPos) {
              const newChapterId = `${serverId}-ch${oldPos.chapterIndex}`;
              useNovelStore.getState().saveReadingPosition(serverId, newChapterId, oldPos.chapterIndex);
              // Clean up old position
              const positions = { ...readingPositions };
              delete positions[oldId];
              useNovelStore.setState({ readingPositions: positions });
            }
            // Join server novel
            await apiFetch(`/api/novels/${serverId}/join`, { method: "POST" })
              .catch((e) => console.warn("[AppLayout] join novel failed:", e));
            continue;
          }

          const chapters = await udb.chapters.where("novelId").equals(local.id).sortBy("index");
          const resp = await apiFetch("/api/novels", {
            method: "POST",
            body: JSON.stringify({
              novel: {
                id: local.id, title: local.title, author: local.author,
                fileName: local.fileName, fileFormat: local.fileFormat,
                totalChars: local.totalChars, chapterCount: chapters.length,
                createdAt: local.createdAt, updatedAt: local.updatedAt,
              },
              chapters: chapters.map((ch) => ({
                id: ch.id, index: ch.index, title: ch.title, content: ch.content,
                startOffset: ch.startOffset, endOffset: ch.endOffset,
              })),
            }),
          });
          // Auto-join after successful upload
          if (resp.ok) {
            await apiFetch(`/api/novels/${local.id}/join`, {
              method: "POST",
            }).catch((e) => console.warn("[AppLayout] join novel failed:", e));
          }
        } catch { /* upload failed, will retry next sync */ }
      }

      // Clean up local novels that were deleted from the server
      // Only remove novels that exist on the server but are no longer joined
      // (local-only novels created offline are preserved)
      const currentNovelId = useNovelStore.getState().currentNovel?.id;
      const unjoinedServerNovels = list.filter((n) => !n.joined && serverNovelIds.has(n.id));
      for (const sn of unjoinedServerNovels) {
        if (sn.id === currentNovelId) continue;
        const existsLocally = localNovels.find((l) => l.id === sn.id);
        if (!existsLocally) continue;
        await deleteNovel(sn.id).catch((e) => console.warn("[AppLayout] deleteNovel failed:", e));
        useNovelStore.getState().removeNovel(sn.id);
      }

      // Download joined novels missing from local
      for (const sn of list) {
        if (!sn.joined) continue;
        // 重新获取数据库连接
        udb = safeGetDB();
        if (!udb) break;
        const existing = await udb.novels.get(sn.id).catch((e) => {
          console.warn("[AppLayout] check novel existence failed:", e);
          return null;
        });
        if (existing) continue;
        const chResp = await apiFetch(`/api/novels/${sn.id}/chapters`);
        if (!chResp.ok) continue;
        const chapters = await chResp.json();
        // 重新获取数据库连接
        udb = safeGetDB();
        if (!udb) break;
        await udb.transaction("rw", udb.novels, udb.chapters, async () => {
          await udb.novels.put({
            id: sn.id, title: sn.title, author: sn.author,
            fileName: sn.fileName, fileFormat: sn.fileFormat,
            totalChars: sn.totalChars, chapterCount: chapters.length,
            createdAt: sn.createdAt, updatedAt: sn.updatedAt || Date.now(),
          });
          for (const ch of chapters) {
            await udb.chapters.put({
              id: ch.id, novelId: sn.id, index: ch.index,
              title: ch.title, content: ch.content,
              startOffset: ch.startOffset ?? 0, endOffset: ch.endOffset ?? ch.content?.length ?? 0,
            });
          }
        });
        addNovel({ ...sn, chapters, chapterCount: chapters.length });
      }
    } catch (e) { console.error("syncJoinedNovels:", e); }
  };

  const handleBackToLibrary = () => {
    setShowSettings(false);
    setCurrentNovel(null);
  };

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      {/* Login / syncing overlay — blocks UI until first sync completes */}
      {!syncReady && (
        <UsernameLogin
          localUsers={localUsers}
          onLogin={handleLogin}
          onDelete={handleDeleteUser}
          error={loginError}
          syncing={syncClient.isLoggedIn}
          offlineLogin={offlineMode}
        />
      )}

      <Header
        inBook={!!currentNovel}
        bookTitle={currentNovel?.title}
        onBack={handleBackToLibrary}
        onSettings={() => setShowSettings(true)}
        onNotes={() => setShowNotes(true)}
      />
      <main className="flex-1 overflow-hidden relative">
        {/* Reading — always mounted so panel state survives */}
        <div style={{ display: !showSettings && currentNovel ? undefined : "none" }} className="h-full">
          <LocalErrorBoundary name="ReadingPanel">
            <ReadingPanel />
          </LocalErrorBoundary>
        </div>
        {/* Settings overlay */}
        {showSettings && (
          <div className="h-full overflow-auto">
            <ApiSettings onBack={() => setShowSettings(false)} />
          </div>
        )}
        {/* Notes overlay */}
        {showNotes && !currentNovel && (
          <div className="h-full overflow-auto">
            <GlobalNotes onBack={() => setShowNotes(false)} />
          </div>
        )}
        {/* Book select — key forces remount when sync completes */}
        {!currentNovel && !showSettings && !showNotes && (
          <div className="h-full overflow-auto" key={String(syncReady)}>
            <BookSelect />
          </div>
        )}
      </main>
      {debugMode && !isMobile && <DebugPanel />}
      {showShortcutHelp && (
        <ShortcutHelp
          shortcuts={[
            ...globalShortcuts,
            { key: "ArrowLeft", action: () => {}, description: "滚动: 上一章 / 翻页: 上一页" },
            { key: "ArrowRight", action: () => {}, description: "滚动: 下一章 / 翻页: 下一页" },
            { key: " ", action: () => {}, description: "翻页模式: 下一页" },
            { key: "+", action: () => {}, description: "增大字号" },
            { key: "-", action: () => {}, description: "减小字号" },
            { key: "i", action: () => {}, description: "切换沉浸模式" },
          ]}
          onClose={() => setShowShortcutHelp(false)}
        />
      )}
    </div>
  );
}
