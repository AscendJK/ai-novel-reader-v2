import { useCallback, useRef } from "react";
import { useNovelStore } from "@/stores/novel-store";
import { useSummaryStore } from "@/stores/summary-store";
import { useUIStore } from "@/stores/ui-store";
import { useRAGStore } from "@/stores/rag-store";
import { loadAllNovels, loadSummaries, deleteNovel, cleanupDeletedRecords, deleteUserData } from "@/db/repositories";
import { getUserDB, setCurrentUser, deleteUserDB } from "@/db/database";
import { syncClient } from "@/sync/sync-client";
import { gatherChanges, applyServerData } from "@/sync/sync-bridge";
import type { SyncData } from "@/sync/types";
import { apiFetch, getServerUrl } from "@/lib/api-client";
import { getAiRunning } from "@/lib/ai-state";
import { dedupSummaries } from "@/lib/dedup-utils";
import { downloadModel } from "@/rag/model-loader";
import { showToast } from "@/components/common/Toast";
import { addLocalUser, removeLocalUser, getLocalUsers } from "@/db/repositories";

interface SyncOrchestrationOptions {
  onSyncReady: () => void;
  setLocalUsers: (users: string[]) => void;
}

export function useSyncOrchestration({ onSyncReady, setLocalUsers }: SyncOrchestrationOptions) {
  const setCurrentNovel = useNovelStore((s) => s.setCurrentNovel);
  const addNovel = useNovelStore((s) => s.addNovel);
  const { setSummaries } = useSummaryStore();
  const syncStarted = useRef(false);
  const kickedRef = useRef(false);

  const handleKicked = useCallback(async (kickedUser: string) => {
    if (kickedRef.current) return;
    kickedRef.current = true;
    alert("该账号已在另一设备登录，当前会话已下线。\n\n您的本地数据已保留，重新登录后可继续使用。");
    ["sync-username", "sync-token",
     `novel-reader-last-sync-time:${kickedUser}`,
     "sync-auto-offline",
    ].forEach((k) => localStorage.removeItem(k));
    window.location.reload();
  }, []);

  const applySyncData = useCallback(async (data: SyncData) => {
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
  }, [setSummaries]); // syncJoinedNovels is defined below, stable via useCallback

  const syncJoinedNovels = useCallback(async () => {
    try {
      const username = localStorage.getItem("sync-username");
      if (!username) return;

      const resp = await apiFetch(`/api/novels?username=${encodeURIComponent(username)}`);
      if (!resp.ok) return;
      const list: Array<{ id: string; title: string; author?: string; fileName: string; fileFormat: string; totalChars: number; chapterCount: number; createdAt: number; updatedAt: number; joined?: boolean }> = await resp.json();

      const serverNovelIds = new Set(list.map((n) => n.id));

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

      const localNovels = await udb.novels.toArray().catch(() => []);
      const serverTitleMap = new Map<string, string>();
      for (const n of list) {
        serverTitleMap.set(n.title, n.id);
      }

      for (const local of localNovels) {
        if (serverNovelIds.has(local.id)) continue;
        try {
          const serverId = serverTitleMap.get(local.title);
          if (serverId) {
            const oldId = local.id;
            const chapters = await udb.chapters.where("novelId").equals(oldId).toArray();
            const summaries = await udb.summaries.where("novelId").equals(oldId).toArray();
            const notes = await udb.notes.where("novelId").equals(oldId).toArray();
            const maps = await udb.maps.where("novelId").equals(oldId).toArray();
            const graphs = await udb.graphs.where("novelId").equals(oldId).toArray();
            await udb.transaction("rw", udb.novels, udb.chapters, udb.summaries, udb.notes, udb.maps, udb.graphs, async () => {
              await udb.novels.delete(oldId);
              await udb.chapters.where("novelId").equals(oldId).delete();
              for (const ch of chapters) {
                await udb.chapters.put({ ...ch, novelId: serverId, id: `${serverId}-ch${ch.index}` });
              }
              for (const s of summaries) { await udb.summaries.put({ ...s, novelId: serverId }); }
              for (const n of notes) { await udb.notes.put({ ...n, novelId: serverId }); }
              for (const m of maps) { await udb.maps.put({ ...m, novelId: serverId }); }
              for (const g of graphs) { await udb.graphs.put({ ...g, novelId: serverId }); }
            });
            const { readingPositions } = useNovelStore.getState();
            const oldPos = readingPositions[oldId];
            if (oldPos) {
              const newChapterId = `${serverId}-ch${oldPos.chapterIndex}`;
              useNovelStore.getState().saveReadingPosition(serverId, newChapterId, oldPos.chapterIndex, undefined, oldPos.chapterOffset);
              const latestPositions = { ...useNovelStore.getState().readingPositions };
              delete latestPositions[oldId];
              useNovelStore.setState({ readingPositions: latestPositions });
            }
            await apiFetch(`/api/novels/${serverId}/join`, { method: "POST" })
              .catch(() => {});
            continue;
          }

          const chapters = await udb.chapters.where("novelId").equals(local.id).sortBy("index");
          const uploadResp = await apiFetch("/api/novels", {
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
          if (uploadResp.ok) {
            await apiFetch(`/api/novels/${local.id}/join`, { method: "POST" }).catch(() => {});
          }
        } catch { /* upload failed, will retry next sync */ }
      }

      const currentNovelId = useNovelStore.getState().currentNovel?.id;
      const unjoinedServerNovels = list.filter((n) => !n.joined && serverNovelIds.has(n.id));
      for (const sn of unjoinedServerNovels) {
        if (sn.id === currentNovelId) continue;
        const existsLocally = localNovels.find((l) => l.id === sn.id);
        if (!existsLocally) continue;
        await deleteNovel(sn.id).catch(() => {});
        useNovelStore.getState().removeNovel(sn.id);
      }

      for (const sn of list) {
        if (!sn.joined) continue;
        udb = safeGetDB();
        if (!udb) break;
        const existing = await udb.novels.get(sn.id).catch(() => null);
        if (existing) continue;
        const chResp = await apiFetch(`/api/novels/${sn.id}/chapters`);
        if (!chResp.ok) continue;
        const chapters = await chResp.json();
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
  }, [addNovel]);

  const clearLocalData = useCallback(async () => {
    const currentUser = localStorage.getItem("sync-username");
    if (currentUser) {
      await deleteUserData(currentUser).catch(() => {});
    }
  }, []);

  const migrateUserData = useCallback(async (oldUsername: string, newUsername: string) => {
    const oldDb = getUserDB();
    const [novels, chapters, summaries, notes, maps, graphs] = await Promise.all([
      oldDb.novels.toArray(),
      oldDb.chapters.toArray(),
      oldDb.summaries.toArray(),
      oldDb.notes.toArray(),
      oldDb.maps.toArray(),
      oldDb.graphs.toArray(),
    ]);
    syncClient.setUsername(newUsername);
    setCurrentUser(newUsername);
    localStorage.setItem("sync-username", newUsername);
    addLocalUser(newUsername);
    const newDb = getUserDB();
    await newDb.transaction("rw", newDb.novels, newDb.chapters, newDb.summaries, newDb.notes, newDb.maps, newDb.graphs, async () => {
      if (novels.length) await newDb.novels.bulkPut(novels);
      if (chapters.length) await newDb.chapters.bulkPut(chapters);
      if (summaries.length) await newDb.summaries.bulkPut(summaries);
      if (notes.length) await newDb.notes.bulkPut(notes);
      if (maps.length) await newDb.maps.bulkPut(maps);
      if (graphs.length) await newDb.graphs.bulkPut(graphs);
    });
    await deleteUserDB(oldUsername).catch(() => {});
    removeLocalUser(oldUsername);
  }, []);

  const handleSyncConflict = useCallback(async (conflictUsername: string): Promise<"overwrite" | "rename"> => {
    const choice = window.confirm(
      `服务器上已存在用户名 "${conflictUsername}"（可能来自其他设备）。\n\n` +
      `点击"确定"拉取服务器数据覆盖本地（另一设备将被踢下线）\n` +
      `点击"取消"修改本地用户名`
    );
    if (choice) return "overwrite";
    const newName = prompt("请输入新的用户名：", conflictUsername + "-2");
    if (newName && newName.trim() && newName.trim() !== conflictUsername) {
      const trimmedName = newName.trim();
      try {
        await migrateUserData(conflictUsername, trimmedName);
      } catch (e) {
        console.error("[sync] data migration failed:", e);
        syncClient.setUsername(trimmedName);
        setCurrentUser(trimmedName);
      }
      return "rename";
    }
    showToast("已跳过冲突解决，稍后同步时会再次提示。", "info");
    return "rename";
  }, [migrateUserData]);

  const startSync = useCallback(() => {
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
      syncClient.syncOnce().then(() => syncJoinedNovels()).catch(() => {
        syncJoinedNovels();
      });
      cleanupDeletedRecords().catch(() => {});
    }, 0);
  }, [applySyncData, handleKicked, handleSyncConflict, syncJoinedNovels]);

  const handleLogin = useCallback(async (username: string) => {
    const onlineStatus = await syncClient.checkUserOnline(username);
    if (onlineStatus && onlineStatus.online) {
      const kick = window.confirm(
        `用户 "${username}" 当前在其他设备上在线（${onlineStatus.deviceCount} 个设备）。\n\n` +
        `点击"确定"：踢掉其他设备，继续登录\n` +
        `点击"取消"：取消本次登录`
      );
      if (!kick) return;
    }

    const existingUser = localStorage.getItem("sync-username");
    if (existingUser && existingUser !== username) {
      const hasLocalData = await getUserDB().novels.count().then((c) => c > 0).catch(() => false);
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

    if (existingUser && existingUser !== username) {
      syncClient.logout();
      syncStarted.current = false;
    }
    localStorage.setItem("sync-username", username);
    setCurrentUser(username);
    addLocalUser(username);
    setLocalUsers(getLocalUsers());

    useNovelStore.setState({ novels: [], currentNovel: null });

    startSync();

    let serverSynced = false;
    let loginResult: { success: boolean; error?: string } = { success: false };
    try {
      loginResult = await syncClient.login(username, "join");
      if (!loginResult.success) {
        loginResult = await syncClient.login(username, "create");
      }
    } catch {
      syncClient.markServerUnreachable();
    }
    if (loginResult.success) {
      syncClient.resetAutoOffline();
      if (useUIStore.getState().offlineMode) useUIStore.getState().setOfflineMode(false);

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
        const choice = window.prompt(
          `服务器上已有用户 "${username}" 的数据（${serverNovelCount} 本小说），本地也有数据（${localNovelCount} 本小说）。\n\n` +
          `请选择处理方式（输入数字）：\n` +
          `1 - 合并：两边数据合并（推荐）\n` +
          `2 - 覆盖：用服务器数据覆盖本地\n` +
          `3 - 改名：本地数据改名存为新用户`,
          "1"
        );

        if (choice === "2") {
          await clearLocalData();
          useNovelStore.setState({ novels: [], currentNovel: null });
          try {
            await syncClient.syncOnce();
            await syncJoinedNovels();
            serverSynced = true;
          } catch { /* syncOnce 内部已处理错误 */ }
        } else if (choice === "3") {
          const newName = window.prompt("请输入新的用户名：", username + "-local");
          if (newName && newName.trim() && newName.trim() !== username) {
            const trimmedName = newName.trim();
            try {
              await migrateUserData(username, trimmedName);
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
          try {
            await syncClient.syncOnce();
            await syncJoinedNovels();
            serverSynced = true;
          } catch { /* syncOnce 内部已处理错误 */ }
        }
      } else {
        try {
          await syncClient.syncOnce();
          await syncJoinedNovels();
          serverSynced = true;
        } catch { /* syncOnce 内部已处理错误 */ }
      }
    }

    if (!serverSynced) {
      const novels = await loadAllNovels();
      novels.forEach((n) => addNovel(n));
    }

    const store = useRAGStore.getState();
    const defaultModelKey = "Xenova/bge-small-zh-v1.5";
    const hasServer = !!getServerUrl();
    if (hasServer && !store.isModelDownloaded(defaultModelKey) && !store.currentDownload) {
      downloadModel(defaultModelKey).catch(() => {});
    }

    onSyncReady();
    useUIStore.getState().setDebugMode(false);
  }, [clearLocalData, startSync, syncJoinedNovels, migrateUserData, addNovel, onSyncReady, setLocalUsers]);

  const handleDeleteUser = useCallback(async (username: string) => {
    await deleteUserData(username);
    setLocalUsers(getLocalUsers());
    if (localStorage.getItem("sync-username") === username) {
      localStorage.removeItem("sync-username");
      localStorage.removeItem("sync-clientId");
      localStorage.removeItem("sync-token");
    }
  }, [setLocalUsers]);

  return {
    handleLogin,
    handleDeleteUser,
    handleKicked,
    startSync,
    syncJoinedNovels,
  };
}
