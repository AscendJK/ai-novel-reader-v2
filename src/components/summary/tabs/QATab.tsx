/**
 * 问答 Tab 组件
 * 从 SummaryPanel.tsx 中提取
 */

import { useState } from "react";
import { Loader2, MessageSquare, PlusCircle, Bookmark, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { MarkdownRenderer } from "../shared/MarkdownRenderer";
import { MiniCard } from "../shared/MiniCard";
import type { useQA } from "../hooks/useQA";

interface QATabProps {
  /** QA hook 返回值 */
  qaHook: ReturnType<typeof useQA>;
  /** 是否正在加载 */
  loading: boolean;
  /** 小说章节数量 */
  chapterCount: number;
  /** 当前选中的章节 ID */
  selectedChapterId: string | null;
  /** 收藏 AI 回答到笔记 */
  onBookmark: (title: string, content: string, chapterId: string, scope?: "chapter" | "book") => void;
}

export function QATab({
  qaHook,
  loading,
  chapterCount,
  selectedChapterId,
  onBookmark,
}: QATabProps) {
  const [rangeExpanded, setRangeExpanded] = useState(true);

  return (
    <>
      {/* QA input at top — always visible first */}
      <div className="px-2.5 pt-2 pb-2 space-y-1.5 border-b">
        <Card className="shadow-none">
          <CardContent className="p-2 space-y-1.5">
            <div
              className="flex items-center justify-between cursor-pointer select-none"
              onClick={() => setRangeExpanded(!rangeExpanded)}
            >
              <p className="text-xs font-medium">范围总结</p>
              {rangeExpanded ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
            </div>
            {rangeExpanded && (
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground">第</span>
                <Input
                  id="range-from"
                  name="range-from"
                  className="h-6 text-xs w-16 text-center"
                  placeholder="1"
                  value={qaHook.rangeFrom}
                  onChange={(e) => qaHook.setRangeFrom(e.target.value)}
                />
                <span className="text-xs text-muted-foreground">-</span>
                <Input
                  id="range-to"
                  name="range-to"
                  className="h-6 text-xs w-16 text-center"
                  placeholder={String(chapterCount)}
                  value={qaHook.rangeTo}
                  onChange={(e) => qaHook.setRangeTo(e.target.value)}
                />
                <span className="text-xs text-muted-foreground">章</span>
                <Button
                  size="sm"
                  className="h-6 text-xs"
                  onClick={qaHook.handleRangeSummary}
                  disabled={loading}
                >
                  生成
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Textarea
          id="qa-input"
          name="qa-input"
          className="text-xs min-h-[40px]"
          placeholder="输入问题，支持追问..."
          value={qaHook.customQuestion}
          onChange={(e) => qaHook.setCustomQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              qaHook.handleSubmitQuestion();
            }
          }}
        />

        <div className="flex gap-1">
          <Button
            size="sm"
            className="h-6 text-xs flex-1"
            onClick={qaHook.handleSubmitQuestion}
            disabled={loading || !qaHook.customQuestion.trim()}
          >
            <MessageSquare className="h-3 w-3 mr-1" />
            发送
          </Button>
          {qaHook.qaMessages.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-xs"
              onClick={() => {
                qaHook.setQaMessages([]);
                qaHook.handleClearQaCache();
              }}
            >
              <PlusCircle className="h-3 w-3 mr-1" />
              新会话
            </Button>
          )}
        </div>
      </div>

      {/* Chat + range results */}
      <div className="px-2.5 pt-2 pb-2 space-y-1.5">
        {/* Range results */}
        {qaHook.rangeResults.map((r) => (
          <MiniCard
            key={r.id}
            title={r.title}
            content={r.content}
            tokens={r.tokensUsed}
            date={r.createdAt}
            isTemp
            onRemove={() =>
              qaHook.setRangeResults((p) => p.filter((x) => x.id !== r.id))
            }
            onBookmark={() => onBookmark(r.title, r.content, "__book__", "book")}
          />
        ))}

        {/* Loading indicator */}
        {qaHook.qaLoading && <Loader2 className="h-3 w-3 animate-spin mx-auto" />}

        {/* Chat messages (newest first) */}
        {qaHook.qaMessages.length > 0 && (
          <div className="space-y-1.5">
            {qaHook.qaMessages.map((m) => (
              <div
                key={m.id}
                className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}
              >
                <div
                  className={`max-w-[90%] rounded-lg px-2 py-1 text-xs ${
                    m.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted"
                  }`}
                >
                  <MarkdownRenderer content={m.content} variant="chat" />
                </div>
                {m.role === "assistant" && (
                  <div className="flex gap-1 mt-0.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 text-xs text-muted-foreground hover:text-primary"
                      disabled={!selectedChapterId}
                      onClick={() =>
                        selectedChapterId && onBookmark("AI 回答", m.content, selectedChapterId, "chapter")
                      }
                    >
                      <Bookmark className="h-2.5 w-2.5 mr-0.5" />
                      收藏到本章
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 text-xs text-muted-foreground hover:text-primary"
                      onClick={() => onBookmark("AI 回答", m.content, "__book__", "book")}
                    >
                      <Bookmark className="h-2.5 w-2.5 mr-0.5" />
                      收藏到全书
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
