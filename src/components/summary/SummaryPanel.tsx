import { useState, useEffect, useRef } from "react";
import { useNovelStore } from "@/stores/novel-store";
import { useRAGStore } from "@/stores/rag-store";
import { useBuildStore } from "@/stores/build-store";
import { useUIStore } from "@/stores/ui-store";
import { getEngineDisplayName, isEmbeddingEngine } from "@/rag/engines";
import { authHeaders } from "@/lib/auth-headers";
import { apiFetch } from "@/lib/api-client";
import { useSummaryStore } from "@/stores/summary-store";
import { useSummarizer } from "@/hooks/useSummarizer";
import type { GraphData, MapData } from "@/hooks/useSummarizer";
import { saveNote, loadMap, saveGraph as saveGraphToDB, loadGraph } from "@/db/repositories";
import type { NoteItem } from "@/db/repositories";
import { syncClient } from "@/sync/sync-client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, ChevronRight, ChevronDown, Sparkles, Trash2 } from "lucide-react";
import { buildIndex } from "@/rag/index";
import { buildAndPollRAGIndex } from "@/rag/build-index";
import { DataMgr } from "./shared";
import { useNotes, useQA, useSearch } from "./hooks";
import { QATab, ChapterTab, BookTab, NotesTab, SearchTab } from "./tabs";

