/**
 * MiniCard 组件 - 小卡片
 * 用于显示单个总结或笔记
 */

import { RefreshCw, Bookmark, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MarkdownRenderer } from "./MarkdownRenderer";
// 元数据的形状由产出方（agents）定，界面只是读它。过去这里另抄了一份字段完全相同的
// 定义，加字段就要改两处——第二处不改的症状是"数据在对象里、卡片上却看不见"。
import type { AnalysisMetadata } from "@/agents/types";

export type { AnalysisMetadata };

interface MiniCardProps {
  /** 标题 */
  title: string;
  /** 内容（Markdown 格式） */
  content: string;
  /** 字数（回答内容的字符数） */
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
  const showMetadata = metadata?.usedFallback || metadata?.truncated || !!metadata?.omittedChapters;

  return (
    <Card className={`shadow-none overflow-hidden max-w-full ${isTemp ? "border-dashed border-amber-300 dark:border-amber-700" : ""}`}>
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
                aria-label="删除"
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
              <span>{metadata?.usedFallback || metadata?.truncated ? "本分析使用了精简模式" : "送入模型的原文不完整"}</span>
            </div>
            {!!metadata?.omittedChapters && (
              <p className="text-muted-foreground">
                另有 {metadata.omittedChapters.toLocaleString()} 章原文因上下文预算没送出去，结论只覆盖已送入的部分
              </p>
            )}
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
