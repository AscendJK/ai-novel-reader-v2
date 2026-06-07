import { useState, useEffect } from "react";
import { Loader2, AlertTriangle, CheckCircle2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  open: boolean;
  engine: string;
  status: string;
  message: string;
  current?: number;
  total?: number;
  error?: string;
  novelId?: string;
  queuePosition?: number;
  onRetry: () => void;
  onFallbackToTFIDF: () => void;
  onDismiss: () => void;
}

export function BuildProgress({ open, engine, status, message, current, total, error, novelId, queuePosition, onRetry, onFallbackToTFIDF, onDismiss }: Props) {
  // 跟踪是否已经开始构建（避免状态回退到 queued）
  // Hooks 必须在条件判断之前调用，遵循 React Rules of Hooks
  const [hasStartedBuilding, setHasStartedBuilding] = useState(false);

  useEffect(() => {
    if (status === "building" || status === "loading" || status === "encoding") {
      setHasStartedBuilding(true);
    }
    // 重置条件：任务完成、出错或重新开始
    if (status === "done" || status === "ready" || status === "error" || status === "none") {
      setHasStartedBuilding(false);
    }
  }, [status]);

  if (!open) return null;

  // 如果已经开始构建，强制显示为 building 状态
  const displayStatus = (hasStartedBuilding && status === "queued") ? "building" : status;

  const isQueued = displayStatus === "queued";
  const isBuilding = displayStatus === "building" || displayStatus === "loading" || displayStatus === "encoding";
  const isDone = displayStatus === "done" || displayStatus === "ready";
  const isError = displayStatus === "error";
  const pct = total ? Math.round(((current || 0) / total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-background/30">
      <Card className="w-full max-w-md mx-4 relative">
        <button className="absolute top-2 right-2 text-muted-foreground hover:text-foreground" onClick={onDismiss}>
          <X className="h-4 w-4" />
        </button>
        <CardHeader className="text-center">
          {isQueued && <Loader2 className="h-8 w-8 animate-spin text-blue-400 mx-auto mb-2" />}
          {isBuilding && <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-2" />}
          {isDone && <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto mb-2" />}
          {isError && <AlertTriangle className="h-8 w-8 text-destructive mx-auto mb-2" />}
          <CardTitle>
            {isQueued ? `排队中 (第 ${queuePosition || "?"} 位)`
              : isBuilding ? "正在构建检索索引"
              : isDone ? "索引构建完成" : "索引构建失败"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          <p className="text-sm text-muted-foreground">
            引擎: <span className="font-mono">{engine}</span>
          </p>

          {!isQueued && isBuilding && (
            <div className="space-y-2">
              <Progress value={total ? pct : undefined} className="h-2" />
              <p className="text-xs text-muted-foreground">
                {total ? `${current ?? 0} / ${total} · ${pct}%` : "准备中..."}
              </p>
            </div>
          )}
          {isQueued && (
            <p className="text-xs text-muted-foreground">前面还有 {queuePosition ? queuePosition - 1 : "?"} 个任务</p>
          )}

          <p className="text-sm">{message}</p>

          {isError && error && (
            <p className="text-xs text-destructive">{error}</p>
          )}

          {isError && (
            <div className="flex gap-2 justify-center">
              <Button size="sm" onClick={onRetry}>重试</Button>
              <Button size="sm" variant="outline" onClick={onFallbackToTFIDF}>
                退回 TF-IDF
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
