import { useCallback, useRef } from "react";
import { useNovelStore } from "@/stores/novel-store";
import { useSummaryStore } from "@/stores/summary-store";
import { useUIStore } from "@/stores/ui-store";
import { useRAGStore } from "@/stores/rag-store";
import { loadAllNovels, loadSummaries, cleanupDeletedRecords, deleteUserData, loadNovel } from "@/db/repositories";
import { getUserDB, setCurrentUser, deleteUserDB } from "@/db/database";
import { shouldDownloadNovel, shouldDeleteLocalNovel, rekeyNovelOwnedRows } from "@/sync/novel-reconciliation";
import { syncClient } from "@/sync/sync-client";
import { flushPendingLeaves } from "@/sync/pending-leave";
import { gatherChanges, applyServerData } from "@/sync/sync-bridge";
import type { SyncData } from "@/sync/types";
import { apiFetch, getEffectiveServerUrl } from "@/lib/api-client";
import { broadcast } from "@/lib/broadcast";
import { getAiRunning } from "@/lib/ai-state";
import { dedupSummaries } from "@/lib/dedup-utils";
import { downloadModel } from "@/rag/model-loader";
import { showToast } from "@/lib/toast-store";
import { addLocalUser, removeLocalUser, getLocalUsers } from "@/db/repositories";

interface SyncOrchestrationOptions {
  onSyncReady: () => void;
  setLocalUsers: (users: string[]) => void;
}

