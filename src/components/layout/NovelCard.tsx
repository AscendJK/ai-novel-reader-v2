import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Trash2, FileText, Clock, ChevronRight, Loader2 } from "lucide-react";
import { formatCharCount } from "@/lib/text-utils";
import { getEngineDisplayName } from "@/rag/engines";
import { useBuildStore, type NovelBuildStatus } from "@/stores/build-store";
import type { NovelMeta } from "@/parsers/types";

interface ReadPosition {
  chapterId: string;
  chapterIndex: number;
  scrollTop?: number;
  chapterOffset?: number;
}

interface NovelCardProps {
  novel: NovelMeta;
  position: ReadPosition | undefined;
  engine: string;
  lruKeys: Set<string>;
  cachedKeys: Set<string>;
  builds: Map<string, NovelBuildStatus>;
  buildStatuses: Record<string, Record<string, any>>;
  offlineMode: boolean;
  onOpen: (novelId: string, chapterIndex: number) => void;
  onDelete: (e: React.MouseEvent, novelId: string, title: string) => void;
  onBuild: (novelId: string) => void;
}

export const NovelCard = React.memo(function NovelCard({
  novel, position, engine, lruKeys, cachedKeys, builds, buildStatuses,
  offlineMode, onOpen, onDelete, onBuild,
}: NovelCardProps) {
  const readIndex = position ? position.chapterIndex : -1;
  const progressPct = novel.chapterCount > 0 && readIndex >= 0
    ? (((readIndex + 1) / novel.chapterCount) * 100)
    : 0;

  return (
    <Card
      className="cursor-pointer transition-all hover:shadow-md hover:border-primary/50 group relative"
      onClick={() => onOpen(novel.id, position ? position.chapterIndex : 0)}
    >
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 h-7 w-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        onClick={(e) => onDelete(e, novel.id, novel.title)}
        title="删除此书"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>

      <CardContent className="p-5">
        <div className="flex items-start gap-3 mb-3">
          <div className="w-10 h-14 rounded bg-primary/10 flex items-center justify-center shrink-0">
            <FileText className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold truncate group-hover:text-primary transition-colors pr-6">
              《{novel.title}》
            </h3>
            {novel.author && (
              <p className="text-xs text-muted-foreground">{novel.author}</p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {novel.fileName}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 mb-3">
          <Badge variant="secondary" className="text-xs">
            {novel.fileFormat.toUpperCase()}
          </Badge>
          <Badge variant="secondary" className="text-xs">
            {novel.chapterCount} 章
          </Badge>
          <Badge variant="secondary" className="text-xs">
            {formatCharCount(novel.totalChars)}
          </Badge>
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {position ? `已读至第 ${position.chapterIndex + 1} 章` : "未开始阅读"}
            </span>
            <span>{typeof progressPct === "number" ? progressPct.toFixed(2) : progressPct}%</span>
          </div>
          <Progress value={progressPct} className="h-1.5" />
        </div>

        <div className="flex justify-end items-center mt-3">
          <Button variant="ghost" size="sm" className="group-hover:text-primary">
            开始阅读
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>

        {/* RAG build status */}
        {engine !== "tfidf" && (() => {
          const st = buildStatuses[novel.id]?.[engine] || { status: "none" };
          const chunkCount = st.chunkCount || 0;
          const dim = st.dim || 0;
          const vecCount = chunkCount;
          const vecBytes = chunkCount * dim * 4;
          const countLabel = vecCount >= 10000 ? `${(vecCount / 1000).toFixed(1)}k` : `${vecCount}`;
          const sizeLabel = vecBytes >= 1048576 ? `${(vecBytes / 1048576).toFixed(1)}MB` : vecBytes >= 1024 ? `${Math.round(vecBytes / 1024)}KB` : `${vecBytes}B`;
          const memKey = novel.id + "-" + engine;
          const inMemory = lruKeys.has(memKey);
          const inIndexedDB = cachedKeys.has(memKey);
          const onServer = st.status === "ready";
          const el = engine.includes("bge") ? "BGE" : engine.includes("gte") ? "GTE" : engine.includes("e5") ? "E5" : engine.includes("MiniLM") ? "MiniLM" : getEngineDisplayName(engine).split(" ")[0];
          const buildKey = `${novel.id}-${engine}`;
          const buildStatus = builds.get(buildKey);
          const isBuilding = buildStatus && (buildStatus.status === "building" || buildStatus.status === "loading" || buildStatus.status === "encoding" || buildStatus.status === "queued");
          const statsText = vecCount > 0 ? ` · ${countLabel}向量 · ${sizeLabel}` : "";

          const handleBadgeClick = (e: React.MouseEvent) => {
            e.stopPropagation();
            if (buildStatus) {
              useBuildStore.getState().toggleWindow(novel.id, engine);
            }
          };

          if (inMemory) {
            return (
              <div className="flex items-center gap-1 mt-2 pt-2 border-t border-border/50">
                <Badge variant="outline" className="text-[10px] text-green-500 border-green-500/30">
                  {`${el} 已加载`}{statsText}
                </Badge>
              </div>
            );
          }
          if (inIndexedDB) {
            return (
              <div className="flex items-center gap-1 mt-2 pt-2 border-t border-border/50">
                <Badge variant="outline" className="text-[10px] text-yellow-600 border-yellow-500/30">
                  {`${el} 已缓存`}{statsText}
                </Badge>
              </div>
            );
          }
          if (onServer) {
            return (
              <div className="flex items-center gap-1 mt-2 pt-2 border-t border-border/50">
                <Badge variant="outline" className="text-[10px] text-blue-500 border-blue-500/30">
                  {`${el} 就绪`}{statsText}
                </Badge>
              </div>
            );
          }
          if (buildStatus && (buildStatus.status === "building" || buildStatus.status === "loading" || buildStatus.status === "encoding")) {
            return (
              <div
                className="flex items-center gap-1 mt-2 pt-2 border-t border-border/50 cursor-pointer hover:bg-muted/50 rounded px-1"
                onClick={handleBadgeClick}
              >
                <Loader2 className="h-3 w-3 animate-spin text-yellow-500" />
                <span className="text-[10px] text-yellow-500">{el} 构建中...</span>
              </div>
            );
          }
          if (buildStatus && buildStatus.status === "queued") {
            const qpos = buildStatus.queuePosition || "?";
            return (
              <div
                className="flex items-center gap-1 mt-2 pt-2 border-t border-border/50 cursor-pointer hover:bg-muted/50 rounded px-1"
                onClick={handleBadgeClick}
              >
                <Loader2 className="h-3 w-3 text-blue-400" />
                <span className="text-[10px] text-blue-400">排队第 {qpos} 位</span>
              </div>
            );
          }
          if (buildStatus && buildStatus.status === "error") {
            return (
              <div className="flex items-center gap-1 mt-2 pt-2 border-t border-border/50">
                <span
                  className="text-[10px] text-red-400 cursor-pointer hover:underline"
                  onClick={handleBadgeClick}
                >
                  {el} 失败
                </span>
                <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1" onClick={(e) => { e.stopPropagation(); onBuild(novel.id); }} disabled={offlineMode}>
                  {offlineMode ? "离线" : "重试"}
                </Button>
              </div>
            );
          }
          return (
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/50">
              <span className="text-[10px] text-muted-foreground">{offlineMode ? `${el} 离线不可用` : `${el} 未构建`}</span>
              <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1" onClick={(e) => { e.stopPropagation(); onBuild(novel.id); }} disabled={isBuilding || offlineMode}>
                {offlineMode ? "离线" : isBuilding ? "触发中..." : "构建"}
              </Button>
            </div>
          );
        })()}

        {/* TF-IDF status */}
        {engine === "tfidf" && (() => {
          const tfidfKey = `${novel.id}-tfidf`;
          const inMemory = lruKeys.has(tfidfKey);
          const inIndexedDB = cachedKeys.has(tfidfKey);
          if (inMemory) {
            return (
              <div className="flex items-center gap-1 mt-2 pt-2 border-t border-border/50">
                <Badge variant="outline" className="text-[10px] text-green-500 border-green-500/30">
                  TF-IDF 已加载
                </Badge>
              </div>
            );
          }
          if (inIndexedDB) {
            return (
              <div className="flex items-center gap-1 mt-2 pt-2 border-t border-border/50">
                <Badge variant="outline" className="text-[10px] text-yellow-600 border-yellow-500/30">
                  TF-IDF 已缓存
                </Badge>
              </div>
            );
          }
          return null;
        })()}
      </CardContent>
    </Card>
  );
});
