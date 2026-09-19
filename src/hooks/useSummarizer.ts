import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { useNovelStore } from "@/stores/novel-store";
import { useAPIStore } from "@/stores/api-store";
import { useSummaryStore, type SummaryItem } from "@/stores/summary-store";
import { summarizerAgent, globalSummarizerAgent } from "@/agents/summarizer";
import { characterAnalysisAgent, timelineAgent } from "@/agents/analyzers";
import { characterGraphAgent } from "@/agents/graph-agent";
import { mapAgent } from "@/agents/map-agent";
import type { Agent, AgentContext, AgentResult, MapData, TaskTypeValue } from "@/agents/types";
import { TaskType } from "@/agents/types";
import { runAgentTask as runAgentTaskPure, formatAPIError } from "@/agents/runTask";
import { getProvider } from "@/api/registry";
import { saveSummary, saveMap, deleteMap, loadChapters, loadNovel } from "@/db/repositories";
import { getUserDB } from "@/db/database";
import { APIError } from "@/api/error-handler";
import { getTokenBudget, requireUsableInput, estimateTokens } from "@/api/token-manager";
import { sampleChapterTitles } from "@/agents/utils";
import { buildIndex, retrieveRelevantWithDetails } from "@/rag/index";
import { useRAGStore } from "@/stores/rag-store";
import { syncClient } from "@/sync/sync-client";
import { addDebugEntry } from "@/lib/debug-store";
import { ragLog } from "@/lib/logger";
import { setAiRunning } from "@/lib/ai-state";
import { uuid } from "@/parsers/utils";

export interface GraphData {
  nodes: { id: string; group: string; description: string }[];
  edges: { source: string; target: string; label: string }[];
}

interface TempResult {
  id: string;
  title: string;
  content: string;
  tokensUsed: number;
  createdAt: number;
}

/** Compute keyword overlap between two Chinese/English texts (0-1) using bigrams */
function keywordOverlap(a: string, b: string): number {
  const tokenize = (s: string) => {
    const tokens = new Set<string>();
    // Chinese bigrams (consecutive CJK characters, including Extension B+ via /u flag)
    const cjk = s.match(/[一-鿿㐀-䶿\u{20000}-\u{2a6df}]{2}/gu);
    if (cjk) for (const t of cjk) tokens.add(t);
    // English word-level tokens
    const words = s.match(/[a-zA-Z0-9]+/g);
    if (words) for (const w of words) tokens.add(w.toLowerCase());
    return tokens;
  };
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const t of setA) { if (setB.has(t)) overlap++; }
  return overlap / Math.min(setA.size, setB.size);
}

