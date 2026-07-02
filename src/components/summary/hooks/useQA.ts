/**
 * useQA hook - 问答逻辑
 * 按小说 ID 缓存 QA 对话和范围总结，返回书架不丢失
 * 核心思路：用 Zustand store 按 novelId 存储数据，每次修改同步写入 store
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { create } from "zustand";

interface QAMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  tokensUsed?: number;
}

interface RangeResult {
  id: string;
  title: string;
  content: string;
  tokensUsed: number;
  createdAt: number;
}

interface QAData {
  qaMessages: QAMessage[];
  rangeResults: RangeResult[];
}

// ── Zustand store：按 novelId 分离的 QA 数据 ──

interface QADataStore {
  data: Record<string, QAData>;
  save: (novelId: string, patch: Partial<QAData>) => void;
  getData: (novelId: string) => QAData;
  clear: (novelId: string) => void;
}

const useQADataStore = create<QADataStore>((set, get) => ({
  data: {},

  save: (novelId, patch) =>
    set((s) => {
      const prev = s.data[novelId] || { qaMessages: [], rangeResults: [] };
      return { data: { ...s.data, [novelId]: { ...prev, ...patch } } };
    }),

  getData: (novelId) => get().data[novelId] || { qaMessages: [], rangeResults: [] },

  clear: (novelId) =>
    set((s) => {
      const { [novelId]: _, ...rest } = s.data;
      return { data: rest };
    }),
}));

// ── Hook ──

interface UseQAReturn {
  qaMessages: QAMessage[];
  setQaMessages: React.Dispatch<React.SetStateAction<QAMessage[]>>;
  customQuestion: string;
  setCustomQuestion: React.Dispatch<React.SetStateAction<string>>;
  rangeFrom: string;
  setRangeFrom: React.Dispatch<React.SetStateAction<string>>;
  rangeTo: string;
  setRangeTo: React.Dispatch<React.SetStateAction<string>>;
  rangeResults: RangeResult[];
  setRangeResults: React.Dispatch<React.SetStateAction<RangeResult[]>>;
  qaLoading: boolean;
  qaError: string | null;
  setQaError: React.Dispatch<React.SetStateAction<string | null>>;
  handleSubmitQuestion: () => Promise<void>;
  handleRangeSummary: () => Promise<void>;
  handleClearQaCache: () => void;
  addMessage: (role: "user" | "assistant", content: string, tokensUsed?: number) => void;
}

interface UseQAOptions {
  novelId: string;
  askCustomQuestion: (question: string, history: { role: "user" | "assistant"; content: string }[]) => Promise<{ answer: string; tokensUsed: number } | null>;
  generateRangeSummary: (from: number, to: number) => Promise<{ id: string; title: string; content: string; tokensUsed: number; createdAt: number } | null>;
  clearQaCache: () => void;
}

export function useQA({ novelId, askCustomQuestion, generateRangeSummary, clearQaCache }: UseQAOptions): UseQAReturn {
  const store = useQADataStore();

  // 当 novelId 变化时，从 store 恢复数据
  const prevNovelIdRef = useRef(novelId);
  const initialData = store.getData(novelId);

  const [qaMessages, _setQaMessages] = useState<QAMessage[]>(initialData.qaMessages);
  const [rangeResults, _setRangeResults] = useState<RangeResult[]>(initialData.rangeResults);
  const [customQuestion, setCustomQuestion] = useState("");
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [qaLoading, setQaLoading] = useState(false);
  const [qaError, setQaError] = useState<string | null>(null);

  // 切换小说时恢复数据
  useEffect(() => {
    if (!novelId) return;
    const prevId = prevNovelIdRef.current;
    if (prevId && prevId !== novelId) {
      // 新小说的数据从 store 获取（每次 addMessage/setQaMessages 都会同步到 store）
      const restored = store.getData(novelId);
      _setQaMessages(restored.qaMessages);
      _setRangeResults(restored.rangeResults);
      setCustomQuestion("");
      setRangeFrom("");
      setRangeTo("");
      setQaError(null);
    }
    prevNovelIdRef.current = novelId;
  }, [novelId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 包装 setState：每次更新同时写入 store
  const setQaMessages: typeof _setQaMessages = useCallback((value) => {
    _setQaMessages((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      if (novelId) store.save(novelId, { qaMessages: next });
      return next;
    });
  }, [novelId]);

  const setRangeResults: typeof _setRangeResults = useCallback((value) => {
    _setRangeResults((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      if (novelId) store.save(novelId, { rangeResults: next });
      return next;
    });
  }, [novelId]);

  const addMessage = useCallback((role: "user" | "assistant", content: string, tokensUsed?: number) => {
    const message: QAMessage = { id: crypto.randomUUID(), role, content, tokensUsed };
    setQaMessages((prev) => [message, ...prev]);
  }, [setQaMessages]);

  // 用 ref 追踪最新消息列表，避免 handleSubmitQuestion 中的闭包捕获旧值
  const qaMessagesRef = useRef(qaMessages);
  qaMessagesRef.current = qaMessages;

  const handleSubmitQuestion = useCallback(async () => {
    if (!customQuestion.trim() || qaLoading) return;
    const question = customQuestion.trim();
    setCustomQuestion("");
    setQaLoading(true);
    setQaError(null);
    addMessage("user", question);
    try {
      // 用 ref 获取包含刚添加的用户消息的最新列表
      const currentHistory = qaMessagesRef.current.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })).reverse();
      const result = await askCustomQuestion(question, currentHistory);
      if (result) {
        addMessage("assistant", result.answer, result.tokensUsed);
      } else {
        setQaError("问答失败，请重试");
      }
    } catch (err) {
      setQaError(err instanceof Error ? err.message : "问答失败");
    } finally {
      setQaLoading(false);
    }
  }, [customQuestion, qaLoading, askCustomQuestion, addMessage]);

  const handleRangeSummary = useCallback(async () => {
    const from = parseInt(rangeFrom, 10);
    const to = parseInt(rangeTo, 10);
    if (isNaN(from) || isNaN(to) || from < 1 || to < from) {
      setQaError("请输入有效的章节范围");
      return;
    }
    if (to - from + 1 > 20) {
      setQaError("范围不能超过 20 章");
      return;
    }
    setQaLoading(true);
    setQaError(null);
    try {
      const result = await generateRangeSummary(from, to);
      if (result) {
        setRangeResults((prev) => [result, ...prev]);
        setRangeFrom("");
        setRangeTo("");
      }
    } catch (err) {
      setQaError(err instanceof Error ? err.message : "范围总结失败");
    } finally {
      setQaLoading(false);
    }
  }, [rangeFrom, rangeTo, generateRangeSummary, setRangeResults]);

  const handleClearQaCache = useCallback(() => {
    clearQaCache();
    _setQaMessages([]);
    _setRangeResults([]);
    setQaError(null);
    if (novelId) store.clear(novelId);
  }, [clearQaCache, novelId]);

  return {
    qaMessages,
    setQaMessages,
    customQuestion,
    setCustomQuestion,
    rangeFrom,
    setRangeFrom,
    rangeTo,
    setRangeTo,
    rangeResults,
    setRangeResults,
    qaLoading,
    qaError,
    setQaError,
    handleSubmitQuestion,
    handleRangeSummary,
    handleClearQaCache,
    addMessage,
  };
}
