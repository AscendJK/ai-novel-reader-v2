/**
 * MiniCard 组件 - 小卡片
 * 用于显示单个总结或笔记
 */

import { RefreshCw, Bookmark, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MarkdownRenderer } from "./MarkdownRenderer";

/** 分析元数据 */
export interface AnalysisMetadata {
  /** 是否使用了精简模式 */
  usedFallback?: boolean;
  /** 是否截断了内容 */
  truncated?: boolean;
  /** 原始内容长度（字符数） */
  originalLength?: number;
  /** 实际分析的内容长度（字符数） */
  analyzedLength?: number;
  /** 分段数（如果使用了分段分析） */
  segments?: number;
}

interface MiniCardProps {
  /** 标题 */
  title: string;
  /** 内容（Markdown 格式） */
  content: string;
  /** Token 数量 */
  tokens: number;
  /** 日期时间戳 */
  date: number;
  /** 重新生成回调 */
  onRegenerate?: () => void;
  /** 是否正在加载 */
  loading?: boolean;
  /** 是否为临时结果 */
  isTemp?: boolean;
  /** 移除回调 */
  onRemove?: () => void;
  /** 收藏到笔记回调 */
  onBookmark?: () => void;
  /** 是否使用了精简版 */
  usedFallback?: boolean;
  /** 分析元数据 */
  metadata?: AnalysisMetadata;
}

export function MiniCard({
  title,
  content,
  tokens,
  date,
  onRegenerate,
  loading,
  isTemp,
  onRemove,
  onBookmark,
  usedFallback,
  metadata,
}: MiniCardProps) {
  // 判断是否显示元数据提示
  const showMetadata = metadata?.usedFallback || metadata?.truncated;

  return (
    <Card className={`shadow-none ${isTemp ? "border-dashed border-amber-300 dark:border-amber-700" : ""}`}>
      <CardHeader className="p-2 pb-0.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 min-w-0">
            {isTemp && (
              <Badge variant="outline" className="text-xs font-normal text-amber-600 shrink-0">
                临时
              </Badge>
            )}
            {(usedFallback || metadata?.usedFallback) && (
              <Badge variant="outline" className="text-[10px] font-normal text-amber-600 shrink-0">
                精简
              </Badge>
            )}
            <CardTitle className="text-xs truncate">{title}</CardTitle>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <Badge variant="outline" className="text-xs font-normal">
              ~{tokens}
            </Badge>
            {onBookmark && (
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={onBookmark}
                title="收藏到笔记"
              >
                <Bookmark className="h-2.5 w-2.5" />
              </Button>
            )}
            {onRegenerate && (
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={onRegenerate}
                disabled={loading}
              >
                <RefreshCw className="h-2.5 w-2.5" />
              </Button>
            )}
            {onRemove && (
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={onRemove}
              >
                x
              </Button>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {new Date(date).toLocaleString("zh-CN")}
        </p>
      </CardHeader>
      <CardContent className="p-2 pt-0">
        <div className="text-xs leading-relaxed space-y-2">
          <MarkdownRenderer content={content} variant="summary" />
        </div>

        {/* 元数据提示 */}
        {showMetadata && (
          <div className="mt-2 p-1.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] space-y-0.5">
            <div className="flex items-center gap-1 text-amber-600">
              <AlertTriangle className="h-3 w-3" />
              <span>本分析使用了精简模式</span>
            </div>
            {metadata?.truncated && metadata?.originalLength && (
              <p className="text-muted-foreground">
                原始内容 {metadata.originalLength.toLocaleString()} 字符
                {metadata.analyzedLength && (
                  <>，分析了 {metadata.analyzedLength.toLocaleString()} 字符</>
                )}
              </p>
            )}
            {metadata?.segments && metadata.segments > 1 && (
              <p className="text-muted-foreground">
                分为 {metadata.segments} 段分析后合并
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
