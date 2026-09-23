import { useCallback, useMemo } from "react";
import { useNovelStore } from "@/stores/novel-store";
import { useAPIStore } from "@/stores/api-store";
import { useSummaryStore, type SummaryItem } from "@/stores/summary-store";
import { useAiTaskStore, taskForNovel } from "@/stores/ai-task-store";
import { runAiTask, cancelNovelTasks, type AiTaskContext } from "@/lib/ai-task-queue";
import { summarizerAgent, globalSummarizerAgent } from "@/agents/summarizer";
import { characterAnalysisAgent, timelineAgent } from "@/agents/analyzers";
import { characterGraphAgent } from "@/agents/graph-agent";
import { mapAgent } from "@/agents/map-agent";
import type { Agent, AgentContext, AgentResult, AnalysisMetadata, MapData, TaskTypeValue } from "@/agents/types";
import { TaskType } from "@/agents/types";
import { runAgentTask as runAgentTaskPure, formatAPIError, type TaskStatusHooks } from "@/agents/runTask";
import { getProvider } from "@/api/registry";
import { saveSummary, saveMap, saveGraph, deleteMap, loadChapters, loadNovel } from "@/db/repositories";
import { getUserDB } from "@/db/database";
import { APIError } from "@/api/error-handler";
import { getTokenBudget, requireUsableInput, resolveOutputReserve, estimateTokens } from "@/api/token-manager";
import { sampleChapterTitles } from "@/agents/utils";
import { buildIndex, retrieveRelevantWithDetails } from "@/rag/index";
import { useRAGStore } from "@/stores/rag-store";
import { syncClient } from "@/sync/sync-client";
import { addDebugEntry } from "@/lib/debug-store";
import { ragLog } from "@/lib/logger";
import { uuid } from "@/parsers/utils";

export interface GraphData {
  nodes: { id: string; group: string; description: string }[];
  /**
   * `autoLinked` 由 `graph-agent` 在"模型一条关系都没回"时补出来的那条链打标：
   * 界面上它长得和真关系一模一样，所以必须能分开（提示行与虚线只认这个标记）。
   */
  edges: { source: string; target: string; label: string; autoLinked?: boolean }[];
}

