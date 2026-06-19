import { useState, useCallback, useRef } from "react";
import { useNovelStore } from "@/stores/novel-store";
import { useAPIStore } from "@/stores/api-store";
import { useSummaryStore, type SummaryItem } from "@/stores/summary-store";
import { summarizerAgent, globalSummarizerAgent } from "@/agents/summarizer";
import { characterAnalysisAgent, timelineAgent } from "@/agents/analyzers";
import { characterGraphAgent } from "@/agents/graph-agent";
import { mapAgent } from "@/agents/map-agent";
import type { Agent, AgentContext, AgentResult, MapData, TaskTypeValue } from "@/agents/types";
import { TaskType } from "@/agents/types";
import { getProvider } from "@/api/registry";
import { saveSummary, saveMap, deleteMap, loadChapters } from "@/db/repositories";
import { getUserDB } from "@/db/database";
import { APIError } from "@/api/error-handler";
import { getTokenBudget } from "@/api/token-manager";
import { buildIndex, retrieveRelevantWithDetails } from "@/rag/index";
import { useRAGStore } from "@/stores/rag-store";
import { syncClient } from "@/sync/sync-client";
import { addDebugEntry } from "@/components/common/DebugPanel";
import { ragLog } from "@/lib/logger";
import { setAiRunning } from "@/lib/ai-state";

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
  const { currentNovel } = useNovelStore();
  const { getActiveProvider } = useAPIStore();
  const { addSummary, setProgress } = useSummaryStore();
  const abortRef = useRef<AbortController | null>(null);
  // Cached RAG context for Q&A session (cleared on new session or every 3 follow-ups)
  const qaRagCacheRef = useRef<{ question: string; text: string; followUps: number } | null>(null);
  // Guard against concurrent novel reloads
  const reloadingRef = useRef(false);

  const startTask = useCallback((name: string, type?: string) => {
    setCurrentTask(name);
    setCurrentTaskType(type || name);
    setIsRunning(true);
    setAiRunning(true);
    setError(null);
  }, []);

  const endTask = useCallback(() => {
    setIsRunning(false);
    setAiRunning(false);
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
  const getRelevantText = useCallback(
    async (query: string): Promise<string> => {
      if (!currentNovel) { ragLog("getRelevantText: currentNovel 为空"); return ""; }
      const signal = abortRef.current?.signal;
      if (signal?.aborted) { ragLog("getRelevantText: 已取消"); return ""; }
      await new Promise((r) => setTimeout(r, 0));
      const prefEngine = useRAGStore.getState().engine;
      ragLog(`getRelevantText: prefEngine=${prefEngine}, novelId=${currentNovel.id.slice(0, 8)}`);
      try {
        // 确保加载所有章节内容（懒加载可能导致部分章节内容为空）
        let chapters = currentNovel.chapters;
        const hasEmptyContent = chapters.some(ch => !ch.content);
        if (hasEmptyContent && !reloadingRef.current) {
          reloadingRef.current = true;
          try {
            ragLog("检测到空章节内容，重新加载所有章节...");
            const { loadNovel } = await import("@/db/repositories");
            const fullNovel = await loadNovel(currentNovel.id, undefined, true);
            if (fullNovel) {
              chapters = fullNovel.chapters;
              // 更新 store 中的 currentNovel
              useNovelStore.getState().setCurrentNovel(fullNovel);
            }
          } finally {
            reloadingRef.current = false;
          }
        } else if (hasEmptyContent && reloadingRef.current) {
          // 另一个调用正在重载，等待完成
          ragLog("等待另一个重载完成...");
          while (reloadingRef.current) {
            await new Promise(r => setTimeout(r, 50));
          }
          // 重新获取最新的 chapters
          chapters = useNovelStore.getState().currentNovel?.chapters || chapters;
        }

        if (signal?.aborted) { ragLog("getRelevantText: 加载章节后被取消"); return ""; }

        let engine = prefEngine;
        let degraded = false;

        // Only load from cache (memory + IndexedDB). Never trigger a fresh build.
        if (engine !== "tfidf") {
          try {
            await buildIndex(currentNovel.id, chapters, engine, (msg) => setCurrentTask(msg), { cacheOnly: true });
            ragLog(`索引从缓存加载成功 (${engine})`);
          } catch {
            ragLog(`索引未缓存 (${engine}), 降级为 TF-IDF`);
            engine = "tfidf";
            degraded = true;
          }
        }

        const degradedLabel = degraded ? " (降级至 TF-IDF)" : "";
        setCurrentTask(`正在启动检索引擎 (${engine})${degradedLabel}...`);
        if (engine === "tfidf") {
          ragLog("构建 TF-IDF 索引...");
          await buildIndex(currentNovel.id, chapters, engine, (msg) => setCurrentTask(msg + degradedLabel));
        }
        if (signal?.aborted) { ragLog("getRelevantText: 构建索引后被取消"); return ""; }
        setCurrentTask(`正在检索相关段落${degradedLabel}...`);
        const t0 = performance.now();
        const result = await retrieveRelevantWithDetails(currentNovel.id, query, undefined, engine);
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

  const checkProvider = useCallback(() => {
    const provider = getActiveProvider();
    if (!provider) { setError("请先在设置中配置 API"); return null; }
    return provider;
  }, [getActiveProvider]);

  const handleError = useCallback((err: unknown) => {
    if (err instanceof APIError) {
      // 使用 apiCode（API 专用代码）显示错误
      const code = err.apiCode || err.code;
      if (code === "context_length") setError(`[上下文超限] ${err.message}`);
      else if (code === "auth") setError(`[认证失败] ${err.message}`);
      else if (code === "quota_exceeded") setError(`[额度用尽] ${err.message}`);
      else if (code === "rate_limit") setError(`[频率限制] ${err.message}`);
      else if (code === "network") setError(`[网络错误] ${err.message}`);
      else setError(`[${code}] ${err.message}`);
    } else {
      setError(err instanceof Error ? err.message : "未知错误");
    }
  }, []);

  const saveChapterSummary = useCallback(
    async (chapterId: string, result: { success: boolean; data?: unknown; error?: string; tokensUsed?: number }) => {
      if (!currentNovel || !result.success || !result.data) return;
      const data = result.data as { summaries: { chapterTitle: string; content: string; tokens: number }[] };
      for (const s of data.summaries) {
        // Reuse existing ID for same (novelId, chapterId, type) — server upserts by ID, can't signal deletes
        const existing = await getUserDB().summaries.where({ novelId: currentNovel.id, chapterId, type: "chapter" }).first();
        const summary: SummaryItem = {
          id: existing?.id || crypto.randomUUID(), novelId: currentNovel.id, chapterId,
          chapterTitle: s.chapterTitle, content: s.content,
          tokensUsed: s.tokens, createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now(), type: "chapter",
        };
        addSummary(summary);
        await saveSummary(summary);
      }
    },
    [currentNovel, addSummary]
  );

  const saveGlobalSummary = useCallback(
    async (result: { success: boolean; data?: unknown; error?: string; tokensUsed?: number }, type: SummaryItem["type"], title: string, chapterId: string) => {
      if (!currentNovel || !result.success || !result.data) return;
      const data = result.data as { content: string; usedFallback?: boolean };
      // Reuse existing ID for same (novelId, chapterId, type) — server upserts by ID, can't signal deletes
      const existing = await getUserDB().summaries.where({ novelId: currentNovel.id, chapterId, type }).first();
      const summary: SummaryItem = {
        id: existing?.id || crypto.randomUUID(), novelId: currentNovel.id, chapterId,
        chapterTitle: title + (data.usedFallback ? "（精简版）" : ""),
        content: data.content, tokensUsed: result.tokensUsed || 0, createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now(), type,
        usedFallback: data.usedFallback,
      };
      addSummary(summary);
      await saveSummary(summary);
    },
    [currentNovel, addSummary]
  );

  // --- 通用 Agent 任务执行器 ---
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
    const { taskName, agent, context, errorMessage, onSuccess, returnData, taskType } = options;
    startTask(taskName, taskType || agent.taskType);
    try {
      const result = await agent.run(context);
      if (result.success) {
        if (onSuccess) {
          setCurrentTask("正在保存结果...");
          await onSuccess(result);
        }
        return returnData ? result.data : undefined;
      } else {
        setError(result.error || errorMessage);
        return returnData ? null : undefined;
      }
    } catch (err) {
      handleError(err);
      return returnData ? null : undefined;
    } finally {
      endTask();
      syncClient.pushNow();
    }
  }, [startTask, endTask, handleError, setCurrentTask]);

  // --- Chapter summary ---
  const summarizeChapter = useCallback(async (chapterId: string) => {
    if (!currentNovel || !checkProvider()) return;
    await runAgentTask({
      taskName: "总结本章",
      agent: summarizerAgent,
      context: { novelId: currentNovel.id, chapterIds: [chapterId], signal: createSignal(), onStatus: setCurrentTask },
      errorMessage: "总结生成失败",
      onSuccess: (result) => saveChapterSummary(chapterId, result),
    });
  }, [currentNovel, checkProvider, runAgentTask, saveChapterSummary]);

  const regenerateChapter = useCallback(async (chapterId: string) => {
    if (!currentNovel || !checkProvider()) return;
    await runAgentTask({
      taskName: "重新生成总结",
      agent: summarizerAgent,
      context: { novelId: currentNovel.id, chapterIds: [chapterId], signal: createSignal(), onStatus: setCurrentTask },
      errorMessage: "重新生成失败",
      onSuccess: (result) => saveChapterSummary(chapterId, result),
    });
  }, [currentNovel, checkProvider, runAgentTask, saveChapterSummary]);

  // 批量总结停止标志
  const batchStopRef = useRef(false);

  const summarizeAllChapters = useCallback(async (options?: { skipExisting?: boolean }) => {
    if (!currentNovel || !checkProvider()) return;
    const { skipExisting = true } = options || {};

    batchStopRef.current = false;
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
      setCurrentTask("所有章节已有总结");
      endTask();
      return;
    }

    const signal = createSignal();
    setProgress({ current: 0, total: chaptersToSummarize.length });
    try {
      for (let i = 0; i < chaptersToSummarize.length; i++) {
        // 检查停止标志
        if (batchStopRef.current) {
          setCurrentTask("已停止批量总结");
          break;
        }
        if (signal.aborted) break;

        setCurrentTask(`正在总结第 ${i + 1}/${chaptersToSummarize.length} 章...`);
        const result = await summarizerAgent.run({ novelId: currentNovel.id, chapterIds: [chaptersToSummarize[i].id], signal, onStatus: setCurrentTask });
        if (signal.aborted) break;
        if (result.success) { setCurrentTask("正在保存结果..."); await saveChapterSummary(chaptersToSummarize[i].id, result); }
        setProgress({ current: i + 1, total: chaptersToSummarize.length });
      }
    } catch (err) { handleError(err); }
    finally {
      endTask();
      setProgress(null);
      // 推送数据到服务器
      syncClient.pushNow();
    }
  }, [currentNovel, checkProvider, saveChapterSummary, setProgress, handleError]);

  const stopBatchSummary = useCallback(() => {
    batchStopRef.current = true;
  }, []);

  // --- Global summary ---
  const generateGlobalSummary = useCallback(async () => {
    if (!currentNovel || !checkProvider()) return;
    await runAgentTask({
      taskName: "生成全书总览",
      agent: globalSummarizerAgent,
      context: { novelId: currentNovel.id, signal: createSignal(), preRetrieved: await getRelevantText("小说的核心主线、主题思想、故事梗概，关键情节的发展脉络"), onStatus: setCurrentTask },
      errorMessage: "全局总结生成失败",
      onSuccess: (result) => saveGlobalSummary(result, "global", "全书总结", "__global__"),
    });
  }, [currentNovel, checkProvider, runAgentTask, saveGlobalSummary]);

  const regenerateGlobal = useCallback(async () => {
    if (!currentNovel || !checkProvider()) return;
    await runAgentTask({
      taskName: "重新生成全书总览",
      agent: globalSummarizerAgent,
      context: { novelId: currentNovel.id, signal: createSignal(), preRetrieved: await getRelevantText("小说的核心主线、主题思想、故事梗概，关键情节的发展脉络"), onStatus: setCurrentTask },
      errorMessage: "重新生成失败",
      onSuccess: (result) => saveGlobalSummary(result, "global", "全书总结", "__global__"),
    });
  }, [currentNovel, checkProvider, runAgentTask, saveGlobalSummary]);

  // --- Character analysis ---
  const generateCharacterAnalysis = useCallback(async () => {
    if (!currentNovel || !checkProvider()) return;
    await runAgentTask({
      taskName: "生成人物关系分析",
      agent: characterAnalysisAgent,
      context: { novelId: currentNovel.id, signal: createSignal(), preRetrieved: await getRelevantText("小说中各主要角色的关系网络、互动、性格特征与情感变化"), onStatus: setCurrentTask },
      errorMessage: "人物分析失败",
      onSuccess: (result) => saveGlobalSummary(result, "characters", "人物关系分析", "__characters__"),
    });
  }, [currentNovel, checkProvider, runAgentTask, saveGlobalSummary]);

  const regenerateCharacters = useCallback(async () => {
    if (!currentNovel || !checkProvider()) return;
    await runAgentTask({
      taskName: "重新生成人物关系分析",
      agent: characterAnalysisAgent,
      context: { novelId: currentNovel.id, signal: createSignal(), preRetrieved: await getRelevantText("小说中各主要角色的关系网络、互动、性格特征与情感变化"), onStatus: setCurrentTask },
      errorMessage: "重新生成失败",
      onSuccess: (result) => saveGlobalSummary(result, "characters", "人物关系分析", "__characters__"),
    });
  }, [currentNovel, checkProvider, runAgentTask, saveGlobalSummary]);

  // --- Character graph only (no text analysis) ---
  const generateCharacterGraph = useCallback(async (): Promise<GraphData | null> => {
    if (!currentNovel || !checkProvider()) return null;
    const result = await runAgentTask({
      taskName: "生成人物关系图谱",
      agent: characterGraphAgent,
      context: { novelId: currentNovel.id, signal: createSignal(), preRetrieved: await getRelevantText("小说中各主要角色的关系网络、互动、性格特征与情感变化"), onStatus: setCurrentTask },
      errorMessage: "图谱生成失败",
      returnData: true,
    }) as { graphData: GraphData } | null;
    if (result && !result.graphData) {
      setError("图谱生成成功但数据解析失败，请重试");
      return null;
    }
    return result?.graphData || null;
  }, [currentNovel, checkProvider, runAgentTask]);

  const regenerateCharacterGraph = useCallback(async (): Promise<GraphData | null> => {
    if (!currentNovel || !checkProvider()) return null;
    const result = await runAgentTask({
      taskName: "重新生成人物关系图谱",
      agent: characterGraphAgent,
      context: { novelId: currentNovel.id, signal: createSignal(), preRetrieved: await getRelevantText("小说中各主要角色的关系网络、互动、性格特征与情感变化"), onStatus: setCurrentTask },
      errorMessage: "图谱生成失败",
      returnData: true,
    }) as { graphData: GraphData } | null;
    if (result && !result.graphData) {
      setError("图谱生成成功但数据解析失败，请重试");
      return null;
    }
    return result?.graphData || null;
  }, [currentNovel, checkProvider, runAgentTask]);

  // --- Timeline ---
  const generateTimeline = useCallback(async () => {
    if (!currentNovel || !checkProvider()) return;
    await runAgentTask({
      taskName: "生成剧情时间线",
      agent: timelineAgent,
      context: { novelId: currentNovel.id, signal: createSignal(), preRetrieved: await getRelevantText("小说剧情的时间线、关键事件、转折点、伏笔与高潮结局"), onStatus: setCurrentTask },
      errorMessage: "时间线生成失败",
      onSuccess: (result) => saveGlobalSummary(result, "timeline", "剧情时间线", "__timeline__"),
    });
  }, [currentNovel, checkProvider, runAgentTask, saveGlobalSummary]);

  const regenerateTimeline = useCallback(async () => {
    if (!currentNovel || !checkProvider()) return;
    await runAgentTask({
      taskName: "重新生成剧情时间线",
      agent: timelineAgent,
      context: { novelId: currentNovel.id, signal: createSignal(), preRetrieved: await getRelevantText("小说剧情的时间线、关键事件、转折点、伏笔与高潮结局"), onStatus: setCurrentTask },
      errorMessage: "重新生成失败",
      onSuccess: (result) => saveGlobalSummary(result, "timeline", "剧情时间线", "__timeline__"),
    });
  }, [currentNovel, checkProvider, runAgentTask, saveGlobalSummary]);

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
  }, [currentNovel, checkProvider, runAgentTask]);

  const regenerateMap = useCallback(async (): Promise<MapData | null> => {
    if (!currentNovel) return null;
    await deleteMap(currentNovel.id);
    return await generateMap();
  }, [currentNovel, generateMap]);

  // --- Temporary: range summary (in-memory, not saved to DB) ---
  const generateRangeSummary = useCallback(
    async (fromChapter: number, toChapter: number): Promise<TempResult | null> => {
      if (!currentNovel || !checkProvider()) return null;
      const provider = getActiveProvider();
      if (!provider) return null;

      startTask(`第${fromChapter}-${toChapter}章 范围总结`, TaskType.RANGE);
      try {
        // 从 IndexedDB 直接读取指定范围的章节
        setCurrentTask(`正在加载第${fromChapter}-${toChapter}章...`);
        const startIndex = fromChapter - 1;
        const count = toChapter - fromChapter + 1;
        const rangeChapters = await loadChapters(currentNovel.id, startIndex, count);
        // 根据模型 Token 预算计算最大字符数（预留 50% 给 prompt 和输出）
        const budget = provider ? getTokenBudget(provider.model, provider.contextWindow) : null;
        const maxTokens = budget ? Math.floor(budget.maxInputTokens * 0.5) : 30000;
        const maxChars = maxTokens * 3; // 约 3 字符/token
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

以下是通过语义检索找到的该范围内最相关的段落：

${combinedText}`;

        setCurrentTask("正在等待 AI 回答...");
        const providerInstance = getProvider(provider);
        const response = await providerInstance.chat({
          model: "", messages: [{ role: "user", content: prompt }],
          max_tokens: 2048, temperature: 0.5,
          signal: createSignal(),
        });

        return {
          id: crypto.randomUUID(),
          title: `第${fromChapter}-${toChapter}章 范围总结`,
          content: response.content,
          tokensUsed: response.tokensUsed.total,
          createdAt: Date.now(),
        };
      } catch (err) {
        handleError(err);
        return null;
      } finally {
        endTask();
      }
    },
    [currentNovel, checkProvider]
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

      // Build system context
      const chapterList = currentNovel.chapters.map((c, i) => `${i + 1}. ${c.title}`).join("\n");

      // Use cached RAG context for follow-up questions, refresh if topic changes
      let relevantText: string;
      const QA_CACHE_MAX_FOLLOWUPS = 3;
      const cached = qaRagCacheRef.current;
      const isSameTopic = cached && keywordOverlap(cached.question, question) > 0.5;
      if (cached && cached.followUps < QA_CACHE_MAX_FOLLOWUPS && isSameTopic) {
        relevantText = cached.text;
        cached.followUps++;
      } else {
        relevantText = await getRelevantText(question);
        qaRagCacheRef.current = { question, text: relevantText, followUps: 0 };
      }

      const systemPrompt = `你是一位专业的小说分析助手。请根据以下小说信息回答用户问题。请用中文回答。

**小说：**《${currentNovel.title}》
**章节目录：**
${chapterList}

**语义检索相关段落：**
${relevantText || "（无额外参考信息，请基于章节目录回答）"}

记住：你可以基于提供的文本信息和章节目录进行回答。如果信息不足以回答，请诚实说明并基于已有信息给出推断。`;

      // Build messages: system context + conversation history + new question
      const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
        { role: "system", content: systemPrompt },
      ];
      for (const msg of history) {
        messages.push(msg);
      }
      messages.push({ role: "user", content: question });

      try {
        const providerInstance = getProvider(provider);
        const response = await providerInstance.chat({
          model: "",
          messages,
          max_tokens: 2048,
          temperature: 0.5,
          signal: createSignal(),
        });

        return { answer: response.content, tokensUsed: response.tokensUsed.total };
      } catch (err) {
        handleError(err);
        return null;
      }
    },
    [currentNovel, checkProvider]
  );

  return {
    isRunning, currentTask, currentTaskType, error,
    summarizeChapter, summarizeAllChapters, stopBatchSummary, regenerateChapter,
    generateGlobalSummary, regenerateGlobal,
    generateCharacterAnalysis, regenerateCharacters,
    generateCharacterGraph, regenerateCharacterGraph,
    generateTimeline, regenerateTimeline,
    generateMap, regenerateMap,
    generateRangeSummary, askCustomQuestion,
    clearQaCache: () => { qaRagCacheRef.current = null; },
    clearError: () => setError(null),
    abortAll,
    ragEngineUsed,
  };
}