export function SummaryPanel({ defaultTab = "chapter" }: { defaultTab?: string }) {
  // Book sub-items: "timeline" | "characters" | "global" | null
  const [bookSub, setBookSub] = useState<string | null>(null);
  const [dataOpen, setDataOpen] = useState(false);

  // Graph data
  const [characterGraphData, setCharacterGraphData] = useState<GraphData | null>(null);

  // Map data
  const [mapData, setMapData] = useState<MapData | null>(null);

  const { currentNovel, selectedChapterId } = useNovelStore();
  // Ref for latest selectedChapterId to avoid stale closures in callbacks
  const selectedChapterRef = useRef(selectedChapterId);
  selectedChapterRef.current = selectedChapterId;
  const { getSummariesByNovel, isGenerating, generateProgress } = useSummaryStore();
  const {
    isRunning, currentTask, currentTaskType, error,
    summarizeChapter, summarizeAllChapters, stopBatchSummary, regenerateChapter,
    generateGlobalSummary, regenerateGlobal,
    generateCharacterAnalysis, generateTimeline,
    generateCharacterGraph, regenerateCharacterGraph,
    regenerateCharacters, regenerateTimeline,
    generateMap, regenerateMap,
    clearError, ragEngineUsed,
  } = useSummarizer();

  // 使用 hooks
  const notesHook = useNotes({
    novelId: currentNovel?.id || "",
    selectedChapterId,
    chapters: currentNovel?.chapters || [],
  });

  // 保持最后有效的 novelId，避免 currentNovel 为 null 时 useQA 收到空字符串
  const lastValidNovelIdRef = useRef(currentNovel?.id || "");
  if (currentNovel?.id) lastValidNovelIdRef.current = currentNovel.id;
  const qaHook = useQA(lastValidNovelIdRef.current);

  const searchHook = useSearch({
    novelId: currentNovel?.id || "",
    chapters: currentNovel?.chapters || [],
  });

  const loading = isRunning || isGenerating || qaHook.qaLoading;
  const engine = useRAGStore((s) => s.engine);
  const offlineMode = useUIStore((s) => s.offlineMode);
  const buildPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 判断各个功能是否正在执行（使用 currentTaskType，不会被 Agent 的 onStatus 回调覆盖）
  const isTimelineRunning = isRunning && currentTaskType.includes("时间线");
  const isCharacterRunning = isRunning && (currentTaskType.includes("人物") || currentTaskType.includes("图谱"));
  const isGlobalRunning = isRunning && currentTaskType.includes("全书");
  const isMapRunning = isRunning && currentTaskType.includes("地图");
  const isChapterRunning = isRunning && !isTimelineRunning && !isCharacterRunning && !isGlobalRunning && !isMapRunning;

  // Cleanup build poll on unmount
  useEffect(() => {
    return () => { if (buildPollRef.current) clearInterval(buildPollRef.current); };
  }, []);

  // Check if current novel+engine has a built index + preload into memory
  const [indexReady, setIndexReady] = useState<boolean | null>(null);
  const [actualEngine, setActualEngine] = useState<string>("");
  const addIndexLoadingKey = useRAGStore((s) => s.addIndexLoadingKey);
  const removeIndexLoadingKey = useRAGStore((s) => s.removeIndexLoadingKey);
  useEffect(() => {
    if (!currentNovel) { setIndexReady(null); setActualEngine(""); return; }
    let cancelled = false;

    // 使用全局变量避免重复加载（多个 SummaryPanel 实例共享）
    const preloadKey = `${currentNovel.id}-${engine}`;
    if ((window as any).__ragPreloaded?.has(preloadKey)) {
      return;
    }
    if (!(window as any).__ragPreloaded) {
      (window as any).__ragPreloaded = new Set();
    }
    (window as any).__ragPreloaded.add(preloadKey);

    // 标记开始加载
    addIndexLoadingKey(preloadKey);

    // Preload index into memory and determine actual engine
    (async () => {
      if (isEmbeddingEngine(engine)) {
        try {
          await buildIndex(currentNovel.id, currentNovel.chapters, engine, undefined, { cacheOnly: true });
          if (!cancelled) setActualEngine(engine);
        } catch {
          if (!cancelled) setActualEngine("tfidf");
        }
      } else {
        if (!cancelled) setActualEngine("tfidf");
      }
      // 标记加载完成
      if (!cancelled) removeIndexLoadingKey(preloadKey);
    })();

    // Check server-side build status (for badge display)
    if (isEmbeddingEngine(engine)) {
      apiFetch(`/api/rag/${currentNovel.id}/status?engine=${encodeURIComponent(engine)}`)
        .then(r => r.json())
        .then(st => { if (!cancelled) setIndexReady(st.status === "ready"); })
        .catch((e) => {
          console.warn("[SummaryPanel] check index status failed:", e);
          if (!cancelled) setIndexReady(null);
        });
    } else {
      setIndexReady(null);
    }

    return () => { cancelled = true; };
  }, [currentNovel?.id, engine]);

  const handleBuildFromPanel = async () => {
    if (!currentNovel) return;
    const buildEngine = engine;

    // 清理现有的轮询（如果有的话）
    if (buildPollRef.current) { clearInterval(buildPollRef.current); buildPollRef.current = null; }

    // 使用公共函数触发构建 + 轮询 + 下载
    try {
      useBuildStore.getState().start();
      await buildAndPollRAGIndex({
        novelId: currentNovel.id,
        engine: buildEngine,
        onProgress: (progress) => {
          useBuildStore.getState().setProgress({
            status: progress.status,
            message: progress.message,
            current: progress.current || 0,
            total: progress.total || 0,
            queuePosition: progress.queuePosition,
          });
        },
      });
      useBuildStore.getState().finish();
      setIndexReady(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "构建失败";
      useBuildStore.getState().fail(message);
    }
  };

  // 收藏 AI 回答到笔记
  const handleBookmarkAI = async (title: string, content: string, chapterId: string, scope?: "chapter" | "book") => {
    if (!currentNovel) return;
    const isBook = scope
      ? scope === "book"
      : (chapterId === "__global__" || chapterId === "__timeline__" || chapterId === "__characters__" || chapterId === "__book__");
    const finalChapterId = isBook ? "__book__" : (chapterId || "__book__");
    const chTitle = isBook ? "全书笔记" : currentNovel.chapters.find((c) => c.id === chapterId)?.title || title;
    const note: NoteItem = {
      id: crypto.randomUUID(),
      novelId: currentNovel.id,
      chapterId: finalChapterId,
      chapterTitle: chTitle,
      content,
      source: "ai",
      sourceLabel: title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveNote(note);
    notesHook.setNotes((prev) => [note, ...prev]);
    syncClient.pushNow();
  };

  // 保存图谱
  const handleSaveGraph = (gd: GraphData | null) => {
    setCharacterGraphData(gd);
    if (currentNovel && gd) saveGraphToDB(currentNovel.id, gd);
  };

  // 计算过滤后的笔记
  const filteredNotes = notesHook.notes.filter((n) =>
    notesHook.noteTab === "chapter"
      ? n.chapterId === selectedChapterId
      : n.chapterId === "__book__"
  );

  // Load graph + map + notes on novel switch
  useEffect(() => {
    notesHook.setNoteContent(""); searchHook.setSearchQuery(""); searchHook.clearSearch();
    let cancelled = false;
    if (currentNovel) {
      loadGraph(currentNovel.id).then((result) => {
        if (!cancelled) setCharacterGraphData(result.data);
      });
      loadMap(currentNovel.id).then((md) => {
        if (!cancelled) setMapData(md);
      });
      notesHook.loadNotesList();
    } else {
      setCharacterGraphData(null);
      setMapData(null);
      notesHook.setNotes([]);
    }
    return () => { cancelled = true; };
  }, [currentNovel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!currentNovel) return <div className="md:w-80 w-full border-l md:border-l border-t md:border-t-0 bg-card h-full shrink-0" />;

  const summaries = getSummariesByNovel(currentNovel.id);
  const chapterSummary = summaries.find((s) => s.chapterId === selectedChapterId && s.type === "chapter");
  const globalSummaries = summaries.filter((s) => s.type === "global");
  const charSummaries = summaries.filter((s) => s.type === "characters");
  const tlSummaries = summaries.filter((s) => s.type === "timeline");

  return (
    <div className="md:w-80 w-full border-l md:border-l border-t md:border-t-0 bg-card h-full flex flex-col shrink-0">
      {/* Header */}
      <div className="p-2.5 border-b shrink-0">
        <h3 className="font-semibold text-xs flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-primary" />AI 分析
        </h3>
      </div>

      {/* Loading indicator */}
      {loading && (
        <div className="mx-2.5 mt-2 p-1.5 rounded bg-primary/10 border border-primary/20 flex items-center gap-2 text-xs text-primary shrink-0">
          <Loader2 className="h-3 w-3 animate-spin shrink-0" />
          <span>AI 正在执行：{currentTask || qaHook.qaLoading ? "问答中..." : "分析任务"}...</span>
        </div>
      )}

      {/* Engine indicator — show actual engine used, or current setting */}
      {(() => {
        const displayEngine = actualEngine || ragEngineUsed || engine;
        const isEmb = isEmbeddingEngine(displayEngine);
        return (
          <div className="mx-2.5 mt-2 text-[10px] text-muted-foreground text-center shrink-0">
            检索引擎:{" "}
            <span className={isEmb ? "text-green-400" : "text-yellow-400"}>
              {getEngineDisplayName(displayEngine)}
            </span>
          </div>
        );
      })()}

      {/* Index not built warning */}
      {isEmbeddingEngine(engine) && indexReady === false && (
        <div className="mx-2.5 mt-1.5 p-2 rounded bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 shrink-0">
          <p className="mb-1">该引擎索引未构建，当前使用 TF-IDF 回退检索</p>
          <Button variant="outline" size="sm" className="h-5 text-[10px] px-2" onClick={handleBuildFromPanel} disabled={offlineMode}>
            {offlineMode ? "离线不可用" : "立即构建"}
          </Button>
        </div>
      )}

      {/* Error banner */}
      {(error || qaHook.qaError) && (
        <div className="mx-2.5 mt-2 p-2 rounded bg-destructive/10 border border-destructive/20 text-xs text-destructive shrink-0">
          <p className="whitespace-pre-wrap">{error || qaHook.qaError}</p>
          <Button variant="ghost" size="sm" className="h-5 text-xs mt-0.5" onClick={() => { clearError(); qaHook.setQaError(null); }}>关闭</Button>
        </div>
      )}

      {/* Fixed tabs — always visible */}
      <Tabs defaultValue={defaultTab} className="flex flex-col flex-1 min-h-0">
        <div className="shrink-0 px-2.5 pt-2 border-b">
          <TabsList className="w-full">
            <TabsTrigger value="qa" className="text-xs h-7 flex-1">问答</TabsTrigger>
            <TabsTrigger value="chapter" className="text-xs h-7 flex-1">本章分析</TabsTrigger>
            <TabsTrigger value="book" className="text-xs h-7 flex-1">全书分析</TabsTrigger>
            <TabsTrigger value="notes" className="text-xs h-7 flex-1">笔记</TabsTrigger>
            <TabsTrigger value="search" className="text-xs h-7 flex-1">搜索</TabsTrigger>
          </TabsList>
        </div>

        <ScrollArea className="flex-1">
          {/* ====== 问答 Tab ====== */}
          <TabsContent value="qa" className="m-0">
            <QATab
              qaHook={qaHook}
              loading={loading}
              chapterCount={currentNovel.chapters.length}
              selectedChapterId={selectedChapterRef.current}
              onBookmark={handleBookmarkAI}
            />
          </TabsContent>

          {/* ====== 本章分析 Tab ====== */}
          <TabsContent value="chapter" className="m-0">
            <ChapterTab
              chapterSummary={chapterSummary}
              loading={loading}
              hasSelectedChapter={!!selectedChapterId}
              generateProgress={generateProgress}
              onSummarize={() => selectedChapterId && summarizeChapter(selectedChapterId)}
              onSummarizeAll={summarizeAllChapters}
              onStopBatch={stopBatchSummary}
              onRegenerate={() => selectedChapterId && regenerateChapter(selectedChapterId)}
              onBookmark={handleBookmarkAI}
            />
          </TabsContent>

          {/* ====== 全书分析 Tab ====== */}
          <TabsContent value="book" className="m-0">
            <BookTab
              novelId={currentNovel.id}
              timelineSummaries={tlSummaries}
              characterSummaries={charSummaries}
              globalSummaries={globalSummaries}
              bookSub={bookSub}
              setBookSub={setBookSub}
              loading={loading}
              timelineLoading={isTimelineRunning}
              characterLoading={isCharacterRunning}
              globalLoading={isGlobalRunning}
              mapLoading={isMapRunning}
              characterGraphData={characterGraphData}
              onGenerateTimeline={generateTimeline}
              onRegenerateTimeline={regenerateTimeline}
              onGenerateCharacters={generateCharacterAnalysis}
              onRegenerateCharacters={regenerateCharacters}
              onGenerateGraph={async () => { const gd = await generateCharacterGraph(); if (gd) handleSaveGraph(gd); }}
              onRegenerateGraph={async () => { const gd = await regenerateCharacterGraph(); if (gd) handleSaveGraph(gd); }}
              onGenerateGlobal={generateGlobalSummary}
              onRegenerateGlobal={regenerateGlobal}
              onGenerateMap={generateMap}
              onRegenerateMap={regenerateMap}
            />
          </TabsContent>

          {/* ====== 笔记 Tab ====== */}
          <TabsContent value="notes" className="m-0">
            <NotesTab
              notesHook={notesHook}
              filteredNotes={filteredNotes}
            />
          </TabsContent>

          {/* ====== 搜索 Tab ====== */}
          <TabsContent value="search" className="m-0">
            <SearchTab
              searchHook={searchHook}
              engine={engine}
              indexReady={indexReady}
              offlineMode={offlineMode}
              onBuild={handleBuildFromPanel}
            />
          </TabsContent>
        </ScrollArea>
      </Tabs>

      {/* Data Mgmt — pinned to bottom */}
      <div className="border-t shrink-0" />
      <div className="p-2.5 shrink-0">
        <button onClick={() => setDataOpen(!dataOpen)}
          className="flex items-center gap-1.5 w-full text-left text-xs font-medium text-muted-foreground hover:text-primary transition-colors">
          {dataOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <Trash2 className="h-3 w-3" />数据管理
        </button>
        {dataOpen && (
          <div className="mt-1.5 max-h-32 overflow-auto">
            <DataMgr novelId={currentNovel.id} summaries={summaries} hasGraph={!!characterGraphData}
              onDeleteGraph={() => handleSaveGraph(null)}
              hasMap={!!mapData}
              onDeleteMap={() => setMapData(null)}
              onNotesChanged={() => notesHook.loadNotesList()}
              noteCount={{
                chapter: notesHook.notes.filter((n) => n.chapterId !== "__book__").length,
                book: notesHook.notes.filter((n) => n.chapterId === "__book__").length
              }} />
          </div>
        )}
      </div>
    </div>
  );
}
