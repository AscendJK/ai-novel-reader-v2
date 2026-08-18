/**
 * SubItem 组件 - 可折叠的子项目
 * 用于显示章节总结、全书总览、人物分析等
 */

import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, RefreshCw, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MiniCard } from "./MiniCard";

interface SubItemProps {
  /** 标签文本 */
  label: string;
  /** 图标 */
  icon: ReactNode;
  /** 是否展开 */
  isOpen: boolean;
  /** 点击展开/折叠 */
  onClick: () => void;
  /** 总结列表 */
  summaries: {
    id: string;
    chapterTitle: string;
    content: string;
    tokensUsed: number;
    createdAt: number;
    updatedAt?: number;
    usedFallback?: boolean;
  }[];
  /** 生成总结 */
  onGenerate: () => void;
  /** 重新生成总结 */
  onRegenerate: () => void;
  /** 是否正在加载（全局，用于禁用按钮） */
  loading: boolean;
  /** 自身是否正在加载（用于显示转圈图标） */
  selfLoading?: boolean;
  /** 空状态提示 */
  emptyLabel: string;
}

export function SubItem({
  label,
  icon,
  isOpen,
  onClick,
  summaries,
  onGenerate,
  onRegenerate,
  loading,
  selfLoading,
  emptyLabel,
}: SubItemProps) {
  const showSpinner = selfLoading ?? loading;
  // 空状态：显示生成按钮
  if (summaries.length === 0) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          onClick={onGenerate}
          disabled={loading}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors py-0.5"
        >
          {showSpinner ? <Loader2 className="h-3 w-3 animate-spin" /> : icon}
          {emptyLabel}
        </button>
      </div>
    );
  }

  // 有内容：显示可折叠列表
  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          onClick={onClick}
          className="flex items-center gap-1 text-xs font-medium hover:text-primary transition-colors flex-1 text-left"
        >
          {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          {showSpinner ? <Loader2 className="h-3 w-3 animate-spin" /> : icon}
          {label}
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={onRegenerate}
          disabled={loading}
          aria-label="重新生成"
        >
          <RefreshCw className="h-2.5 w-2.5" />
        </Button>
      </div>

      {isOpen && (
        <div className="mt-1 space-y-1.5 pl-4">
          {/* 总结列表 */}
          {summaries.length > 0 ? (
            summaries.map((s) => (
              <MiniCard
                key={s.id}
                title={s.chapterTitle}
                content={s.content}
                tokens={s.tokensUsed}
                date={s.updatedAt || s.createdAt}
                onRegenerate={onRegenerate}
                loading={loading}
                usedFallback={s.usedFallback}
              />
            ))
          ) : (
            <button
              onClick={onGenerate}
              disabled={loading}
              className="text-xs text-muted-foreground hover:text-primary transition-colors py-0.5 flex items-center gap-1"
            >
              <FileText className="h-3 w-3" />生成文字分析
            </button>
          )}
        </div>
      )}
    </div>
  );
}
