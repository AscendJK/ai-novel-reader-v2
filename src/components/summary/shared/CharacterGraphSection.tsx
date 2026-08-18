/**
 * CharacterGraphSection 组件 - 人物关系分析图区域
 * 与 NovelMapSection 同级的独立功能入口（不再耦合在"全书人物关系"文字分析内部），
 * 入口永远可见，避免因文字分析状态导致图谱按钮/内容消失。
 */

import { ChevronRight, ChevronDown, Network, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CharacterGraph } from "../CharacterGraph";
import type { GraphData } from "@/hooks/useSummarizer";

interface CharacterGraphSectionProps {
  /** 是否展开 */
  isOpen: boolean;
  /** 点击展开/折叠 */
  onClick: () => void;
  /** 是否正在加载（全局，用于禁用按钮） */
  loading: boolean;
  /** 自身是否正在加载（用于显示转圈图标） */
  selfLoading?: boolean;
  /** 图谱数据 */
  graphData: GraphData | null;
  /** 生成图谱 */
  onGenerate: () => Promise<void>;
  /** 重新生成图谱 */
  onRegenerate: () => Promise<void>;
}

export function CharacterGraphSection({
  isOpen,
  onClick,
  loading,
  selfLoading,
  graphData,
  onGenerate,
  onRegenerate,
}: CharacterGraphSectionProps) {
  const showSpinner = selfLoading ?? loading;
  const isEmptyGraph = !graphData || (graphData.nodes.length === 0 && graphData.edges.length === 0);

  // 空状态：显示生成按钮（与 NovelMapSection 一致）
  if (isEmptyGraph && !showSpinner) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          onClick={onGenerate}
          disabled={loading}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors py-0.5"
        >
          <Network className="h-3 w-3" />
          生成人物关系图谱
        </button>
      </div>
    );
  }

  // 加载中状态
  if (isEmptyGraph && showSpinner) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          disabled
          className="flex items-center gap-1 text-xs text-muted-foreground py-0.5"
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          生成人物关系图谱
        </button>
      </div>
    );
  }

  // 有数据：显示可折叠内容
  return (
    <div>
      {/* 标题栏 */}
      <div className="flex items-center gap-1">
        <button
          onClick={onClick}
          className="flex items-center gap-1 text-xs font-medium hover:text-primary transition-colors flex-1 text-left"
        >
          {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          {showSpinner ? <Loader2 className="h-3 w-3 animate-spin" /> : <Network className="h-3 w-3" />}
          人物关系分析图
        </button>
        <span className="text-[10px] text-muted-foreground">
          {graphData?.nodes.length ?? 0} 个角色 · {graphData?.edges.length ?? 0} 条关系
        </span>
        <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onRegenerate} disabled={loading}>
          <RefreshCw className={`h-2.5 w-2.5 ${showSpinner ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* 展开内容 */}
      {isOpen && graphData && (
        <div className="mt-1 space-y-1.5 pl-4">
          <CharacterGraph graphData={graphData} onRegenerate={onRegenerate} />
        </div>
      )}
    </div>
  );
}
