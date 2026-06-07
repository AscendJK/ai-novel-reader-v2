/**
 * 单本书的构建状态窗口
 * 显示构建进度、排队状态、错误信息
 */

import { Loader2, AlertTriangle, CheckCircle2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useBuildStore, type NovelBuildStatus } from "@/stores/build-store";

interface NovelBuildWindowProps {
  /** 构建状态 */
  build: NovelBuildStatus;
  /** 重试回调 */
  onRetry?: () => void;
  /** 退回 TF-IDF 回调 */
  onFallbackToTFIDF?: () => void;
}

export function NovelBuildWindow({ build, onRetry, onFallbackToTFIDF }: NovelBuildWindowProps) {
  const { dismissWindow } = useBuildStore();
  const { novelId, engine, status, message, current, total, error, queuePosition, open } = build;

  if (!open) return null;

  const isQueued = status === "queued";
  const isBuilding = status === "building" || status === "loading" || status === "encoding";
  const isDone = status === "done" || status === "ready";
  const isError = status === "error";
  const pct = total ? Math.round(((current || 0) / total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-background/30">
      <Card className="w-full max-w-md mx-4 relative">
        <button
          className="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
          onClick={() => dismissWindow(novelId, engine)}
        >
          <X className="h-4 w-4" />
        </button>

        <CardHeader className="text-center">
          {isQueued && <Loader2 className="h-8 w-8 animate-spin text-blue-400 mx-auto mb-2" />}
          {isBuilding && <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-2" />}
          {isDone && <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto mb-2" />}
          {isError && <AlertTriangle className="h-8 w-8 text-destructive mx-auto mb-2" />}

          <CardTitle>
            {isQueued
              ? `排队中 (第 ${queuePosition || "?"} 位)`
              : isBuilding
              ? "正在构建检索索引"
              : isDone
              ? "索引构建完成"
              : "索引构建失败"}
          </CardTitle>
        </CardHeader>

        <CardContent className="space-y-4 text-center">
          <p className="text-sm text-muted-foreground">
            引擎: <span className="font-mono">{engine}</span>
          </p>

          {/* 进度条 */}
          {!isQueued && isBuilding && (
            <div className="space-y-2">
              <Progress value={total ? pct : undefined} className="h-2" />
              <p className="text-xs text-muted-foreground">
                {total ? `${current ?? 0} / ${total} · ${pct}%` : "准备中..."}
              </p>
            </div>
          )}

          {/* 排队信息 */}
          {isQueued && (
            <p className="text-xs text-muted-foreground">
              前面还有 {queuePosition ? queuePosition - 1 : "?"} 个任务
            </p>
          )}

          {/* 状态消息 */}
          <p className="text-sm">{message}</p>

          {/* 错误信息 */}
          {isError && error && (
            <p className="text-xs text-destructive">{error}</p>
          )}

          {/* 操作按钮 */}
          {isError && (
            <div className="flex gap-2 justify-center">
              {onRetry && (
                <Button size="sm" onClick={onRetry}>
                  重试
                </Button>
              )}
              {onFallbackToTFIDF && (
                <Button size="sm" variant="outline" onClick={onFallbackToTFIDF}>
                  退回 TF-IDF
                </Button>
              )}
            </div>
          )}

          {/* 完成提示 */}
          {isDone && (
            <p className="text-xs text-muted-foreground">
              窗口将自动关闭...
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
