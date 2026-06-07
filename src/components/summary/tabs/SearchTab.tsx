/**
 * 搜索 Tab 组件
 * 从 SummaryPanel.tsx 中提取
 */

import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getEngineDisplayName, isEmbeddingEngine } from "@/rag/engines";
import type { useSearch } from "../hooks/useSearch";

interface SearchTabProps {
  /** Search hook 返回值 */
  searchHook: ReturnType<typeof useSearch>;
  /** 当前引擎 */
  engine: string;
  /** 索引是否就绪 */
  indexReady: boolean | null;
  /** 是否离线 */
  offlineMode: boolean;
  /** 构建索引 */
  onBuild: () => void;
}

export function SearchTab({
  searchHook,
  engine,
  indexReady,
  offlineMode,
  onBuild,
}: SearchTabProps) {
  // 索引未构建时显示提示
  if (isEmbeddingEngine(engine) && indexReady === false) {
    return (
      <div className="text-center py-6 space-y-2">
        <p className="text-xs text-muted-foreground">
          {offlineMode ? "离线模式下无法构建索引" : "嵌入引擎索引未构建，无法使用语义搜索"}
        </p>
        {!offlineMode && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs"
            onClick={onBuild}
          >
            立即构建索引
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="px-2.5 pt-2 pb-2 space-y-2">
      {/* 搜索输入 */}
      <div className="flex gap-1">
        <Input
          id="rag-search-input"
          name="rag-search-input"
          className="h-7 text-xs flex-1"
          placeholder="输入关键词或语义查询..."
          value={searchHook.searchQuery}
          onChange={(e) => searchHook.setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              searchHook.handleSearch();
            }
          }}
        />
        <Button
          size="sm"
          className="h-7 text-xs px-2"
          onClick={searchHook.handleSearch}
          disabled={searchHook.searchLoading || !searchHook.searchQuery.trim()}
        >
          {searchHook.searchLoading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Search className="h-3 w-3" />
          )}
        </Button>
      </div>

      {/* 引擎信息 */}
      <div className="text-[10px] text-muted-foreground text-center">
        引擎:{" "}
        <span
          className={
            isEmbeddingEngine(searchHook.searchEngine)
              ? "text-green-400"
              : "text-yellow-400"
          }
        >
          {getEngineDisplayName(
            searchHook.searchEngine === "none" ? engine : searchHook.searchEngine
          )}
        </span>
        {searchHook.searchResults.length > 0 && (
          <span className="ml-2">· {searchHook.searchResults.length} 条结果</span>
        )}
      </div>

      {/* 错误信息 */}
      {searchHook.searchError && (
        <p className="text-xs text-destructive text-center">
          {searchHook.searchError}
        </p>
      )}

      {/* 搜索结果 */}
      {searchHook.searchResults.length > 0 && (
        <div className="space-y-1.5">
          {searchHook.searchResults.map((r, i) => (
            <Card key={i} className="shadow-none">
              <CardHeader className="p-1.5 pb-0.5">
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="text-[10px] font-normal">
                    {r.score.toFixed(3)}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">
                    #{i + 1}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="p-1.5 pt-0">
                <p className="text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap break-all">
                  {r.content}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 空状态 */}
      {!searchHook.searchLoading &&
        searchHook.searchResults.length === 0 &&
        searchHook.searchQuery &&
        !searchHook.searchError && (
          <p className="text-xs text-muted-foreground text-center py-4">
            未找到相关内容
          </p>
        )}

      {!searchHook.searchQuery && searchHook.searchResults.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4">
          输入查询进行语义搜索
        </p>
      )}
    </div>
  );
}
