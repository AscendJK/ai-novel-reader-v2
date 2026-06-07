/**
 * 本章分析 Tab 组件
 * 从 SummaryPanel.tsx 中提取
 */

import { useState, useEffect, useRef } from "react";
import { Loader2, Sparkles, FileText, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { MiniCard } from "../shared/MiniCard";
import type { SummaryItem } from "@/stores/summary-store";

interface ChapterTabProps {
  /** 当前章节总结 */
  chapterSummary: SummaryItem | undefined;
  /** 是否正在加载 */
  loading: boolean;
  /** 是否有选中的章节 */
  hasSelectedChapter: boolean;
  /** 生成进度 */
  generateProgress: { current: number; total: number } | null;
  /** 总结本章 */
  onSummarize: () => void;
  /** 批量总结 */
  onSummarizeAll: (options?: { skipExisting?: boolean }) => void;
  /** 停止批量总结 */
  onStopBatch?: () => void;
  /** 重新生成 */
  onRegenerate: () => void;
  /** 收藏到笔记 */
  onBookmark: (title: string, content: string, chapterId: string) => void;
}

export function ChapterTab({
  chapterSummary,
  loading,
  hasSelectedChapter,
  generateProgress,
  onSummarize,
  onSummarizeAll,
  onStopBatch,
  onRegenerate,
  onBookmark,
}: ChapterTabProps) {
  const [showBatchConfirm, setShowBatchConfirm] = useState(false);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const batchStartRef = useRef(false);

  // 监听 loading 状态，当批量总结完成时重置状态
  // 使用 ref 来跟踪批量任务是否真的完成了
  useEffect(() => {
    if (batchStartRef.current && !loading && !generateProgress) {
      // 批量任务已启动，loading 变为 false，且没有进度信息，说明任务完成
      batchStartRef.current = false;
      setIsBatchRunning(false);
    }
  }, [loading, generateProgress]);

  const handleBatchClick = () => {
    setShowBatchConfirm(true);
  };

  const handleConfirmBatch = (skipExisting: boolean) => {
    setShowBatchConfirm(false);
    setIsBatchRunning(true);
    batchStartRef.current = true;
    onSummarizeAll({ skipExisting });
  };

  const handleStopBatch = () => {
    setIsBatchRunning(false);
    batchStartRef.current = false;
    onStopBatch?.();
  };

  return (
    <div className="px-2.5 pt-2 pb-2 space-y-2">
      {/* 操作按钮 */}
      <div className="flex gap-1">
        <Button
          size="sm"
          className="flex-1 text-xs h-7"
          onClick={onSummarize}
          disabled={loading || !hasSelectedChapter}
        >
          {loading && !isBatchRunning ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <Sparkles className="h-3 w-3 mr-1" />
          )}
          总结本章
        </Button>

        {isBatchRunning ? (
          <Button
            size="sm"
            variant="destructive"
            className="text-xs h-7"
            onClick={handleStopBatch}
          >
            <Square className="h-3 w-3 mr-1" />
            停止
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="text-xs h-7"
            onClick={handleBatchClick}
            disabled={loading}
          >
            <FileText className="h-3 w-3 mr-1" />
            批量
          </Button>
        )}
      </div>

      {/* 批量确认对话框 */}
      {showBatchConfirm && (
        <div className="p-3 rounded-lg border bg-card space-y-2">
          <p className="text-xs font-medium">批量总结设置</p>
          <p className="text-xs text-muted-foreground">
            已有本章总结的章节将被跳过，是否继续？
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1 text-xs h-7"
              onClick={() => handleConfirmBatch(true)}
            >
              跳过已有总结
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1 text-xs h-7"
              onClick={() => handleConfirmBatch(false)}
            >
              全部重新生成
            </Button>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="w-full text-xs h-6"
            onClick={() => setShowBatchConfirm(false)}
          >
            取消
          </Button>
        </div>
      )}

      {/* 生成进度 */}
      {generateProgress && (
        <div className="space-y-0.5">
          <div className="flex items-center justify-between">
            <Progress
              value={(generateProgress.current / generateProgress.total) * 100}
              className="h-1 flex-1"
            />
            <span className="text-xs text-muted-foreground ml-2">
              {generateProgress.current}/{generateProgress.total}
            </span>
          </div>
        </div>
      )}

      {/* 总结内容 */}
      {chapterSummary ? (
        <MiniCard
          title={chapterSummary.chapterTitle}
          content={chapterSummary.content}
          tokens={chapterSummary.tokensUsed}
          date={chapterSummary.updatedAt || chapterSummary.createdAt}
          onRegenerate={onRegenerate}
          loading={loading}
          onBookmark={() =>
            onBookmark(
              chapterSummary.chapterTitle,
              chapterSummary.content,
              chapterSummary.chapterId
            )
          }
        />
      ) : (
        <p className="text-xs text-muted-foreground text-center py-4">
          暂无总结，点击上方按钮生成
        </p>
      )}
    </div>
  );
}
