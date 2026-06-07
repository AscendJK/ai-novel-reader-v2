/**
 * useQA hook - 问答逻辑
 * 按小说 ID 缓存 QA 对话和范围总结，返回书架不丢失
 * 核心思路：用 Zustand store 按 novelId 存储数据，每次修改同步写入 store
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { create } from "zustand";
import { useSummarizer } from "@/hooks/useSummarizer";

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

export function useQA(novelId: string): UseQAReturn {
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

  const {
    askCustomQuestion,
    generateRangeSummary,
    clearQaCache,
  } = useSummarizer();

  const addMessage = useCallback((role: "user" | "assistant", content: string, tokensUsed?: number) => {
    const message: QAMessage = { id: crypto.randomUUID(), role, content, tokensUsed };
    setQaMessages((prev) => [message, ...prev]);
  }, [setQaMessages]);

  const handleSubmitQuestion = useCallback(async () => {
    if (!customQuestion.trim() || qaLoading) return;
    const question = customQuestion.trim();
    setCustomQuestion("");
    setQaLoading(true);
    setQaError(null);
    addMessage("user", question);
    try {
      // 消息存储为最新在前，API 需要时间顺序，所以反转
      const currentHistory = qaMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })).reverse();
      const fullHistory = [...currentHistory, { role: "user" as const, content: question }];
      const result = await askCustomQuestion(question, fullHistory);
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
  }, [customQuestion, qaLoading, qaMessages, askCustomQuestion, addMessage]);

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
