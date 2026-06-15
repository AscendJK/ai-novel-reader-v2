import { useState, useCallback, useEffect, useRef } from "react";
import { useNovelStore } from "@/stores/novel-store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { ChevronRight, PanelLeftOpen, PanelLeftClose, Loader2 } from "lucide-react";
import { loadChapters } from "@/db/repositories";

const TOGGLE_W = "w-8";
const TOGGLE_H = "h-[85px]"; // matches ChapterContent top bar height

interface ChapterNavProps {
  scrollControlRef?: React.RefObject<{ scrollToChapter: (chapterId: string, chapterOffset?: number) => void; suppressIO: () => () => void } | null>;
}

export function ChapterNav({ scrollControlRef }: ChapterNavProps) {
  const { currentNovel, selectedChapterId, setSelectedChapter, addChapters } = useNovelStore();
  const [collapsed, setCollapsed] = useState(false);
  const [loadingChapter, setLoadingChapter] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 当 selectedChapterId 变化或目录展开时，自动滚动到当前章节
  useEffect(() => {
    // 延迟执行，确保 DOM 已更新
    const timer = setTimeout(() => {
      if (selectedChapterId && scrollRef.current) {
        const element = scrollRef.current.querySelector(`[data-chapter-id="${selectedChapterId}"]`);
        if (element) {
          element.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [selectedChapterId, collapsed]);

  const handleChapterClick = useCallback(async (chapterId: string, chapterIndex: number) => {
    if (!currentNovel) return;

    // 检查章节内容是否已加载
    const chapter = currentNovel.chapters.find(c => c.id === chapterId);

    if (chapter && chapter.content) {
      // 已加载：使用 scrollToChapter（抑制 IO 干扰）
      setSelectedChapter(chapterId);
      if (scrollControlRef?.current) {
        const release = scrollControlRef.current.suppressIO();
        scrollControlRef.current.scrollToChapter(chapterId);
        setTimeout(release, 500);
      } else {
        const el = document.querySelector(`.chapter-section[data-chapter-id="${chapterId}"]`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    } else {
      // 未加载，需要懒加载
      setLoadingChapter(chapterId);
      try {
        const start = Math.max(0, chapterIndex - 10);
        const loaded = await loadChapters(currentNovel.id, start, 21);
        // 先抑制 IO，再加载章节和滚动
        const release = scrollControlRef?.current?.suppressIO();
        addChapters(loaded);
        setSelectedChapter(chapterId);
        if (scrollControlRef?.current) {
          scrollControlRef.current.scrollToChapter(chapterId);
        } else {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const el = document.querySelector(`.chapter-section[data-chapter-id="${chapterId}"]`);
              if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
            });
          });
        }
        if (release) setTimeout(release, 500);
      } catch (err) {
        console.error("[ChapterNav] Failed to load chapters:", err);
      } finally {
        setLoadingChapter(null);
      }
    }
  }, [currentNovel, setSelectedChapter, addChapters, scrollControlRef]);

  if (!currentNovel) return null;

  if (collapsed) {
    return (
      <div className={`shrink-0 hidden md:flex ${TOGGLE_W}`}>
        <button
          onClick={() => setCollapsed(false)}
          className={`${TOGGLE_H} w-full bg-card border border-l-0 rounded-r-md flex items-center justify-center hover:bg-accent transition-colors group`}
          title="展开目录"
        >
          <PanelLeftOpen className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
        </button>
      </div>
    );
  }

  return (
    <div className="md:w-56 w-full shrink-0 flex">
      <div className="flex-1 flex flex-col min-w-0 h-full">
        <div className="p-4 border-b shrink-0 flex items-center min-h-[85px]">
          <div className="min-w-0">
            <p className="font-medium text-sm truncate">《{currentNovel.title}》</p>
            <p className="text-xs text-muted-foreground mt-0.5">共 {currentNovel.chapters.length} 章</p>
          </div>
        </div>
        <ScrollArea className="h-[calc(100vh-150px)]">
          <div className="p-1.5" ref={scrollRef}>
            {currentNovel.chapters.map((ch) => {
              const isLoaded = !!ch.content;
              const isLoading = loadingChapter === ch.id;

              return (
                <button
                  key={ch.id}
                  data-chapter-id={ch.id}
                  onClick={() => handleChapterClick(ch.id, ch.index)}
                  disabled={isLoading}
                  className={cn(
                    "w-full text-left px-2.5 py-1.5 rounded-md text-xs transition-colors flex items-center gap-1.5",
                    selectedChapterId === ch.id
                      ? "bg-primary/10 text-primary font-medium"
                      : "hover:bg-accent text-muted-foreground",
                    !isLoaded && "opacity-60"
                  )}
                >
                  {isLoading ? (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                  ) : (
                    <ChevronRight
                      className={cn(
                        "h-3 w-3 shrink-0 transition-transform",
                        selectedChapterId === ch.id && "text-primary"
                      )}
                    />
                  )}
                  <span className="truncate">{ch.title}</span>
                  {!isLoaded && !isLoading && (
                    <span className="text-[10px] text-muted-foreground ml-auto">(未加载)</span>
                  )}
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </div>
      {/* Toggle — desktop only, aligns with ChapterContent top bar */}
      <button
        onClick={() => setCollapsed(true)}
        className={`${TOGGLE_H} ${TOGGLE_W} hidden md:flex items-center justify-center bg-card border border-l-0 rounded-r-md hover:bg-accent transition-colors group shrink-0`}
        title="收起目录"
      >
        <PanelLeftClose className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
      </button>
    </div>
  );
}