export function useSyncOrchestration({ onSyncReady, setLocalUsers }: SyncOrchestrationOptions) {
  const addNovel = useNovelStore((s) => s.addNovel);
  const setSummaries = useSummaryStore((s) => s.setSummaries);
  const syncStarted = useRef(false);
  const kickedRef = useRef(false);

  const handleKicked = useCallback(async (kickedUser: string) => {
    if (kickedRef.current) return;
    kickedRef.current = true;
    alert("该账号已在另一设备登录，当前会话已下线。\n\n您的本地数据已保留，重新登录后可继续使用。");
    // 注意：不清除 sync-clientId —— 保留设备标识，重新登录时会被识别为
    // 已知设备（与 sync-client.ts handleKicked 的意图一致），避免服务器
    // knownDevices 残留旧记录、重登变成"新设备"。
    ["sync-username", "sync-token",
     `novel-reader-last-sync-time:${kickedUser}`,
     "sync-auto-offline",
    ].forEach((k) => localStorage.removeItem(k));
    window.location.reload();
  }, []);

  const syncJoinedNovels = useCallback(async () => {
    try {
      const username = localStorage.getItem("sync-username");
      if (!username) return;

      // 先补发积压的 leave，再拉服务器列表：否则这次拉回来的 joined=true 会
      // 在同一次流程里就把用户早已删掉的书重新下载（R-17）
      await flushPendingLeaves();

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
      // 按 title 认亲是为处理"同一本书在两台设备各自导入"（本地 id 不同但内容相同），
      // 避免重复上传。但仅凭 title 匹配会把同名不同内容的不同书错误合并：本地章节
      // 改键后与服务器章节同 id 相互覆盖，总结/笔记/图谱全部归并到同一 serverId，
      // 数据无法找回。totalChars 是文件指纹（同文件双端导入必然一致），加上它把
      // 误合并概率降到最低；漏认亲的代价只是服务器多一份同名书，远轻于数据丢失。
      const serverTitleMap = new Map<string, { id: string; totalChars: number }>();
      for (const n of list) {
        if (!serverTitleMap.has(n.title)) {
          serverTitleMap.set(n.title, { id: n.id, totalChars: n.totalChars });
        }
      }

      for (const local of localNovels) {
        if (serverNovelIds.has(local.id)) continue;
        try {
          const candidate = serverTitleMap.get(local.title);
          if (candidate && candidate.totalChars === local.totalChars) {
            const serverId = candidate.id;
            const oldId = local.id;
            const chapters = await udb.chapters.where("novelId").equals(oldId).toArray();
            const summaries = await udb.summaries.where("novelId").equals(oldId).toArray();
            const notes = await udb.notes.where("novelId").equals(oldId).toArray();
            const maps = await udb.maps.where("novelId").equals(oldId).toArray();
            const graphs = await udb.graphs.where("novelId").equals(oldId).toArray();
            await udb.transaction("rw", [udb.novels, udb.chapters, udb.summaries, udb.notes, udb.maps, udb.graphs], async () => {
              await udb!.novels.delete(oldId);
              await udb!.chapters.where("novelId").equals(oldId).delete();
              // 章节 id 重键的同时必须重写 summaries/notes 的 chapterId——否则
              // 章节级摘要/笔记指向旧 id，按章节查询全部落空
              const chapterIdMap = new Map<string, string>();
              for (const ch of chapters) {
                const newChapterId = `${serverId}-ch${ch.index}`;
                chapterIdMap.set(ch.id, newChapterId);
                await udb!.chapters.put({ ...ch, novelId: serverId, id: newChapterId });
              }
              const remapChapterId = (oldChapterId: string | undefined) =>
                oldChapterId ? chapterIdMap.get(oldChapterId) : undefined;
              for (const s of summaries) {
                const mapped = remapChapterId(s.chapterId);
                await udb!.summaries.put(mapped ? { ...s, novelId: serverId, chapterId: mapped } : { ...s, novelId: serverId });
              }
              for (const n of notes) {
                const mapped = remapChapterId(n.chapterId);
                await udb!.notes.put(mapped ? { ...n, novelId: serverId, chapterId: mapped } : { ...n, novelId: serverId });
              }
              await rekeyNovelOwnedRows(udb!.maps, maps, serverId, "maps");
              await rekeyNovelOwnedRows(udb!.graphs, graphs, serverId, "graphs");
              // novels 行必须重键写入（旧实现只删不写，靠下载分支兜底补回；
              // 现在"novels 缺失但章节在"已改判为用户已删，缺口必须在此补上，
              // 否则认亲后的书永远进不了书架）
              await udb!.novels.put({ ...local, id: serverId });
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
        // 安全策略：本地已有完整数据的小说绝不自动删除。
        // 历史教训：join 请求是 fire-and-forget，后端重启/网络闪断/join 接口异常
        // 都会导致服务器 joined=false 而本地数据完整。此前此处会 deleteNovel 软删
        // 本地副本，导致小说连同章节目录/摘要/笔记/地图/图谱全部丢失且不会重新
        // 下载。现在只尝试幂等恢复 join，无论成败都保留本地数据，下次同步再试。
        if (!shouldDeleteLocalNovel()) {
          try {
            const joinResp = await apiFetch(`/api/novels/${sn.id}/join`, { method: "POST" });
            if (joinResp.ok) continue; // 恢复成功，保留本地副本
            // join 失败（如服务器 404/500）：保留本地副本，不删除，下次再试
          } catch {
            // 服务器不可达：保留本地副本，不删除，下次再试
          }
        }
      }

      for (const sn of list) {
        if (!sn.joined) continue;
        udb = safeGetDB();
        if (!udb) break;
        const existing = await udb.novels.get(sn.id).catch(() => null);
        if (existing) {
          // 本地已有记录：检查章节完整性。若章节全部缺失或被软删（历史误删
          // 或导入异常），视为数据损坏，从服务器重新下载恢复（覆盖写入会
          // 物理清除 deleted 标记）。目录因此可以自愈，无需用户重新导入。
          const localChapters = await udb.chapters
            .where("novelId").equals(sn.id).toArray().catch(() => []);
          if (!shouldDownloadNovel(existing, localChapters)) continue; // 正常，跳过
          console.warn(`[sync] novel ${sn.id} 本地章节缺失或已软删，从服务器重新下载恢复`);
        } else {
          // novels 记录不存在但章节墓碑仍在 = 用户已删除该书（deleteNovel 硬删
          // novel 行 + 软删章节）。此时服务器仍 joined 多半是 /leave 请求失败的
          // 残留——绝不能重新下载，否则用户明确删除的书整本复活且墓碑被清。
          const tombstone = await udb.chapters
            .where("novelId").equals(sn.id).limit(1).toArray().catch(() => []);
          if (tombstone.length > 0) {
            console.log(`[sync] novel ${sn.id} 本地已删除（章节墓碑在），跳过重新下载`);
            continue;
          }
          // 记录与章节都不存在：从未本地化过的 joined 书，正常走下载
        }
        const chResp = await apiFetch(`/api/novels/${sn.id}/chapters`);
        if (!chResp.ok) continue;
        const chapters = await chResp.json();
        udb = safeGetDB();
        if (!udb) break;
        await udb.transaction("rw", udb.novels, udb.chapters, async () => {
          await udb!.novels.put({
            id: sn.id, title: sn.title, author: sn.author,
            fileName: sn.fileName, fileFormat: sn.fileFormat as "txt" | "epub",
            totalChars: sn.totalChars,
            createdAt: sn.createdAt, updatedAt: sn.updatedAt || Date.now(),
          });
          // 覆盖写入：物理清除可能存在的 deleted 软删标记
          await udb!.chapters.where("novelId").equals(sn.id).delete();
          for (const ch of chapters) {
            await udb!.chapters.put({
              id: ch.id, novelId: sn.id, index: ch.index,
              title: ch.title, content: ch.content,
              startOffset: ch.startOffset ?? 0, endOffset: ch.endOffset ?? ch.content?.length ?? 0,
            });
          }
        });
        addNovel({ ...sn, chapters, chapterCount: chapters.length, fileFormat: sn.fileFormat as "txt" | "epub" });
      }
    } catch (e) { console.error("syncJoinedNovels:", e); }
  }, [addNovel]);
const applySyncData = useCallback(async (data: SyncData) => {
    await applyServerData(data);
    if (data.progress?.readingPositions) {
      useNovelStore.setState((s) => {
        const merged = { ...s.readingPositions };
        for (const [novelId, serverPos] of Object.entries(data.progress!.readingPositions)) {
          const existingPos = s.readingPositions[novelId];
          if (!existingPos || (serverPos.updatedAt || 0) >= (existingPos.updatedAt || 0)) {
            // 保留本地独有字段（scrollTop, chapterOffset），服务器数据更新时覆盖
            merged[novelId] = { ...existingPos, ...serverPos };
          }
        }
        return { readingPositions: merged };
      });
    }
    const { currentNovel: cn } = useNovelStore.getState();
    if (cn) {
      const s = await loadSummaries(cn.id);
      if (s.length > 0) {
        setSummaries(dedupSummaries(s));
      }
    }
    syncJoinedNovels();
  }, [setSummaries, syncJoinedNovels]); // syncJoinedNovels is defined below, stable via useCallback


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
    await newDb.transaction("rw", [newDb.novels, newDb.chapters, newDb.summaries, newDb.notes, newDb.maps, newDb.graphs], async () => {
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

  // 孤儿数据补传：push 时服务器因小说尚未上传而跳过入库的数据。
  // 收到 orphanedNovelIds 后，若本地存在对应小说则补传到服务器，
  // 成功后立即 pushNow 重试，把之前被跳过的孤儿数据同步上去。
  const handleOrphaned = useCallback(async (novelIds: string[]) => {
    let uploadedAny = false;
    for (const novelId of novelIds) {
      try {
        const novel = await loadNovel(novelId, undefined, true);
        if (!novel) continue; // 本地无此小说，等待用户上传或跳过
        const r = await apiFetch(`/api/novels`, {
          method: "POST",
          body: JSON.stringify({
            novel: {
              id: novel.id, title: novel.title, author: novel.author,
              fileName: novel.fileName, fileFormat: novel.fileFormat,
              totalChars: novel.totalChars, chapterCount: novel.chapterCount,
              createdAt: novel.createdAt,
            },
            chapters: novel.chapters.map((c) => ({
              id: c.id, novelId: c.novelId, index: c.index,
              title: c.title, content: c.content,
              startOffset: c.startOffset, endOffset: c.endOffset,
            })),
          }),
        });
        if (!r?.ok) { console.warn(`[sync-orphan] 上传小说 ${novel.title} 失败: HTTP ${r?.status}`); continue; }
        const data = await r.json().catch(() => ({}));
        if (data?.novelId) {
          try { await apiFetch(`/api/novels/${data.novelId}/join`, { method: "POST" }); } catch { /* ignore */ }
          uploadedAny = true;
          console.log(`[sync-orphan] 已补传小说 ${novel.title}`);
        }
      } catch (e) {
        console.warn(`[sync-orphan] 补传小说 ${novelId} 出错:`, e);
      }
    }
    if (uploadedAny) {
      // 补传成功，立即重推孤儿数据
      syncClient.pushNow().catch(() => {});
    }
  }, []);

  // 仅注册同步 handler（gatherChanges/applyData/回调），不触发立即同步、
  // 可重复调用（syncClient.start 内部会先 stop 防定时器重复）。
  // 注册后同步挂起"定时器驱动"的推送，直到 startSync 解除——慢登录期间
  // 定时器不能赶在"合并/覆盖"提示之前把本地数据推上服务器
  const prepareSync = useCallback(() => {
    if (syncStarted.current) return;
    syncStarted.current = true;
    syncClient.start({
      gatherChanges,
      applyData: applySyncData,
      isAiRunning: getAiRunning,
      onKicked: handleKicked,
      onConflict: handleSyncConflict,
      onOrphaned: handleOrphaned,
    });
    syncClient.setTimerSyncGate(true);
  }, [applySyncData, handleKicked, handleSyncConflict, handleOrphaned]);

  const startSync = useCallback(() => {
    prepareSync();
    syncClient.setTimerSyncGate(false);
    setTimeout(() => {
      syncClient.syncOnce({ force: true }).then(() => syncJoinedNovels()).catch(() => {
        syncJoinedNovels();
      });
      cleanupDeletedRecords().catch(() => {});
    }, 0);
  }, [prepareSync, syncJoinedNovels]);

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
    // 回滚判定要在改身份之前拍快照：用户名列表被 addLocalUser 覆写后，
    // 就分不清"这个用户本来就存在"还是"本次登录新建的"
    const prevUsername = existingUser;
    const userPreexisted = getLocalUsers().includes(username);
    localStorage.setItem("sync-username", username);
    setCurrentUser(username);
    addLocalUser(username);
    setLocalUsers(getLocalUsers());
    // 通知其他标签页：本浏览器的身份已切换。它们各自的 _userDB 与 syncClient
    // 用户名仍是旧值，若不重绑就会用新用户的 localStorage 键配旧用户的 IndexedDB
    // 库继续同步（浏览器内跨用户串号，round 2 R-18）
    broadcast.send("user-switched", username);

    // 切换用户必须同时清掉内存中的阅读进度与摘要缓存：
    // - readingPositions 残留旧用户进度会被下方 reloadReadingPositions 按 updatedAt
    //   合并进新账号并持久化、随同步扩散（跨用户数据串号）
    // - summary store 残留旧用户摘要会混入新用户的 AI 上下文与界面
    useNovelStore.setState({ novels: [], currentNovel: null, readingPositions: {} });
    useSummaryStore.getState().setSummaries([]);

    // 重新从 localStorage 加载当前用户的阅读进度。
    // 阅读进度存于 localStorage（key 带用户名后缀），但 store 只在模块加载时
    // 读一次——应用启动时未登录读到的是空 key。登录后必须重新加载，
    // 否则离线重登（syncOnce 失败、无服务器合并）时打开小说会回到第一章。
    useNovelStore.getState().reloadReadingPositions();

    // 先注册同步 handler（不触发立即同步）：下方冲突分支里的 syncOnce 需要
    // gatherChanges/applyData 已就位才能工作。周期同步的 t=0 推送仍然推迟到
    // 冲突决策完成之后（见 startSync 调用点）——否则本地数据会先行合并进
    // 服务器，用户选"覆盖"时服务器已被污染。
    prepareSync();

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
          `2 - 覆盖：用服务器数据覆盖本地（警告：将永久删除本地全部数据，不可恢复！）\n` +
          `3 - 改名：本地数据改名存为新用户`,
          "1"
        );

        if (choice === "2") {
          await clearLocalData();
          // "覆盖"= 丢弃本地数据：内存中残留的旧进度/摘要必须一并清掉，
          // 否则下方 syncOnce 会把它们当本地变更推上服务器，覆盖语义失真
          useNovelStore.setState({ novels: [], currentNovel: null, readingPositions: {} });
          useSummaryStore.getState().setSummaries([]);
          try {
            await syncClient.syncOnce({ force: true });
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
                  await syncClient.syncOnce({ force: true });
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
            await syncClient.syncOnce({ force: true });
            await syncJoinedNovels();
            serverSynced = true;
          } catch { /* syncOnce 内部已处理错误 */ }
        }
      } else {
        try {
          await syncClient.syncOnce({ force: true });
          await syncJoinedNovels();
          serverSynced = true;
        } catch { /* syncOnce 内部已处理错误 */ }
      }
    }

    // 服务器明确拒绝（404 用户不存在 / 409 冲突）时必须把"身份"整体回滚，而不
    // 只是 sync-username 那一个键：React 与 Dexie 若仍指向被拒的用户名，用户会
    // 落进一个没有 novels 的幻影库——笔记写进幻影库、阅读进度却按上一个名字
    // 存进 localStorage，重启后两边对不上（round 2 R-14）。
    // 网络错误不在本分支内：那时 loginResult.error 为空，按既定设计保留用户名走离线登录。
    if (!loginResult.success && loginResult.error) {
      if (!userPreexisted) removeLocalUser(username);
      setLocalUsers(getLocalUsers());
      useNovelStore.setState({ novels: [], currentNovel: null, readingPositions: {} });
      useSummaryStore.getState().setSummaries([]);
      if (prevUsername && prevUsername !== username) {
        localStorage.setItem("sync-username", prevUsername);
        setCurrentUser(prevUsername);
        useNovelStore.getState().reloadReadingPositions();
        broadcast.send("user-switched", prevUsername);
        window.alert(`登录失败：${loginResult.error}`);
        // prepareSync 已打开登录门控，不解除就会永远不再周期同步（R-51 的门侧）
        startSync();
        onSyncReady();
      } else {
        // 之前没有登录身份：回到未登录态，留在登录界面，不启动同步
        localStorage.removeItem("sync-username");
        syncClient.logout();
        syncStarted.current = false;
        window.alert(`登录失败：${loginResult.error}`);
      }
      return;
    }

    // 登录与冲突决策均已完成（或明确失败），现在才启动周期同步（含心跳）
    startSync();

    if (!serverSynced) {
      const novels = await loadAllNovels();
      novels.forEach((n) => addNovel(n));
    }

    const store = useRAGStore.getState();
    const defaultModelKey = "Xenova/bge-small-zh-v1.5";
    const hasServer = !!getEffectiveServerUrl();
    if (hasServer && !store.isModelDownloaded(defaultModelKey) && !store.currentDownload) {
      downloadModel(defaultModelKey).catch(() => {});
    }

    onSyncReady();
    useUIStore.getState().setDebugMode(false);
  }, [clearLocalData, prepareSync, startSync, syncJoinedNovels, migrateUserData, addNovel, onSyncReady, setLocalUsers]);

  const handleDeleteUser = useCallback(async (username: string) => {
    // 先捕获判断依据：syncClient.logout() 会清掉 localStorage 的 sync-username，
    // 之后再按 localStorage 判断"是否当前用户"恒为 false，清理分支失活
    const wasCurrentUser = localStorage.getItem("sync-username") === username;
    // 删除的是当前登录用户：先停同步客户端（否则心跳/定时器继续空转报错，
    // 服务器 session 不断开还会显示该用户"仍在线"几分钟）
    if (syncClient.user === username) {
      syncClient.logout();
      syncStarted.current = false;
    }
    await deleteUserData(username);
    setLocalUsers(getLocalUsers());
    if (wasCurrentUser) {
      // logout 刻意保留 clientId（已知设备复用），但用户已被删除，设备标识一并清除
      localStorage.removeItem("sync-clientId");
      localStorage.removeItem(`novel-reader-last-sync-time:${username}`);
      localStorage.removeItem("sync-auto-offline");
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
