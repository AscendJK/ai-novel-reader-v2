/**
 * DataMgr 组件 - 数据管理
 * 用于显示和删除各种数据
 */

import { getUserDB } from "@/db/database";
import { deleteGraph, deleteMap } from "@/db/repositories";
import { useSummaryStore } from "@/stores/summary-store";
import { syncClient } from "@/sync/sync-client";
import { Row } from "./Row";

interface DataMgrProps {
  /** 小说 ID */
  novelId: string;
  /** 总结列表 */
  summaries: { id: string; type: string }[];
  /** 是否有图谱 */
  hasGraph: boolean;
  /** 删除图谱回调 */
  onDeleteGraph: () => void;
  /** 是否有地图数据 */
  hasMap: boolean;
  /** 删除地图回调 */
  onDeleteMap: () => void;
  /** 笔记数量 */
  noteCount: { chapter: number; book: number };
  /** 笔记变更回调 */
  onNotesChanged: () => void;
}

export function DataMgr({
  novelId,
  summaries,
  hasGraph,
  onDeleteGraph,
  hasMap,
  onDeleteMap,
  noteCount,
  onNotesChanged,
}: DataMgrProps) {
  const { setSummaries } = useSummaryStore();

  // 删除指定类型的总结
  const del = async (type: string, label: string) => {
    if (!window.confirm(`确认删除所有 ${label}？`)) return;
    const db = getUserDB();
    const targets = summaries.filter((s) => s.type === type);
    const now = Date.now();
    for (const s of targets) {
      const existing = await db.summaries.get(s.id);
      if (existing) {
        await db.summaries.put({ ...existing, deleted: now, updatedAt: now });
      }
    }
    setSummaries((prev) => prev.filter((s) => s.type !== type));
    syncClient.pushNow();
  };

  // 删除图谱
  const delGraph = async () => {
    if (!window.confirm("确认删除人物关系图谱？")) return;
    await deleteGraph(novelId);
    onDeleteGraph();
    syncClient.pushNow();
  };

  // 删除地图
  const delMap = async () => {
    if (!window.confirm("确认删除小说地图？")) return;
    await deleteMap(novelId);
    onDeleteMap();
    syncClient.pushNow();
  };

  // 删除笔记
  const delNotesByFilter = async (isBook: boolean, label: string) => {
    if (!window.confirm(`确认删除所有 ${label}？此操作不可恢复。`)) return;
    const db = getUserDB();
    const all = await db.notes.where("novelId").equals(novelId).toArray();
    const targets = all.filter((n) =>
      isBook ? n.chapterId === "__book__" : n.chapterId !== "__book__"
    );
    const now = Date.now();
    for (const n of targets) {
      if (!n.deleted) {
        await db.notes.put({ ...n, deleted: now, updatedAt: now });
      }
    }
    onNotesChanged();
    syncClient.pushNow();
  };

  // 统计各类型数量
  const count = (t: string) => summaries.filter((s) => s.type === t).length;

  return (
    <div className="mt-1 space-y-0.5 text-xs">
      {count("chapter") > 0 && (
        <Row label={`章节总结 (${count("chapter")})`} onDelete={() => del("chapter", "章节总结")} />
      )}
      {count("global") > 0 && (
        <Row label="全书总览" onDelete={() => del("global", "全书总览")} />
      )}
      {count("timeline") > 0 && (
        <Row label="剧情时间线" onDelete={() => del("timeline", "剧情时间线")} />
      )}
      {count("characters") > 0 && (
        <Row label="人物关系分析" onDelete={() => del("characters", "人物关系分析")} />
      )}
      {hasGraph && (
        <Row label="人物关系图谱" onDelete={delGraph} />
      )}
      {hasMap && (
        <Row label="小说地图" onDelete={delMap} />
      )}
      {noteCount.chapter > 0 && (
        <Row label={`章节笔记 (${noteCount.chapter})`} onDelete={() => delNotesByFilter(false, "章节笔记")} />
      )}
      {noteCount.book > 0 && (
        <Row label={`全书笔记 (${noteCount.book})`} onDelete={() => delNotesByFilter(true, "全书笔记")} />
      )}
    </div>
  );
}