interface TempResult {
  id: string;
  title: string;
  content: string;
  tokensUsed: number;
  createdAt: number;
  metadata?: AnalysisMetadata;
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

/**
 * 追问用的 RAG 上下文缓存，按 novelId 存在模块层。
 *
 * 它原先挂在 hook 实例上，而实例跟着面板生灭 —— 折叠再展开就换了一份空缓存，同一
 * 话题的追问要重新检索一次（重新编码、重新花钱）。任务的命既然已经不在组件手里，
 * 这块缓存也没有理由再跟着组件走。
 */
const qaRagCache = new Map<string, { question: string; text: string; followUps: number }>();

/** 任务的错误写进那本书的台账：面板可能整只不在场，等它回来时错误条还在 */
function failTask(novelId: string, message: string) {
  useAiTaskStore.getState().setNovelError(novelId, message);
}

/**
 * `runTask` 纯逻辑层的回调 → 任务台账。
 *
 * onStart/onDone 归队列管（入队即记名称与类型，收尾由队列负责），所以这里留空。
 * 原先那对回调背后是 `taskGenRef` 代次比较 —— 防的是"被顶替的旧任务迟到的 finally
 * 把新任务的状态清掉"。同书的活儿现在不再互相顶替而是排队，各写各的台账条目，
 * 那层代次保护就没有存在的必要了。
 */
function taskHooks(ctx: AiTaskContext): TaskStatusHooks {
  return {
    onStart: () => undefined,
    onStatus: ctx.status,
    onError: (msg) => {
      // 用户主动取消（停止按钮触发 abort）不是错误：lib/error-handler 对 ABORTED
      // 有固定文案，此处跳过以免取消之后弹出红色错误条
      if (msg !== "操作已取消") failTask(ctx.novelId, msg);
    },
    onDone: () => undefined,
    onPush: () => { void syncClient.pushNow(); },
  };
}

export function useSummarizer() {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const novelId = currentNovel?.id ?? "";
  const getActiveProvider = useAPIStore((s) => s.getActiveProvider);
  const addSummary = useSummaryStore((s) => s.addSummary);

  // 运行态全部从任务台账派生：面板折叠、重挂、桌面与移动两份同时挂着，
  // 读到的都是同一份"这本书手上有什么活儿"
  const tasks = useAiTaskStore((s) => s.tasks);
  const myTask = taskForNovel(tasks, novelId);
  const isRunning = !!myTask;
  const currentTask = myTask ? myTask.message || myTask.name : "";
  const currentTaskType = myTask?.type ?? "";
  const progress = myTask?.progress ?? null;
  const isQueued = myTask?.status === "queued";
  const aheadCount = useAiTaskStore(
    (s) => (myTask ? s.tasks.filter((t) => t.novelId === novelId && t.queuedAt < myTask.queuedAt).length : 0)
  );
  const error = useAiTaskStore((s) => (novelId ? s.errorByNovel[novelId] ?? null : null));
  const ragEngineUsed = useAiTaskStore((s) => (novelId ? s.engineByNovel[novelId] ?? "" : ""));

  const checkProvider = useCallback(() => {
    const provider = getActiveProvider();
    if (!provider) { failTask(novelId, "请先在设置中配置 API"); return null; }
    return provider;
  }, [getActiveProvider, novelId]);

  const handleError = useCallback((err: unknown) => {
    failTask(novelId, formatAPIError(err));
  }, [novelId]);

  // Pre-retrieve relevant text using local RAG. Falls back to TF-IDF if embedding engine not ready.
  const getRelevantText = useCallback(
    async (ctx: AiTaskContext, query: string): Promise<string> => {
      const novel = currentNovel;
      if (!novel) { ragLog("getRelevantText: currentNovel 为空"); return ""; }
      const { signal, status } = ctx;
      if (signal.aborted) { ragLog("getRelevantText: 已取消"); return ""; }
      await new Promise((r) => setTimeout(r, 0));
      const prefEngine = useRAGStore.getState().engine;
      ragLog(`getRelevantText: prefEngine=${prefEngine}, novelId=${novel.id.slice(0, 8)}`);
      try {
        let engine = prefEngine;
        let degraded = false;

        // 优先从缓存加载 RAG 索引（内存 LRU + IndexedDB）
        // 索引自带 chunks 文本，不需要加载全书章节
        if (engine !== "tfidf") {
          try {
            await buildIndex(novel.id, novel.chapters, engine, undefined, { cacheOnly: true });
            ragLog(`索引从缓存加载成功 (${engine})`);
          } catch {
            ragLog(`索引未缓存 (${engine}), 降级为 TF-IDF`);
            engine = "tfidf";
            degraded = true;
          }
        }

        // TF-IDF 路径：先检查缓存，缓存未命中时才加载全书
        const chapters = novel.chapters;
        if (engine === "tfidf") {
          // 尝试从缓存加载 TF-IDF 索引
          try {
            await buildIndex(novel.id, chapters, "tfidf", undefined, { cacheOnly: true });
            ragLog(`TF-IDF 索引从缓存加载成功`);
          } catch {
            // TF-IDF 缓存未命中，流式构建（内部逐批加载章节，不预加载全书）
            ragLog("TF-IDF 缓存未命中，流式构建...");
            const degradedLabel = degraded ? " (降级至 TF-IDF)" : "";
            status(`正在构建 TF-IDF 索引${degradedLabel}...`);
            await buildIndex(novel.id, [], "tfidf",
              (msg) => status(msg + degradedLabel),
              undefined,
              novel.chapterCount  // 传入章节数，由 buildIndex 内部流式加载
            );
          }
        }

        if (signal.aborted) { ragLog("getRelevantText: 被取消"); return ""; }

        const degradedLabel = degraded ? " (降级至 TF-IDF)" : "";
        if (engine !== "tfidf") {
          status(`正在启动检索引擎 (${engine})${degradedLabel}...`);
        }
        if (signal.aborted) { ragLog("getRelevantText: 构建索引后被取消"); return ""; }
        status(`正在检索相关段落${degradedLabel}...`);
        const t0 = performance.now();
        const result = await retrieveRelevantWithDetails(novel.id, query, undefined, engine, { signal });
        ctx.usedEngine(result.engine);
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

  // RAG 预取算任务的一部分：状态文案直接写进这条任务自己的台账行。
  // 预取失败不阻塞任务（返回空串走 agent 内部的采样回退）。
  // 注意 `buildIndex` 本身不接 signal（模块级共享构建，任何一个人的取消只带走自己），
  // 所以这里靠 signal.aborted 的检查点退出，而不是指望它能被打断。
  const preRetrieve = useCallback(async (ctx: AiTaskContext, query: string): Promise<string> => {
    ctx.status("正在检索相关内容");
    try {
      return await getRelevantText(ctx, query);
    } catch (e) {
      console.warn("[useSummarizer] RAG 预取失败，回退空上下文:", e);
      return "";
    }
  }, [getRelevantText]);

  // novelId 由调用方显式传入（任务启动时锚定的 id），不读 currentNovel：
  // 任务运行中用户可能切换小说，读 store 会把旧书生成的总结写进新书的 novelId 下
  const saveChapterSummary = useCallback(
    async (novelId: string, chapterId: string, result: { success: boolean; data?: unknown; error?: string; tokensUsed?: number; metadata?: AnalysisMetadata }) => {
      if (!result.success || !result.data) return;
      const data = result.data as { summaries: { chapterTitle: string; content: string; tokens: number }[] };
      // agent 算出来的两个降级标记必须跟着落库：卡片上那行"本分析使用了精简模式"以前对
      // 章节总结是死代码，就是因为这里整个丢掉了 metadata（全书总结反而一直在传）。
      const { usedFallback, truncated } = result.metadata ?? {};
      for (const s of data.summaries) {
        // Reuse existing ID for same (novelId, chapterId, type) — server upserts by ID, can't signal deletes
        const existing = await getUserDB().summaries.where({ novelId, chapterId, type: "chapter" }).first();
        const summary: SummaryItem = {
          id: existing?.id || uuid(), novelId, chapterId,
          chapterTitle: s.chapterTitle, content: s.content,
          tokensUsed: s.tokens, createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now(), type: "chapter",
          usedFallback, truncated,
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

  /**
   * 发起一个 agent 任务：进那本书的队列，等到轮到自己再跑。
   * `makeContext` 允许是异步的 —— 需要 RAG 预取的 agent 在拿到槽位之后才去检索，
   * 排队期间不占带宽也不提前花钱。
   */
  const runAgent = useCallback((options: {
    taskName: string;
    taskType: TaskTypeValue;
    agent: Agent;
    makeContext: (ctx: AiTaskContext) => AgentContext | Promise<AgentContext>;
    errorMessage: string;
    onSuccess?: (result: AgentResult) => Promise<void>;
    returnData?: boolean;
  }): Promise<unknown> => {
    return runAiTask({ novelId, name: options.taskName, type: options.taskType }, async (ctx) =>
      runAgentTaskPure(taskHooks(ctx), {
        taskName: options.taskName,
        agent: options.agent,
        context: await options.makeContext(ctx),
        errorMessage: options.errorMessage,
        onSuccess: options.onSuccess,
        returnData: options.returnData,
      })
    );
  }, [novelId]);

  // --- Chapter summary ---
  const summarizeChapter = useCallback(async (chapterId: string) => {
    if (!novelId || !checkProvider()) return;
    await runAgent({
      taskName: "总结本章",
      taskType: TaskType.CHAPTER,
      agent: summarizerAgent,
      makeContext: (ctx) => ({ novelId, chapterIds: [chapterId], signal: ctx.signal, onStatus: ctx.status }),
      errorMessage: "总结生成失败",
      onSuccess: (result) => saveChapterSummary(novelId, chapterId, result),
    });
  }, [novelId, checkProvider, runAgent, saveChapterSummary]);

  const regenerateChapter = useCallback(async (chapterId: string) => {
    if (!novelId || !checkProvider()) return;
    await runAgent({
      taskName: "重新生成总结",
      taskType: TaskType.CHAPTER,
      agent: summarizerAgent,
      makeContext: (ctx) => ({ novelId, chapterIds: [chapterId], signal: ctx.signal, onStatus: ctx.status }),
      errorMessage: "重新生成失败",
      onSuccess: (result) => saveChapterSummary(novelId, chapterId, result),
    });
  }, [novelId, checkProvider, runAgent, saveChapterSummary]);

  // --- 批量总结：整批是同书的一条任务，逐章推进写在它自己的台账行上 ---
  const summarizeAllChapters = useCallback(async (options?: { skipExisting?: boolean }) => {
    const novel = currentNovel;
    if (!novel || !checkProvider()) return;
    const { skipExisting = true } = options || {};

    await runAiTask({ novelId, name: "批量总结所有章节", type: TaskType.CHAPTER }, async (ctx) => {
      const { signal, status, progress: report } = ctx;
      const chapters = novel.chapters;

      // 获取已有的章节总结
      const existingSummaries = await getUserDB().summaries
        .where({ novelId: novel.id, type: "chapter" })
        .toArray();
      const existingChapterIds = new Set(existingSummaries.map((s) => s.chapterId));

      const chaptersToSummarize = skipExisting
        ? chapters.filter((ch) => !existingChapterIds.has(ch.id))
        : chapters;

      if (chaptersToSummarize.length === 0) {
        status("所有章节已有总结");
        return;
      }

      report({ current: 0, total: chaptersToSummarize.length });
      try {
        // 一次性预加载全书内容，循环内逐章复用：
        // 原实现每章 agent.run 都会触发一次全书 IndexedDB 加载（N 章 = N 次全量 IO）
        status("正在加载小说数据...");
        const fullNovel = await loadNovel(novel.id, undefined, true);
        if (!fullNovel) throw new Error("小说数据未找到");

        let failedCount = 0;
        for (let i = 0; i < chaptersToSummarize.length; i++) {
          if (signal.aborted) break;
          status(`正在总结第 ${i + 1}/${chaptersToSummarize.length} 章...`);
          const result = await summarizerAgent.run({
            novelId: novel.id, chapterIds: [chaptersToSummarize[i].id],
            signal, onStatus: status, preloadedNovel: fullNovel,
          });
          if (signal.aborted) break;
          if (result.success) {
            status("正在保存结果...");
            await saveChapterSummary(novel.id, chaptersToSummarize[i].id, result);
          } else {
            failedCount++;
          }
          report({ current: i + 1, total: chaptersToSummarize.length });
        }
        if (failedCount > 0) failTask(novel.id, `批量总结完成，${failedCount} 章失败`);
      } catch (err) {
        // 取消不是失败：不写错误条
        if (!signal.aborted) handleError(err);
      } finally {
        void syncClient.pushNow();
      }
    });
  }, [novelId, currentNovel, checkProvider, saveChapterSummary, handleError]);

  // --- Global summary ---
  const GLOBAL_QUERY = "小说的核心主线、主题思想、故事梗概，关键情节的发展脉络";

  const generateGlobalSummary = useCallback(async () => {
    if (!novelId || !checkProvider()) return;
    await runAgent({
      taskName: "生成全书总览",
      taskType: TaskType.GLOBAL,
      agent: globalSummarizerAgent,
      makeContext: async (ctx) => ({ novelId, signal: ctx.signal, onStatus: ctx.status, preRetrieved: await preRetrieve(ctx, GLOBAL_QUERY) }),
      errorMessage: "全局总结生成失败",
      onSuccess: (result) => saveGlobalSummary(novelId, result, "global", "全书总结", "__global__"),
    });
  }, [novelId, checkProvider, runAgent, saveGlobalSummary, preRetrieve]);

  const regenerateGlobal = useCallback(async () => {
    if (!novelId || !checkProvider()) return;
    await runAgent({
      taskName: "重新生成全书总览",
      taskType: TaskType.GLOBAL,
      agent: globalSummarizerAgent,
      makeContext: async (ctx) => ({ novelId, signal: ctx.signal, onStatus: ctx.status, preRetrieved: await preRetrieve(ctx, GLOBAL_QUERY) }),
      errorMessage: "重新生成失败",
      onSuccess: (result) => saveGlobalSummary(novelId, result, "global", "全书总结", "__global__"),
    });
  }, [novelId, checkProvider, runAgent, saveGlobalSummary, preRetrieve]);

  // --- Character analysis ---
  const CHARACTER_QUERY = "小说中各主要角色的关系网络、互动、性格特征与情感变化";

  const generateCharacterAnalysis = useCallback(async () => {
    if (!novelId || !checkProvider()) return;
    await runAgent({
      taskName: "生成人物关系分析",
      taskType: TaskType.CHARACTER,
      agent: characterAnalysisAgent,
      makeContext: async (ctx) => ({ novelId, signal: ctx.signal, onStatus: ctx.status, preRetrieved: await preRetrieve(ctx, CHARACTER_QUERY) }),
      errorMessage: "人物分析失败",
      onSuccess: (result) => saveGlobalSummary(novelId, result, "characters", "人物关系分析", "__characters__"),
    });
  }, [novelId, checkProvider, runAgent, saveGlobalSummary, preRetrieve]);

  const regenerateCharacters = useCallback(async () => {
    if (!novelId || !checkProvider()) return;
    await runAgent({
      taskName: "重新生成人物关系分析",
      taskType: TaskType.CHARACTER,
      agent: characterAnalysisAgent,
      makeContext: async (ctx) => ({ novelId, signal: ctx.signal, onStatus: ctx.status, preRetrieved: await preRetrieve(ctx, CHARACTER_QUERY) }),
      errorMessage: "重新生成失败",
      onSuccess: (result) => saveGlobalSummary(novelId, result, "characters", "人物关系分析", "__characters__"),
    });
  }, [novelId, checkProvider, runAgent, saveGlobalSummary, preRetrieve]);

  // --- Character graph only (no text analysis) ---
  const runGraphTask = useCallback(async (taskName: string): Promise<GraphData | null> => {
    if (!novelId || !checkProvider()) return null;
    const result = await runAgent({
      taskName,
      taskType: TaskType.GRAPH,
      agent: characterGraphAgent,
      makeContext: async (ctx) => ({ novelId, signal: ctx.signal, onStatus: ctx.status, preRetrieved: await preRetrieve(ctx, CHARACTER_QUERY) }),
      errorMessage: "图谱生成失败",
      returnData: true,
    }) as { graphData: GraphData } | null;
    if (result && !result.graphData) {
      failTask(novelId, "图谱生成成功但数据解析失败，请重试");
      return null;
    }
    const graphData = result?.graphData || null;
    // 落库在任务里做：发起它的那只面板可能已经折叠了，等不到 `onSuccess` 那一步
    if (graphData) await saveGraph(novelId, graphData);
    return graphData;
  }, [novelId, checkProvider, runAgent, preRetrieve]);

  const generateCharacterGraph = useCallback(() => runGraphTask("生成人物关系图谱"), [runGraphTask]);
  const regenerateCharacterGraph = useCallback(() => runGraphTask("重新生成人物关系图谱"), [runGraphTask]);

  // --- Timeline ---
  const TIMELINE_QUERY = "小说剧情的时间线、关键事件、转折点、伏笔与高潮结局";

  const generateTimeline = useCallback(async () => {
    if (!novelId || !checkProvider()) return;
    await runAgent({
      taskName: "生成剧情时间线",
      taskType: TaskType.TIMELINE,
      agent: timelineAgent,
      makeContext: async (ctx) => ({ novelId, signal: ctx.signal, onStatus: ctx.status, preRetrieved: await preRetrieve(ctx, TIMELINE_QUERY) }),
      errorMessage: "时间线生成失败",
      onSuccess: (result) => saveGlobalSummary(novelId, result, "timeline", "剧情时间线", "__timeline__"),
    });
  }, [novelId, checkProvider, runAgent, saveGlobalSummary, preRetrieve]);

  const regenerateTimeline = useCallback(async () => {
    if (!novelId || !checkProvider()) return;
    await runAgent({
      taskName: "重新生成剧情时间线",
      taskType: TaskType.TIMELINE,
      agent: timelineAgent,
      makeContext: async (ctx) => ({ novelId, signal: ctx.signal, onStatus: ctx.status, preRetrieved: await preRetrieve(ctx, TIMELINE_QUERY) }),
      errorMessage: "重新生成失败",
      onSuccess: (result) => saveGlobalSummary(novelId, result, "timeline", "剧情时间线", "__timeline__"),
    });
  }, [novelId, checkProvider, runAgent, saveGlobalSummary, preRetrieve]);

  // --- Map generation ---
  const runMapTask = useCallback(async (taskName: string, presetNovelId: string): Promise<MapData | null> => {
    const result = await runAgent({
      taskName,
      taskType: TaskType.MAP,
      agent: mapAgent,
      makeContext: (ctx) => ({ novelId: presetNovelId, signal: ctx.signal, onStatus: ctx.status }),
      errorMessage: "地图生成失败",
      returnData: true,
    });
    if (result && typeof result === "object" && "mapData" in result) {
      const mapData = (result as { mapData: MapData }).mapData;
      // 落库在任务里做，不等发起的组件还在不在场
      await saveMap(presetNovelId, mapData);
      return mapData;
    }
    return null;
  }, [runAgent]);

  const generateMap = useCallback(async (): Promise<MapData | null> => {
    if (!novelId || !checkProvider()) return null;
    return await runMapTask("生成小说地图", novelId);
  }, [novelId, checkProvider, runMapTask]);

  const regenerateMap = useCallback(async (): Promise<MapData | null> => {
    if (!novelId || !checkProvider()) return null;
    // 删旧图与重新生成算同一条任务：分成两条的话，中间插进别的任务会让
    // "已删除但还没生成"这本书停在一个空档上
    await deleteMap(novelId);
    return await runMapTask("重新生成小说地图", novelId);
  }, [novelId, checkProvider, runMapTask]);

  // --- Temporary: range summary (in-memory, not saved to DB) ---
  const generateRangeSummary = useCallback(
    async (fromChapter: number, toChapter: number): Promise<TempResult | null> => {
      const novel = currentNovel;
      if (!novel || !checkProvider()) return null;
      const provider = getActiveProvider()!;

      return await runAiTask<TempResult | null>(
        { novelId, name: `第${fromChapter}-${toChapter}章 范围总结`, type: TaskType.RANGE },
        async (ctx) => {
          const { signal, status } = ctx;
          try {
            // 从 IndexedDB 直接读取指定范围的章节
            status(`正在加载第${fromChapter}-${toChapter}章...`);
            const startIndex = fromChapter - 1;
            const count = toChapter - fromChapter + 1;
            const rangeChapters = await loadChapters(novel.id, startIndex, count);
            // 输出预算只算一次：它既是发出去的 max_tokens，也是输入侧要扣掉的量，
            // 分两处算就会一个 2048 一个 4096（`map-agent.ts` 注释里警告的那次 400）。
            const RANGE_OUTPUT_TOKENS = 2048;
            const budget = getTokenBudget(provider.model, provider.contextWindow, provider.maxTokens);
            const rangeReserve = resolveOutputReserve(budget, RANGE_OUTPUT_TOKENS, "范围总结");
            // 可用输入 = 上下文 - 输出预留 - 安全余量
            const maxTokens = requireUsableInput(budget, rangeReserve, "范围总结");
            const maxChars = Math.floor(maxTokens); // 中文约 1 字 = 1 token
            let combinedText = "";
            let totalChars = 0;
            const sentTitles: string[] = [];
            let tailCut = false;
            const wantedChapters = rangeChapters.filter((ch) => ch.content);
            for (const ch of wantedChapters) {
              const remaining = maxChars - totalChars;
              if (remaining <= 0) break;
              const text = ch.content.length > remaining ? ch.content.slice(0, remaining) : ch.content;
              tailCut = text.length < ch.content.length;
              combinedText += `\n\n--- ${ch.title} ---\n${text}`;
              totalChars += text.length;
              sentTitles.push(ch.title);
            }
            // 起止章只能取**真正送出去**的那两章。过去取自 `rangeChapters` 的首尾——那是
            // 丢弃循环之前的切片，于是"请求 2-10 章、实际只送了 2-4 章"时，prompt 会告诉
            // 模型它看到了第 10 章的原文，模型就照着不存在的内容往下总结。
            const actualFrom = sentTitles[0] || rangeChapters[0]?.title || `第${fromChapter}章`;
            const actualTo = sentTitles[sentTitles.length - 1] || `第${toChapter}章`;
            const omittedChapters = wantedChapters.length - sentTitles.length;
            ragLog(`范围总结: 送入 ${sentTitles.length}/${wantedChapters.length} 章, combinedText=${totalChars}字`);

            const prompt = `你是一位专业的小说分析助手。请对以下小说章节范围进行总结分析。

章节范围：${actualFrom} 到 ${actualTo}（请求第 ${fromChapter}-${toChapter} 章共 ${wantedChapters.length} 章，实际提供原文 ${sentTitles.length} 章）

要求：
1. **核心情节**（概括该段落的整体剧情走向）
2. **关键事件**（列出最重要的5-8个事件）
3. **人物变化**（主要角色在该段落中的发展变化）
4. **承上启下**（该段落在全书中的位置和作用）

请用简洁清晰的中文回答。

以下是该范围内的章节原文${tailCut ? "（末章按上下文预算截断）" : ""}：

${combinedText}${omittedChapters > 0 ? `\n\n注意：请求范围内的后 ${omittedChapters} 章原文没有提供。只对上面实际给出的内容下结论，未给出的部分请写"该段原文未提供"，不要凭章节标题推断情节。` : ""}`;

            status("正在等待 AI 回答...");
            const providerInstance = getProvider(provider);
            const response = await providerInstance.chat({
              model: "", messages: [{ role: "user", content: prompt }],
              max_tokens: rangeReserve,
              signal,
            });

            // 防御：即使 API 返回 200，空内容也视为失败，避免保存空白总结
            if (!response.content || !response.content.trim()) {
              failTask(novel.id, new APIError("API 返回了空内容", "server").message);
              return null;
            }

            return {
              id: uuid(),
              title: `第${fromChapter}-${toChapter}章 范围总结`,
              content: response.content,
              tokensUsed: response.content.length,
              createdAt: Date.now(),
              // 少送了多少必须留痕：卡片标题写的是用户请求的范围，这行说的是实际送出去的
              metadata: {
                truncated: tailCut,
                originalLength: wantedChapters.reduce((s, ch) => s + ch.content.length, 0),
                analyzedLength: totalChars,
                omittedChapters: omittedChapters > 0 ? omittedChapters : undefined,
              },
            };
          } catch (err) {
            // 用户主动取消不是错误：不写错误条，静默返回
            if (signal.aborted) return null;
            handleError(err);
            return null;
          }
        }
      );
    },
    [novelId, currentNovel, checkProvider, getActiveProvider, handleError]
  );

  // --- Temporary: custom question with conversation history ---
  const askCustomQuestion = useCallback(
    async (
      question: string,
      history: { role: "user" | "assistant"; content: string }[]
    ): Promise<{ answer: string; tokensUsed: number; droppedTurns: number } | null> => {
      const novel = currentNovel;
      if (!novel || !checkProvider()) return null;
      const provider = getActiveProvider();
      if (!provider) return null;

      // 上下文按预算装配（round 2 R-35）：此前系统提示里塞的是**全量**章节目录
      // + 最多 80 个 RAG 片段（约 45k token）+ 全量对话历史，且不经过
      // chatWithContextRetry → 长书 + 多轮追问必然 400，且不会自愈。
      const QA_OUTPUT_TOKENS = 2048;
      const budget = getTokenBudget(provider.model, provider.contextWindow, provider.maxTokens);
      // 预留与请求值同一个数；两件事都发生在入队之前（round 3 R-73）：`resolveOutputReserve`
      // 与 `requireUsableInput` 都可能抛，一次"上下文窗口不足"若落在任务已经记账之后，
      // 那本书的槽位就会被它占住。
      let available: number;
      let qaReserve: number;
      try {
        qaReserve = resolveOutputReserve(budget, QA_OUTPUT_TOKENS, "问答");
        available = requireUsableInput(budget, qaReserve, "问答");
      } catch (err) {
        handleError(err);
        return null;
      }

      return await runAiTask<{ answer: string; tokensUsed: number; droppedTurns: number } | null>(
        { novelId, name: "问答", type: TaskType.QA },
        async (ctx) => {
          const { signal, status } = ctx;
          const allTitles = novel.chapters.map((c, i) => `${i + 1}. ${c.title}`);

          // Use cached RAG context for follow-up questions, refresh if topic changes
          let relevantText: string;
          const QA_CACHE_MAX_FOLLOWUPS = 3;
          const cached = qaRagCache.get(novel.id);
          const isSameTopic = cached && keywordOverlap(cached.question, question) > 0.5;
          if (cached && cached.followUps < QA_CACHE_MAX_FOLLOWUPS && isSameTopic) {
            relevantText = cached.text;
            cached.followUps++;
          } else {
            relevantText = await getRelevantText(ctx, question);
            qaRagCache.set(novel.id, { question, text: relevantText, followUps: 0 });
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
          // 裁了就要说出来：对模型说，是为了让它别把没送上的早先内容猜着往下编；
          // 对用户说（随返回值上屏），是因为"答非所问"在这条链上本来是无声的。
          const historyNote = droppedTurns > 0
            ? `\n\n注意：更早的 ${droppedTurns} 条对话因上下文预算限制没有附上，涉及它们的追问请直接说明信息不足，不要凭猜测接续。`
            : "";

          const chapterSample = sampleChapterTitles(allTitles, Math.floor(available * 0.2));

          const systemSkeleton = `你是一位专业的小说分析助手。请根据以下小说信息回答用户问题。请用中文回答。

**小说：**《${novel.title}》
**章节目录：**
${chapterSample.text}

**语义检索相关段落：**
`;
          const tailNote = chapterSample.sampled
            ? "\n\n注意：章节目录过长，上面只给了抽样部分。若抽样不足以回答，请明确说明需要查阅哪些章节，不要凭目录猜测剧情。"
            : "";
          const fixedCost = estimateTokens(systemSkeleton) + estimateTokens(tailNote) + estimateTokens(historyNote) + estimateTokens(question);
          const ragCap = Math.max(200, available - historyTokens - fixedCost);
          let relevantBody = relevantText || "（无额外参考信息，请基于章节目录回答）";
          if (estimateTokens(relevantBody) > ragCap) {
            // 按字符近似截断（中文约 1 字 = 1 token）
            relevantBody = relevantBody.slice(0, Math.max(0, ragCap)) + "\n……（检索结果因长度限制被截断）";
          }

          const systemPrompt = `${systemSkeleton}${relevantBody}${tailNote}${historyNote}`;

          // Build messages: system context + conversation history + new question
          const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
            { role: "system", content: systemPrompt },
          ];
          for (const msg of keptHistory) {
            messages.push(msg);
          }
          messages.push({ role: "user", content: question });

          try {
            status("正在等待 AI 回答...");
            const providerInstance = getProvider(provider);
            const response = await providerInstance.chat({
              model: "",
              messages,
              // 与上面 `requireUsableInput(budget, qaReserve, "问答")` 的输出预留同一个值，
              // 否则预算算小了而请求要得多，严格校验 input+max_tokens≤窗口的服务商必 400
              max_tokens: qaReserve,
              temperature: 0.5,
              signal,
            });

            // 防御：即使 API 返回 200，空内容也视为失败，避免显示空白回答
            if (!response.content || !response.content.trim()) {
              failTask(novel.id, new APIError("API 返回了空内容", "server").message);
              return null;
            }

            return { answer: response.content, tokensUsed: response.content.length, droppedTurns };
          } catch (err) {
            // 用户主动取消（停止按钮触发 abort）：向上抛出让调用方静默处理，
            // 否则 useQA 会把它当成失败显示"问答失败，请重试"
            if (signal.aborted) throw err;
            handleError(err);
            return null;
          }
        }
      );
    },
    [novelId, currentNovel, checkProvider, getActiveProvider, getRelevantText, handleError]
  );

  const clearQaCache = useCallback(() => { qaRagCache.delete(novelId); }, [novelId]);
  const clearError = useCallback(() => { useAiTaskStore.getState().clearNovelError(novelId); }, [novelId]);
  /** 「停止」：取消这本书的在飞任务，并让它后面排着的活儿不再开始 */
  const stopTasks = useCallback(() => { cancelNovelTasks(novelId); }, [novelId]);

  return useMemo(() => ({
    isRunning, currentTask, currentTaskType, error, progress, isQueued, aheadCount,
    summarizeChapter, summarizeAllChapters, regenerateChapter,
    generateGlobalSummary, regenerateGlobal,
    generateCharacterAnalysis, regenerateCharacters,
    generateCharacterGraph, regenerateCharacterGraph,
    generateTimeline, regenerateTimeline,
    generateMap, regenerateMap,
    generateRangeSummary, askCustomQuestion,
    clearQaCache,
    clearError,
    stopTasks,
    ragEngineUsed,
  }), [
    isRunning, currentTask, currentTaskType, error, progress, isQueued, aheadCount,
    summarizeChapter, summarizeAllChapters, regenerateChapter,
    generateGlobalSummary, regenerateGlobal,
    generateCharacterAnalysis, regenerateCharacters,
    generateCharacterGraph, regenerateCharacterGraph,
    generateTimeline, regenerateTimeline,
    generateMap, regenerateMap,
    generateRangeSummary, askCustomQuestion,
    clearQaCache, clearError, stopTasks, ragEngineUsed,
  ]);
}
