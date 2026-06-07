/**
 * 全书分析 Tab 组件
 * 从 SummaryPanel.tsx 中提取
 */

import { useState, useEffect } from "react";
import { Clock, Users, BookOpen } from "lucide-react";
import { SubItem } from "../shared/SubItem";
import { NovelMapSection } from "../shared/NovelMapSection";
import type { SummaryItem } from "@/stores/summary-store";
import type { GraphData, MapData } from "@/hooks/useSummarizer";
import { loadMap } from "@/db/repositories";

interface BookTabProps {
  /** 小说 ID */
  novelId: string;
  /** 时间线总结 */
  timelineSummaries: SummaryItem[];
  /** 人物分析总结 */
  characterSummaries: SummaryItem[];
  /** 全书总览总结 */
  globalSummaries: SummaryItem[];
  /** 当前展开的子项 */
  bookSub: string | null;
  /** 设置展开的子项 */
  setBookSub: (sub: string | null) => void;
  /** 是否正在加载（其他功能） */
  loading: boolean;
  /** 时间线是否正在加载 */
  timelineLoading?: boolean;
  /** 人物分析是否正在加载 */
  characterLoading?: boolean;
  /** 全书总览是否正在加载 */
  globalLoading?: boolean;
  /** 地图是否正在加载 */
  mapLoading?: boolean;
  /** 图谱数据 */
  characterGraphData: GraphData | null;
  /** 生成时间线 */
  onGenerateTimeline: () => void;
  /** 重新生成时间线 */
  onRegenerateTimeline: () => void;
  /** 生成人物分析 */
  onGenerateCharacters: () => void;
  /** 重新生成人物分析 */
  onRegenerateCharacters: () => void;
  /** 生成图谱 */
  onGenerateGraph: () => Promise<void>;
  /** 重新生成图谱 */
  onRegenerateGraph: () => Promise<void>;
  /** 生成全书总览 */
  onGenerateGlobal: () => void;
  /** 重新生成全书总览 */
  onRegenerateGlobal: () => void;
  /** 生成小说地图 */
  onGenerateMap: () => Promise<MapData | null>;
  /** 重新生成小说地图 */
  onRegenerateMap: () => Promise<MapData | null>;
}

export function BookTab({
  novelId,
  timelineSummaries,
  characterSummaries,
  globalSummaries,
  bookSub,
  setBookSub,
  loading,
  timelineLoading = false,
  characterLoading = false,
  globalLoading = false,
  mapLoading = false,
  characterGraphData,
  onGenerateTimeline,
  onRegenerateTimeline,
  onGenerateCharacters,
  onRegenerateCharacters,
  onGenerateGraph,
  onRegenerateGraph,
  onGenerateGlobal,
  onRegenerateGlobal,
  onGenerateMap,
  onRegenerateMap,
}: BookTabProps) {
  // 地图数据状态
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [mapUpdatedAt, setMapUpdatedAt] = useState<number | undefined>();
  const [loadingMap, setLoadingMap] = useState(true);

  // 从 IndexedDB 加载地图数据
  useEffect(() => {
    let cancelled = false;
    setLoadingMap(true);
    const load = async () => {
      try {
        const { data, updatedAt } = await loadMap(novelId);
        if (!cancelled) {
          setMapData(data);
          setMapUpdatedAt(updatedAt);
        }
      } catch {
        if (!cancelled) {
          setMapData(null);
          setMapUpdatedAt(undefined);
        }
      } finally {
        if (!cancelled) {
          setLoadingMap(false);
        }
      }
    };
    load();
    return () => { cancelled = true; };
  }, [novelId]);

  return (
    <div className="px-2.5 pt-2 pb-2 space-y-1">
      {/* 剧情时间线 */}
      <SubItem
        label="剧情时间线"
        icon={<Clock className="h-3 w-3" />}
        isOpen={bookSub === "timeline"}
        onClick={() => setBookSub(bookSub === "timeline" ? null : "timeline")}
        summaries={timelineSummaries}
        onGenerate={onGenerateTimeline}
        onRegenerate={onRegenerateTimeline}
        loading={loading}
        selfLoading={timelineLoading}
        emptyLabel="生成剧情时间线"
      />

      {/* 全书人物关系 */}
      <SubItem
        label="全书人物关系"
        icon={<Users className="h-3 w-3" />}
        isOpen={bookSub === "characters"}
        onClick={() => setBookSub(bookSub === "characters" ? null : "characters")}
        summaries={characterSummaries}
        onGenerate={onGenerateCharacters}
        onRegenerate={onRegenerateCharacters}
        loading={loading}
        selfLoading={characterLoading}
        emptyLabel="生成人物关系分析"
        graphData={characterGraphData}
        onGenerateGraph={onGenerateGraph}
        onRegenerateGraph={onRegenerateGraph}
      />

      {/* 全书总览 */}
      <SubItem
        label="全书总览"
        icon={<BookOpen className="h-3 w-3" />}
        isOpen={bookSub === "global"}
        onClick={() => setBookSub(bookSub === "global" ? null : "global")}
        summaries={globalSummaries}
        onGenerate={onGenerateGlobal}
        onRegenerate={onRegenerateGlobal}
        loading={loading}
        selfLoading={globalLoading}
        emptyLabel="生成全书总览"
      />

      {/* 小说地图 */}
      <NovelMapSection
        novelId={novelId}
        isOpen={bookSub === "map"}
        onClick={() => setBookSub(bookSub === "map" ? null : "map")}
        loading={loading || loadingMap}
        selfLoading={mapLoading}
        mapData={mapData}
        updatedAt={mapUpdatedAt}
        onGenerate={async () => {
          try {
            const result = await onGenerateMap();
            if (result) {
              setMapData(result);
              setMapUpdatedAt(Date.now());
            }
          } catch (err) {
            console.error("Map generation failed:", err);
          }
        }}
        onRegenerate={async () => {
          try {
            const result = await onRegenerateMap();
            if (result) {
              setMapData(result);
              setMapUpdatedAt(Date.now());
            }
          } catch (err) {
            console.error("Map regeneration failed:", err);
          }
        }}
      />
    </div>
  );
}
