import { useState, useEffect } from "react";
import { ChapterNav } from "./ChapterNav";
import { ChapterContent } from "./ChapterContent";
import { SummaryPanel } from "@/components/summary/SummaryPanel";
import { LocalErrorBoundary } from "@/components/common/LocalErrorBoundary";
import { PanelRightOpen, PanelRightClose, List, FileText, BookOpen, MessageSquare, StickyNote, Search, X } from "lucide-react";
import { useSummaryStore } from "@/stores/summary-store";
import { useNovelStore } from "@/stores/novel-store";

export function ReadingPanel() {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileAiOpen, setMobileAiOpen] = useState(false);
  const [mobileAiTab, setMobileAiTab] = useState("chapter");
  const [immersive, setImmersive] = useState(false);

  // Toggle CSS class on <html> for immersive reading
  useEffect(() => {
    document.documentElement.classList.toggle("immersive", immersive);
    return () => document.documentElement.classList.remove("immersive");
  }, [immersive]);

  const { currentNovel, selectedChapterId } = useNovelStore();
  const { getSummariesByNovel } = useSummaryStore();

  const hasCurrentSummary = currentNovel
    ? getSummariesByNovel(currentNovel.id).some(
        (s) => s.chapterId === selectedChapterId && s.type === "chapter"
      )
    : false;

  const openMobileTab = (tab: string) => {
    setMobileAiTab(tab);
    setMobileAiOpen(true);
  };

  return (
    <div className="flex h-full relative">
      <div className="hidden md:flex shrink-0" data-sidebar="chapter-nav">
        <ChapterNav />
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        <ChapterContent
          summaryOpen={summaryOpen}
          onToggleSummary={() => setSummaryOpen(!summaryOpen)}
          hasSummary={hasCurrentSummary}
          immersive={immersive}
          onToggleImmersive={() => setImmersive(!immersive)}
        />
      </div>

      {/* Mobile: bottom bar — hidden in immersive mode */}
      {!immersive && (
      <div className="md:hidden fixed bottom-0 left-0 right-0 h-12 border-t bg-card flex items-center justify-around z-30 px-2 safe-area-bottom">
        <button onClick={() => setMobileNavOpen(true)}
          className="flex flex-col items-center gap-0.5 text-xs text-muted-foreground hover:text-primary">
          <List className="h-4 w-4" />目录
        </button>
        <button onClick={() => openMobileTab("qa")}
          className="flex flex-col items-center gap-0.5 text-xs text-muted-foreground hover:text-primary">
          <MessageSquare className="h-4 w-4" />问答
        </button>
        <button onClick={() => openMobileTab("chapter")}
          className="flex flex-col items-center gap-0.5 text-xs text-muted-foreground hover:text-primary">
          <FileText className="h-4 w-4" />本章
        </button>
        <button onClick={() => openMobileTab("book")}
          className="flex flex-col items-center gap-0.5 text-xs text-muted-foreground hover:text-primary">
          <BookOpen className="h-4 w-4" />全书
        </button>
        <button onClick={() => openMobileTab("notes")}
          className="flex flex-col items-center gap-0.5 text-xs text-muted-foreground hover:text-primary">
          <StickyNote className="h-4 w-4" />笔记
        </button>
        <button onClick={() => openMobileTab("search")}
          className="flex flex-col items-center gap-0.5 text-xs text-muted-foreground hover:text-primary">
          <Search className="h-4 w-4" />搜索
        </button>
      </div>
      )}

      {/* Desktop: right panel */}
      <div className="hidden md:flex" data-sidebar="summary-panel">
        {/* 折叠按钮 - 始终显示 */}
        <button onClick={() => setSummaryOpen(!summaryOpen)}
          className="h-[85px] w-8 bg-card border border-l-0 rounded-l-md flex items-center justify-center hover:bg-accent transition-colors group shadow-sm shrink-0 relative">
          {summaryOpen ? (
            <PanelRightClose className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
          ) : (
            <PanelRightOpen className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
          )}
          {!summaryOpen && hasCurrentSummary && (
            <span className="absolute top-1 right-1 w-2 h-2 bg-primary rounded-full" />
          )}
        </button>

        {/* SummaryPanel - 始终渲染，用 CSS 隐藏 */}
        <div style={{ display: summaryOpen ? undefined : "none" }}>
          <LocalErrorBoundary name="SummaryPanel">
            <SummaryPanel />
          </LocalErrorBoundary>
        </div>
      </div>

      {/* Mobile: chapter nav drawer (left) */}
      {mobileNavOpen && (
        <>
          <div className="md:hidden fixed inset-0 bg-black/40 z-40" onClick={() => setMobileNavOpen(false)} />
          <div className="md:hidden fixed inset-y-0 left-0 w-[min(280px,80vw)] bg-card z-50 shadow-xl animate-in slide-in-from-left">
            <div className="flex items-center justify-between p-3 border-b">
              <span className="font-semibold text-sm">目录</span>
              <button onClick={() => setMobileNavOpen(false)} className="p-1 rounded hover:bg-accent"><X className="h-4 w-4" /></button>
            </div>
            <div className="h-[calc(100vh-48px)]">
              <ChapterNav />
            </div>
          </div>
        </>
      )}

      {/* Mobile: AI panel (fullscreen) — kept mounted for running tasks */}
      <div className="md:hidden fixed inset-0 z-50 bg-card flex flex-col" style={{ display: mobileAiOpen ? undefined : "none" }}>
          <div className="flex items-center justify-between p-3 border-b shrink-0">
            <span className="font-semibold text-sm">AI 分析</span>
            <button onClick={() => setMobileAiOpen(false)} className="p-1 rounded hover:bg-accent"><X className="h-4 w-4" /></button>
          </div>
          <div className="flex-1 min-h-0">
            <SummaryPanel value={mobileAiTab} onValueChange={setMobileAiTab} />
          </div>
        </div>
    </div>
  );
}