export function useSummarizer() {
  const [isRunning, setIsRunning] = useState(false);
  const [currentTask, setCurrentTask] = useState("");
  const [currentTaskType, setCurrentTaskType] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const getActiveProvider = useAPIStore((s) => s.getActiveProvider);
  const addSummary = useSummaryStore((s) => s.addSummary);
  const setProgress = useSummaryStore((s) => s.setProgress);
  const abortRef = useRef<AbortController | null>(null);
  // 任务代次：每次启动新任务自增。被 abort 的旧任务在 finally 中回到这里时，
  // 代次已不匹配，跳过状态清理/错误写入，避免覆盖正在运行的新任务的状态
  const taskGenRef = useRef(0);
  // Cached RAG context for Q&A session (cleared on new session or every 3 follow-ups)
  // novelId 必须参与命中判断：面板常驻、切书不重挂，否则上一本书的检索内容
  // 会被当作当前书的 RAG 上下文（跨书污染）
  const qaRagCacheRef = useRef<{ question: string; text: string; followUps: number; novelId: string } | null>(null);

  const startTask = useCallback((name: string, type?: string) => {
    setCurrentTask(name);
    setCurrentTaskType(type || name);
    setIsRunning(true);
    setAiRunning(true);
    useSummaryStore.getState().setGenerating(true);
    setError(null);
  }, []);

  const endTask = useCallback(() => {
    setIsRunning(false);
    setAiRunning(false);
    useSummaryStore.getState().setGenerating(false);
    setCurrentTask("");
    setCurrentTaskType("");
  }, []);

  // Index is loaded on-demand via getRelevantText (only from cache).
  // Explicit build is triggered by the build button in BookSelect.

  // Create a fresh AbortController, aborting any previous one
  const createSignal = useCallback(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    return ctrl.signal;
  }, []);

  const abortAll = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Pre-retrieve relevant text using local RAG. Falls back to TF-IDF if embedding engine not ready.
  const [ragEngineUsed, setRagEngineUsed] = useState<string>("");
  // 切换小说时清除上次使用的引擎记录，避免显示 stale 值
  const prevNovelIdRef = useRef(currentNovel?.id);
  useEffect(() => {
    if (prevNovelIdRef.current !== currentNovel?.id) {
      prevNovelIdRef.current = currentNovel?.id;
      setRagEngineUsed("");
    }
  }, [currentNovel?.id]);
  const getRelevantText = useCallback(
    async (query: string): Promise<string> => {
      if (!currentNovel) { ragLog("getRelevantText: currentNovel 为空"); return ""; }
      const signal = abortRef.current?.signal;
      if (signal?.aborted) { ragLog("getRelevantText: 已取消"); return ""; }
      await new Promise((r) => setTimeout(r, 0));
      const prefEngine = useRAGStore.getState().engine;
      ragLog(`getRelevantText: prefEngine=${prefEngine}, novelId=${currentNovel.id.slice(0, 8)}`);
      try {
        let engine = prefEngine;
        let degraded = false;

        // 优先从缓存加载 RAG 索引（内存 LRU + IndexedDB）
        // 索引自带 chunks 文本，不需要加载全书章节
        if (engine !== "tfidf") {
          try {
            await buildIndex(currentNovel.id, currentNovel.chapters, engine, (msg) => setCurrentTask(msg), { cacheOnly: true });
            ragLog(`索引从缓存加载成功 (${engine})`);
          } catch {
            ragLog(`索引未缓存 (${engine}), 降级为 TF-IDF`);
            engine = "tfidf";
            degraded = true;
          }
        }

        // TF-IDF 路径：先检查缓存，缓存未命中时才加载全书
        const chapters = currentNovel.chapters;
        if (engine === "tfidf") {
          // 尝试从缓存加载 TF-IDF 索引
          try {
            await buildIndex(currentNovel.id, chapters, "tfidf", undefined, { cacheOnly: true });
            ragLog(`TF-IDF 索引从缓存加载成功`);
          } catch {
            // TF-IDF 缓存未命中，流式构建（内部逐批加载章节，不预加载全书）
            ragLog("TF-IDF 缓存未命中，流式构建...");
            const degradedLabel = degraded ? " (降级至 TF-IDF)" : "";
            setCurrentTask(`正在构建 TF-IDF 索引${degradedLabel}...`);
            await buildIndex(currentNovel.id, [], "tfidf",
              (msg) => setCurrentTask(msg + degradedLabel),
              undefined,
              currentNovel.chapterCount  // 传入章节数，由 buildIndex 内部流式加载
            );
          }
        }

        if (signal?.aborted) { ragLog("getRelevantText: 被取消"); return ""; }

        const degradedLabel = degraded ? " (降级至 TF-IDF)" : "";
        if (engine !== "tfidf") {
          setCurrentTask(`正在启动检索引擎 (${engine})${degradedLabel}...`);
        }
        if (signal?.aborted) { ragLog("getRelevantText: 构建索引后被取消"); return ""; }
        setCurrentTask(`正在检索相关段落${degradedLabel}...`);
        const t0 = performance.now();
        const result = await retrieveRelevantWithDetails(currentNovel.id, query, undefined, engine, { signal });
        setRagEngineUsed(result.engine);
        addDebugEntry({ query, duration: (performance.now() - t0) / 1000, results: result.results, engine: result.engine });
        ragLog(`检索: "${query}" → ${result.results.length}段 ${result.text.length}字 (${result.engine})`);
        return result.text;
      } catch (e) {
        ragLog(`getRelevantText 异常: ${e instanceof Error ? e.message : e}`);
        return "";
      }
    },
    [currentNovel]
  );

  // RAG 预取纳入任务生命周期：先 startTask（UI 进入运行态、生成按钮禁用、
  // 停止按钮出现）再预取。否则大书 TF-IDF 流式构建期间（可达分钟级）无任何
  // loading 提示、按钮可重复触发并发构建、且无法停止。
  // 代次必须在这里就自增：被顶替的旧任务其迟到 finally 以 gen 匹配为准，
  // 若预取期间代次不动，旧任务会在检索期把运行态清掉
  const preRetrieve = useCallback(async (query: string): Promise<string> => {
    taskGenRef.current++;
    startTask("正在检索相关内容", "检索");
    try {
      return await getRelevantText(query);
    } catch (e) {
      // 预取失败不阻塞任务：返回空串走 agent 内部的采样回退
      console.warn("[useSummarizer] RAG 预取失败，回退空上下文:", e);
      return "";
    }
  }, [startTask, getRelevantText]);

  const checkProvider = useCallback(() => {
    const provider = getActiveProvider();
    if (!provider) { setError("请先在设置中配置 API"); return null; }
    return provider;
  }, [getActiveProvider]);

  const handleError = useCallback((err: unknown) => {
    setError(formatAPIError(err));
  }, []);

  // novelId 由调用方显式传入（任务启动时锚定的 id），不读 currentNovel：
  // 任务运行中用户可能切换小说，读 store 会把旧书生成的总结写进新书的 novelId 下
  const saveChapterSummary = useCallback(
    async (novelId: string, chapterId: string, result: { success: boolean; data?: unknown; error?: string; tokensUsed?: number }) => {
      if (!result.success || !result.data) return;
      const data = result.data as { summaries: { chapterTitle: string; content: string; tokens: number }[] };
      for (const s of data.summaries) {
        // Reuse existing ID for same (novelId, chapterId, type) — server upserts by ID, can't signal deletes
        const existing = await getUserDB().summaries.where({ novelId, chapterId, type: "chapter" }).first();
        const summary: SummaryItem = {
          id: existing?.id || uuid(), novelId, chapterId,
          chapterTitle: s.chapterTitle, content: s.content,
          tokensUsed: s.tokens, createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now(), type: "chapter",
        };
        await saveSummary(summary);
        addSummary(summary);
      }
    },
    [addSummary]
  );

  const saveGlobalSummary = useCallback(
    async (novelId: string, result: { success: boolean; data?: unknown; error?: string; tokensUsed?: number }, type: SummaryItem["type"], title: string, chapterId: string) => {
      if (!result.success || !result.data) return;
      const data = result.data as { content: string; usedFallback?: boolean };
      // Reuse existing ID for same (novelId, chapterId, type) — server upserts by ID, can't signal deletes
      const existing = await getUserDB().summaries.where({ novelId, chapterId, type }).first();
      const summary: SummaryItem = {
        id: existing?.id || uuid(), novelId, chapterId,
        chapterTitle: title + (data.usedFallback ? "（精简版）" : ""),
        content: data.content, tokensUsed: result.tokensUsed || 0, createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now(), type,
        usedFallback: data.usedFallback,
      };
      await saveSummary(summary);
      addSummary(summary);
    },
    [addSummary]
  );

  // --- 通用 Agent 任务执行器（薄封装：注入 React 状态回调 + 复用纯逻辑层）---
  const runAgentTask = useCallback(async (options: {
    taskName: string;
    agent: Agent;
    context: AgentContext;
    errorMessage: string;
    onSuccess?: (result: AgentResult) => Promise<void>;
    returnData?: boolean;
    /** 任务类型标识，优先使用，其次使用 agent.taskType，最后回退到 taskName */
    taskType?: TaskTypeValue;
  }): Promise<unknown> => {
    const gen = ++taskGenRef.current;
    // context.onStatus 也要代次保护：旧任务被 abort 后的尾部回调不得覆盖新任务文案
    const guardedContext: AgentContext = {
      ...options.context,
      onStatus: (msg: string) => {
        if (gen === taskGenRef.current) options.context.onStatus?.(msg);
      },
    };
    return runAgentTaskPure({
      onStart: (name, type) => startTask(name, type || ""),
      onStatus: (msg) => { if (gen === taskGenRef.current) setCurrentTask(msg); },
      onError: (msg) => {
        // 用户主动取消（停止按钮触发 abort）不是错误：lib/error-handler 对
        // ABORTED 的固定文案，此处跳过以免取消后弹出红色错误条
        if (gen === taskGenRef.current && msg !== "操作已取消") setError(msg);
      },
      onDone: () => { if (gen === taskGenRef.current) endTask(); },
      onPush: () => syncClient.pushNow(),
    }, { ...options, context: guardedContext });
  }, [startTask, setCurrentTask, setError, endTask]);

  // --- Chapter summary ---
  const summarizeChapter = useCallback(async (chapterId: string) => {
    if (!currentNovel || !checkProvider()) return;
    await runAgentTask({
      taskName: "总结本章",
      agent: summarizerAgent,
      context: { novelId: currentNovel.id, chapterIds: [chapterId], signal: createSignal(), onStatus: setCurrentTask },
      errorMessage: "总结生成失败",
      onSuccess: (result) => saveChapterSummary(currentNovel.id, chapterId, result),
    });
  }, [currentNovel, checkProvider, runAgentTask, saveChapterSummary, createSignal]);

  const regenerateChapter = useCallback(async (chapterId: string) => {
    if (!currentNovel || !checkProvider()) return;
    await runAgentTask({
      taskName: "重新生成总结",
      agent: summarizerAgent,
      context: { novelId: currentNovel.id, chapterIds: [chapterId], signal: createSignal(), onStatus: setCurrentTask },
      errorMessage: "重新生成失败",
      onSuccess: (result) => saveChapterSummary(currentNovel.id, chapterId, result),
    });
  }, [currentNovel, checkProvider, runAgentTask, saveChapterSummary, createSignal]);

  // 批量总结停止标志
  const batchStopRef = useRef(false);

  const summarizeAllChapters = useCallback(async (options?: { skipExisting?: boolean }) => {
    if (!currentNovel || !checkProvider()) return;
    const { skipExisting = true } = options || {};

    batchStopRef.current = false;
    const gen = ++taskGenRef.current;
    startTask("批量总结所有章节", TaskType.CHAPTER);
    const chapters = currentNovel.chapters;

    // 获取已有的章节总结
    const existingSummaries = await getUserDB().summaries
      .where({ novelId: currentNovel.id, type: "chapter" })
      .toArray();
    const existingChapterIds = new Set(existingSummaries.map(s => s.chapterId));

    // 计算需要总结的章节
    const chaptersToSummarize = skipExisting
      ? chapters.filter(ch => !existingChapterIds.has(ch.id))
      : chapters;

    if (chaptersToSummarize.length === 0) {
      if (gen === taskGenRef.current) {
        setCurrentTask("所有章节已有总结");
        endTask();
      }
      return;
    }

    const signal = createSignal();
    setProgress({ current: 0, total: chaptersToSummarize.length });
    try {
      // 一次性预加载全书内容，循环内逐章复用：
      // 原实现每章 agent.run 都会触发一次全书 IndexedDB 加载（N 章 = N 次全量 IO）
      setCurrentTask("正在加载小说数据...");
      const fullNovel = await loadNovel(currentNovel.id, undefined, true);
      if (!fullNovel) throw new Error("小说数据未找到");

      let failedCount = 0;
      for (let i = 0; i < chaptersToSummarize.length; i++) {
        // 检查停止标志
        if (batchStopRef.current) {
          setCurrentTask("已停止批量总结");
          break;
        }
        if (signal.aborted) break;
        // 被新任务取代（createSignal abort 了本任务）时退出循环，
        // 任务状态由新任务接管，此处不得再写任何任务状态
        if (gen !== taskGenRef.current) break;

        setCurrentTask(`正在总结第 ${i + 1}/${chaptersToSummarize.length} 章...`);
        const result = await summarizerAgent.run({ novelId: currentNovel.id, chapterIds: [chaptersToSummarize[i].id], signal, onStatus: setCurrentTask, preloadedNovel: fullNovel });
        if (signal.aborted) break;
        if (result.success) {
          setCurrentTask("正在保存结果...");
          await saveChapterSummary(currentNovel.id, chaptersToSummarize[i].id, result);
        } else {
          failedCount++;
        }
        setProgress({ current: i + 1, total: chaptersToSummarize.length });
      }
      if (failedCount > 0 && gen === taskGenRef.current) {
        setError(`批量总结完成，${failedCount} 章失败`);
      }
    } catch (err) {
      // 被新任务取代后的异常不再写入错误状态（会覆盖新任务的运行状态）
      if (gen === taskGenRef.current) handleError(err);
    }
    finally {
      if (gen === taskGenRef.current) {
        endTask();
        setProgress(null);
      }
      // 推送数据到服务器
      syncClient.pushNow();
    }
  }, [currentNovel, checkProvider, saveChapterSummary, setProgress, handleError, startTask, endTask, createSignal]);

  const stopBatchSummary = useCallback(() => {
    batchStopRef.current = true;
  }, []);

  // --- Global summary ---
  const generateGlobalSummary = useCallback(async () => {
    if (!currentNovel || !checkProvider()) return;
    await runAgentTask({
      taskName: "生成全书总览",
      agent: globalSummarizerAgent,
      context: { novelId: currentNovel.id, signal: createSignal(), preRetrieved: await preRetrieve("小说的核心主线、主题思想、故事梗概，关键情节的发展脉络"), onStatus: setCurrentTask },
      errorMessage: "全局总结生成失败",
      onSuccess: (result) => saveGlobalSummary(currentNovel.id, result, "global", "全书总结", "__global__"),
    });
  }, [currentNovel, checkProvider, runAgentTask, saveGlobalSummary, createSignal, preRetrieve]);

  const regenerateGlobal = useCallback(async () => {
    if (!currentNovel || !checkProvider()) return;
    await runAgentTask({
      taskName: "重新生成全书总览",
      agent: globalSummarizerAgent,
      context: { novelId: currentNovel.id, signal: createSignal(), preRetrieved: await preRetrieve("小说的核心主线、主题思想、故事梗概，关键情节的发展脉络"), onStatus: setCurrentTask },
      errorMessage: "重新生成失败",
      onSuccess: (result) => saveGlobalSummary(currentNovel.id, result, "global", "全书总结", "__global__"),
    });
  }, [currentNovel, checkProvider, runAgentTask, saveGlobalSummary, createSignal, preRetrieve]);

  // --- Character analysis ---
  const generateCharacterAnalysis = useCallback(async () => {
    if (!currentNovel || !checkProvider()) return;
    await runAgentTask({
      taskName: "生成人物关系分析",
      agent: characterAnalysisAgent,
      context: { novelId: currentNovel.id, signal: createSignal(), preRetrieved: await preRetrieve("小说中各主要角色的关系网络、互动、性格特征与情感变化"), onStatus: setCurrentTask },
      errorMessage: "人物分析失败",
      onSuccess: (result) => saveGlobalSummary(currentNovel.id, result, "characters", "人物关系分析", "__characters__"),
    });
  }, [currentNovel, checkProvider, runAgentTask, saveGlobalSummary, createSignal, preRetrieve]);

  const regenerateCharacters = useCallback(async () => {
    if (!currentNovel || !checkProvider()) return;
    await runAgentTask({
      taskName: "重新生成人物关系分析",
      agent: characterAnalysisAgent,
      context: { novelId: currentNovel.id, signal: createSignal(), preRetrieved: await preRetrieve("小说中各主要角色的关系网络、互动、性格特征与情感变化"), onStatus: setCurrentTask },
      errorMessage: "重新生成失败",
      onSuccess: (result) => saveGlobalSummary(currentNovel.id, result, "characters", "人物关系分析", "__characters__"),
    });
  }, [currentNovel, checkProvider, runAgentTask, saveGlobalSummary, createSignal, preRetrieve]);

  // --- Character graph only (no text analysis) ---
  const generateCharacterGraph = useCallback(async (): Promise<GraphData | null> => {
    if (!currentNovel || !checkProvider()) return null;
    const result = await runAgentTask({
      taskName: "生成人物关系图谱",
      agent: characterGraphAgent,
      context: { novelId: currentNovel.id, signal: createSignal(), preRetrieved: await preRetrieve("小说中各主要角色的关系网络、互动、性格特征与情感变化"), onStatus: setCurrentTask },
      errorMessage: "图谱生成失败",
      returnData: true,
    }) as { graphData: GraphData } | null;
    if (result && !result.graphData) {
      setError("图谱生成成功但数据解析失败，请重试");
      return null;
    }
    return result?.graphData || null;
  }, [currentNovel, checkProvider, runAgentTask, createSignal, preRetrieve]);

  const regenerateCharacterGraph = useCallback(async (): Promise<GraphData | null> => {
    if (!currentNovel || !checkProvider()) return null;
    const result = await runAgentTask({
      taskName: "重新生成人物关系图谱",
      agent: characterGraphAgent,
      context: { novelId: currentNovel.id, signal: createSignal(), preRetrieved: await preRetrieve("小说中各主要角色的关系网络、互动、性格特征与情感变化"), onStatus: setCurrentTask },
      errorMessage: "图谱生成失败",
      returnData: true,
    }) as { graphData: GraphData } | null;
    if (result && !result.graphData) {
      setError("图谱生成成功但数据解析失败，请重试");
      return null;
    }
    return result?.graphData || null;
  }, [currentNovel, checkProvider, runAgentTask, createSignal, preRetrieve]);

  // --- Timeline ---
  const generateTimeline = useCallback(async () => {
    if (!currentNovel || !checkProvider()) return;
    await runAgentTask({
      taskName: "生成剧情时间线",
      agent: timelineAgent,
      context: { novelId: currentNovel.id, signal: createSignal(), preRetrieved: await preRetrieve("小说剧情的时间线、关键事件、转折点、伏笔与高潮结局"), onStatus: setCurrentTask },
      errorMessage: "时间线生成失败",
      onSuccess: (result) => saveGlobalSummary(currentNovel.id, result, "timeline", "剧情时间线", "__timeline__"),
    });
  }, [currentNovel, checkProvider, runAgentTask, saveGlobalSummary, createSignal, preRetrieve]);

  const regenerateTimeline = useCallback(async () => {
    if (!currentNovel || !checkProvider()) return;
    await runAgentTask({
      taskName: "重新生成剧情时间线",
      agent: timelineAgent,
      context: { novelId: currentNovel.id, signal: createSignal(), preRetrieved: await preRetrieve("小说剧情的时间线、关键事件、转折点、伏笔与高潮结局"), onStatus: setCurrentTask },
      errorMessage: "重新生成失败",
      onSuccess: (result) => saveGlobalSummary(currentNovel.id, result, "timeline", "剧情时间线", "__timeline__"),
    });
  }, [currentNovel, checkProvider, runAgentTask, saveGlobalSummary, createSignal, preRetrieve]);

  // --- Map generation ---
  const generateMap = useCallback(async (): Promise<MapData | null> => {
    if (!currentNovel || !checkProvider()) return null;
    const result = await runAgentTask({
      taskName: "生成小说地图",
      agent: mapAgent,
      context: { novelId: currentNovel.id, signal: createSignal(), onStatus: setCurrentTask },
      errorMessage: "地图生成失败",
      returnData: true,
    });
    if (result && typeof result === "object" && "mapData" in result) {
      const mapData = (result as { mapData: MapData }).mapData;
      await saveMap(currentNovel.id, mapData);
      return mapData;
    }
    return null;
  }, [currentNovel, checkProvider, runAgentTask, createSignal]);

  const regenerateMap = useCallback(async (): Promise<MapData | null> => {
    if (!currentNovel) return null;
    await deleteMap(currentNovel.id);
    return await generateMap();
  }, [currentNovel, generateMap]);

  // --- Temporary: range summary (in-memory, not saved to DB) ---
  const generateRangeSummary = useCallback(
    async (fromChapter: number, toChapter: number): Promise<TempResult | null> => {
      if (!currentNovel || !checkProvider()) return null;
      const provider = getActiveProvider()!;

      startTask(`第${fromChapter}-${toChapter}章 范围总结`, TaskType.RANGE);
      try {
        // 从 IndexedDB 直接读取指定范围的章节
        setCurrentTask(`正在加载第${fromChapter}-${toChapter}章...`);
        const startIndex = fromChapter - 1;
        const count = toChapter - fromChapter + 1;
        const rangeChapters = await loadChapters(currentNovel.id, startIndex, count);
        // 根据模型 Token 预算精确计算最大字符数（可用输入 = 上下文 - 输出预算2048 - 安全余量）
        const budget = provider ? getTokenBudget(provider.model, provider.contextWindow, provider.maxTokens) : null;
        const maxTokens = budget ? requireUsableInput(budget, 2048, "范围总结") : 40000;
        const maxChars = Math.floor(maxTokens); // 中文约 1 字 = 1 token
        let combinedText = "";
        let totalChars = 0;
        const includedTitles: string[] = [];
        for (const ch of rangeChapters) {
          if (!ch.content) continue;
          const remaining = maxChars - totalChars;
          if (remaining <= 0) break;
          const text = ch.content.length > remaining ? ch.content.slice(0, remaining) : ch.content;
          combinedText += `\n\n--- ${ch.title} ---\n${text}`;
          totalChars += text.length;
          includedTitles.push(ch.title);
        }
        const actualFrom = rangeChapters[0]?.title || `第${fromChapter}章`;
        const actualTo = rangeChapters[rangeChapters.length - 1]?.title || `第${toChapter}章`;
        ragLog(`范围总结: ${includedTitles.length}章, combinedText=${totalChars}字`);

        const prompt = `你是一位专业的小说分析助手。请对以下小说章节范围进行总结分析。

章节范围：${actualFrom} 到 ${actualTo}（共 ${includedTitles.length} 章）

要求：
1. **核心情节**（概括该段落的整体剧情走向）
2. **关键事件**（列出最重要的5-8个事件）
3. **人物变化**（主要角色在该段落中的发展变化）
4. **承上启下**（该段落在全书中的位置和作用）

请用简洁清晰的中文回答。

以下是该范围内的章节原文（已按顺序拼接，超出的部分被截断）：

${combinedText}`;

        setCurrentTask("正在等待 AI 回答...");
        const providerInstance = getProvider(provider);
        const response = await providerInstance.chat({
          model: "", messages: [{ role: "user", content: prompt }],
          max_tokens: Math.min(2048, budget?.maxOutputTokens ?? 2048),
          signal: createSignal(),
        });

        // 防御：即使 API 返回 200，空内容也视为失败，避免保存空白总结
        if (!response.content || !response.content.trim()) {
          handleError(new APIError("API 返回了空内容", "server"));
          return null;
        }

        return {
          id: uuid(),
          title: `第${fromChapter}-${toChapter}章 范围总结`,
          content: response.content,
          tokensUsed: response.content.length,
          createdAt: Date.now(),
        };
      } catch (err) {
        // 用户主动取消不是错误：不写入错误状态（否则显示原始 abort 信息）
        if (err instanceof Error && err.name === "AbortError") return null;
        handleError(err);
        return null;
      } finally {
        endTask();
      }
    },
    [currentNovel, checkProvider, createSignal, endTask, getActiveProvider, handleError, startTask]
  );

  // --- Temporary: custom question with conversation history ---
  const askCustomQuestion = useCallback(
    async (
      question: string,
      history: { role: "user" | "assistant"; content: string }[]
    ): Promise<{ answer: string; tokensUsed: number } | null> => {
      if (!currentNovel || !checkProvider()) return null;
      const provider = getActiveProvider();
      if (!provider) return null;

      // 上下文按预算装配（round 2 R-35）：此前系统提示里塞的是**全量**章节目录
      // + 最多 80 个 RAG 片段（约 45k token）+ 全量对话历史，且不经过
      // chatWithContextRetry → 长书 + 多轮追问必然 400，且不会自愈。
      const QA_OUTPUT_TOKENS = 2048;
      const budget = getTokenBudget(provider.model, provider.contextWindow, provider.maxTokens);
      // 预算校验必须在进入运行态之前收口（round 3 R-73）：它是下面这段装配里唯一会抛的
      // 调用，而 startTask 与那个 try/finally 之间没有兜底——一次"上下文窗口不足"就会把
      // 模块级 aiRunning 与 isGenerating 永久留在 true，同步还把 getAiRunning 当门控，
      // 症状是"AI 按钮全灰、进度条一直转、界面显示已同步却永不再上传"。
      // 走 handleError 也保住了这句精确文案，而不是上层那句笼统的"问答失败，请重试"。
      let available: number;
      try {
        available = requireUsableInput(budget, QA_OUTPUT_TOKENS, "问答");
      } catch (err) {
        handleError(err);
        return null;
      }

      startTask("问答", TaskType.QA);
      const allTitles = currentNovel.chapters.map((c, i) => `${i + 1}. ${c.title}`);

      // Use cached RAG context for follow-up questions, refresh if topic changes
      let relevantText: string;
      const QA_CACHE_MAX_FOLLOWUPS = 3;
      const cached = qaRagCacheRef.current;
      const isSameNovel = cached?.novelId === currentNovel.id;
      const isSameTopic = cached && isSameNovel && keywordOverlap(cached.question, question) > 0.5;
      if (cached && cached.followUps < QA_CACHE_MAX_FOLLOWUPS && isSameTopic) {
        relevantText = cached.text;
        cached.followUps++;
      } else {
        relevantText = await getRelevantText(question);
        qaRagCacheRef.current = { question, text: relevantText, followUps: 0, novelId: currentNovel.id };
      }

      // 历史从最新往回装，最多 12 轮，且不超过预算的 30%
      const historyCap = Math.floor(available * 0.3);
      const keptReversed: { role: "user" | "assistant"; content: string }[] = [];
      let historyTokens = 0;
      const recentFirst = [...history].reverse();
      for (const msg of recentFirst) {
        if (keptReversed.length >= 12) break;
        const cost = estimateTokens(msg.content) + 4;
        if (keptReversed.length > 0 && historyTokens + cost > historyCap) break;
        keptReversed.push(msg);
        historyTokens += cost;
      }
      const keptHistory = keptReversed.reverse();
      const droppedTurns = Math.max(0, history.length - keptHistory.length);

      const chapterSample = sampleChapterTitles(allTitles, Math.floor(available * 0.2));

      const systemSkeleton = `你是一位专业的小说分析助手。请根据以下小说信息回答用户问题。请用中文回答。

**小说：**《${currentNovel.title}》
**章节目录：**
${chapterSample.text}

**语义检索相关段落：**
`;
      const tailNote = chapterSample.sampled
        ? "\n\n注意：章节目录过长，上面只给了抽样部分。若抽样不足以回答，请明确说明需要查阅哪些章节，不要凭目录猜测剧情。"
        : "";
      const fixedCost = estimateTokens(systemSkeleton) + estimateTokens(tailNote) + estimateTokens(question);
      const ragCap = Math.max(200, available - historyTokens - fixedCost);
      let relevantBody = relevantText || "（无额外参考信息，请基于章节目录回答）";
      if (estimateTokens(relevantBody) > ragCap) {
        // 按字符近似截断（中文约 1 字 = 1 token）
        relevantBody = relevantBody.slice(0, Math.max(0, ragCap)) + "\n……（检索结果因长度限制被截断）";
      }

      const systemPrompt = `${systemSkeleton}${relevantBody}${tailNote}`;

      // Build messages: system context + conversation history + new question
      const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
        { role: "system", content: systemPrompt },
      ];
      for (const msg of keptHistory) {
        messages.push(msg);
      }
      messages.push({ role: "user", content: question });
      if (droppedTurns > 0) {
        console.log(`[qa] 历史超出预算，省略最早 ${droppedTurns} 条消息`);
      }

      try {
        const providerInstance = getProvider(provider);
        const response = await providerInstance.chat({
          model: "",
          messages,
          // 与上面 computeAvailableInput 的输出预留取同一值，否则预算算小了
          // 而请求要得多，严格校验的服务商必 400
          max_tokens: Math.min(QA_OUTPUT_TOKENS, budget.maxOutputTokens),
          temperature: 0.5,
          signal: createSignal(),
        });

        // 防御：即使 API 返回 200，空内容也视为失败，避免显示空白回答
        if (!response.content || !response.content.trim()) {
          handleError(new APIError("API 返回了空内容", "server"));
          return null;
        }

        return { answer: response.content, tokensUsed: response.content.length };
      } catch (err) {
        // 用户主动取消（停止按钮触发 abort）：向上抛出让调用方静默处理，
        // 否则 useQA 会把它当成失败显示"问答失败，请重试"
        if (err instanceof Error && err.name === "AbortError") throw err;
        handleError(err);
        return null;
      } finally {
        endTask();
      }
    },
    [currentNovel, checkProvider, createSignal, endTask, getActiveProvider, getRelevantText, handleError, startTask]
  );

  const clearQaCache = useCallback(() => { qaRagCacheRef.current = null; }, []);
  const clearError = useCallback(() => setError(null), []);

  return useMemo(() => ({
    isRunning, currentTask, currentTaskType, error,
    summarizeChapter, summarizeAllChapters, stopBatchSummary, regenerateChapter,
    generateGlobalSummary, regenerateGlobal,
    generateCharacterAnalysis, regenerateCharacters,
    generateCharacterGraph, regenerateCharacterGraph,
    generateTimeline, regenerateTimeline,
    generateMap, regenerateMap,
    generateRangeSummary, askCustomQuestion,
    clearQaCache,
    clearError,
    abortAll,
    ragEngineUsed,
  }), [
    isRunning, currentTask, currentTaskType, error,
    summarizeChapter, summarizeAllChapters, stopBatchSummary, regenerateChapter,
    generateGlobalSummary, regenerateGlobal,
    generateCharacterAnalysis, regenerateCharacters,
    generateCharacterGraph, regenerateCharacterGraph,
    generateTimeline, regenerateTimeline,
    generateMap, regenerateMap,
    generateRangeSummary, askCustomQuestion,
    clearQaCache, clearError, abortAll, ragEngineUsed,
  ]);
}
