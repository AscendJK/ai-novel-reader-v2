import { sharedDB, getUserDB } from "@/db/database";
import { userKey, getCurrentUsername } from "@/lib/user-utils";
import { useNovelStore } from "@/stores/novel-store";

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 延迟 revoke：Safari 在 click 后立即 revoke 会导致下载失败
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export async function exportNovelAsJSON(novelId: string) {
  const udb = getUserDB();
  const novel = await udb.novels.get(novelId);
  if (!novel) return;
  const chapters = await udb.chapters.where("novelId").equals(novelId).sortBy("index");
  const summaries = await udb.summaries.where("novelId").equals(novelId).toArray();
  const notes = await udb.notes.where("novelId").equals(novelId).toArray();

  const data = { novel, chapters, summaries, notes, exportedAt: Date.now() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  download(blob, `${novel.title}-${timestamp()}.json`);
}

export async function exportNovelAsTXT(novelId: string) {
  const udb = getUserDB();
  const novel = await udb.novels.get(novelId);
  if (!novel) return;
  const chapters = await udb.chapters.where("novelId").equals(novelId).sortBy("index");

  let text = `${novel.title}\n`;
  if (novel.author) text += `作者: ${novel.author}\n`;
  text += `\n${"=".repeat(40)}\n\n`;

  for (const ch of chapters) {
    text += `${ch.title}\n\n${ch.content}\n\n`;
  }

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  download(blob, `${novel.title}-${timestamp()}.txt`);
}

/** 当前用户的阅读进度与"最后打开"（存在 localStorage，不在 IndexedDB 里） */
function readUserLocalProgress(): { readingPositions: Record<string, unknown>; lastOpened: Record<string, unknown> } {
  const empty = { readingPositions: {}, lastOpened: {} };
  try {
    return {
      readingPositions: JSON.parse(localStorage.getItem(userKey("novel-reader-positions")) || "{}"),
      lastOpened: JSON.parse(localStorage.getItem(userKey("novel-reader-last-opened")) || "{}"),
    };
  } catch {
    return empty; // 进度损坏时不阻断备份
  }
}

export async function exportAllAsJSON() {
  const udb = getUserDB();
  const novels = await udb.novels.toArray();
  const chapters = await udb.chapters.toArray();
  const summaries = await udb.summaries.toArray();
  const notes = await udb.notes.toArray();
  // maps/graphs 与阅读进度此前不在备份范围内：用备份恢复过的用户，人物图谱、
  // 地图和全部阅读位置会静默消失（round 2 R-16）
  const maps = await udb.maps.toArray();
  const graphs = await udb.graphs.toArray();
  const progress = readUserLocalProgress();
  // Exclude sensitive API settings
  const settings = (await sharedDB.settings.toArray()).filter(
    (s) => !s.key.startsWith("api-providers") && !s.key.startsWith("api-active-provider")
  );

  const data = {
    novels, chapters, summaries, notes, maps, graphs,
    ...progress,
    username: getCurrentUsername(),
    settings, exportedAt: Date.now(), version: 2,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  download(blob, `小说阅读器备份-${timestamp()}.json`);
}

interface ImportData {
  novels?: Array<{ id: string; title: string; [key: string]: unknown }>;
  chapters?: Array<{ id: string; novelId: string; [key: string]: unknown }>;
  summaries?: Array<{ id: string; novelId: string; [key: string]: unknown }>;
  notes?: Array<{ id: string; novelId: string; [key: string]: unknown }>;
  maps?: Array<{ id: string; novelId: string; [key: string]: unknown }>;
  graphs?: Array<{ id: string; novelId: string; [key: string]: unknown }>;
  readingPositions?: Record<string, unknown>;
  lastOpened?: Record<string, unknown>;
  username?: string;
  settings?: Array<{ key: string; value: unknown }>;
  exportedAt?: number;
  version?: number;
}

export async function importFromJSON(file: File): Promise<{
  novels: number; chapters: number; summaries: number; notes: number; maps: number; graphs: number;
}> {
  const udb = getUserDB();
  const text = await file.text();
  let data: ImportData;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("导入文件格式无效，请确认是正确的 JSON 备份文件");
  }
  // 结构校验：只认"数组字段确实是数组"的备份。缺字段的老备份（v1）仍可导入，
  // 但一份被截断/被改坏的 JSON 若直接进事务，会在 put 阶段炸在半途留下半成品库
  if (typeof data !== "object" || data === null) throw new Error("备份内容不是对象");
  for (const key of ["novels", "chapters", "summaries", "notes", "maps", "graphs", "settings"] as const) {
    if (data[key] !== undefined && !Array.isArray(data[key])) {
      throw new Error(`备份字段 ${key} 不是数组，已中止导入（未改动任何数据）`);
    }
  }
  if (!Array.isArray(data.novels) && !Array.isArray(data.chapters)) {
    throw new Error("备份里既没有书籍也没有章节，不像本应用的备份文件");
  }

  let novelCount = 0, chapterCount = 0, summaryCount = 0, noteCount = 0, mapCount = 0, graphCount = 0;

  // Dexie 的 TS 重载最多支持 4 个表参数（运行时支持更多），与 repositories.ts
  // 里的处理保持一致用断言绕过
  await (udb.transaction as (...args: unknown[]) => Promise<void>)("rw",
    udb.novels, udb.chapters, udb.summaries, udb.notes, udb.maps, udb.graphs,
    async () => {
      for (const n of data.novels ?? []) {
        await udb.novels.put(n as unknown as Parameters<typeof udb.novels.put>[0]);
        novelCount++;
      }
      for (const ch of data.chapters ?? []) {
        await udb.chapters.put(ch as unknown as Parameters<typeof udb.chapters.put>[0]);
        chapterCount++;
      }
      for (const s of data.summaries ?? []) {
        await udb.summaries.put({
          ...s,
          updatedAt: (s.updatedAt as number | undefined) || Date.now(),
        } as unknown as Parameters<typeof udb.summaries.put>[0]);
        summaryCount++;
      }
      for (const n of data.notes ?? []) {
        await udb.notes.put({
          ...n,
          updatedAt: (n.updatedAt as number | undefined) || Date.now(),
        } as unknown as Parameters<typeof udb.notes.put>[0]);
        noteCount++;
      }
      // updatedAt 补齐：否则 gatherChanges 的 where("updatedAt") 永远收不到它们
      for (const m of data.maps ?? []) {
        await udb.maps.put({
          ...m, updatedAt: (m.updatedAt as number | undefined) || Date.now(),
        } as unknown as Parameters<typeof udb.maps.put>[0]);
        mapCount++;
      }
      for (const g of data.graphs ?? []) {
        await udb.graphs.put({
          ...g, updatedAt: (g.updatedAt as number | undefined) || Date.now(),
        } as unknown as Parameters<typeof udb.graphs.put>[0]);
        graphCount++;
      }
    });
  // Settings go to shared DB
  if (data.settings?.length) {
    for (const s of data.settings) { await sharedDB.settings.put(s); }
  }

  // 阅读进度写回当前用户的 localStorage 键（备份里的 username 只做提示，
  // 一律落在"当前登录用户"名下，避免把别人的进度灌进本账号）
  if (data.readingPositions && typeof data.readingPositions === "object") {
    try {
      const key = userKey("novel-reader-positions");
      const existing = JSON.parse(localStorage.getItem(key) || "{}");
      localStorage.setItem(key, JSON.stringify({ ...existing, ...data.readingPositions }));
      useNovelStore.getState().reloadReadingPositions();
    } catch (e) {
      console.warn("[export] 阅读进度恢复失败:", e);
    }
  }
  if (data.lastOpened && typeof data.lastOpened === "object") {
    try {
      localStorage.setItem(userKey("novel-reader-last-opened"), JSON.stringify(data.lastOpened));
    } catch { /* 配额满时忽略，不影响主数据 */ }
  }

  return { novels: novelCount, chapters: chapterCount, summaries: summaryCount, notes: noteCount, maps: mapCount, graphs: graphCount };
}
