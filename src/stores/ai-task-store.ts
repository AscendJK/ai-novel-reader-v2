import { create } from "zustand";

/**
 * AI 任务台账（同书串行、异书并行的调度真相）
 *
 * 为什么要有这只 store：AI 任务的生命周期原先整个住在 `useSummarizer` 的 React 实例里
 * （AbortController、代次计数、isRunning/currentTask/error 的 useState），而
 * `SummaryPanel` 在桌面端是条件渲染的——折叠面板即卸载组件，卸载即 abort，
 * 于是那枚折叠按钮实际是六个 agent 的总闸（2026-09-22 实测：全部会被打断）。
 * 要"任务不随面板卸载而死"，运行态就得搬到一个谁都能读、且不随挂载生死的地方。
 *
 * 这里只放状态，不放调度逻辑（调度在 `src/lib/ai-task-queue.ts`）。形状照
 * `build-store.ts` 的先例：按书算键、界面订阅、发起方卸载不影响记账。
 */

export interface AiTaskView {
  id: string;
  novelId: string;
  /** 展示名，如「总结本章」 */
  name: string;
  /** `TaskType` 值，界面用它判断"哪一功能在转圈" */
  type: string;
  /** queued=在同书队列里排队；running=正在执行 */
  status: "queued" | "running";
  /** 当前状态文案（agent 推进度时写这里）；排队时是"排队中：等〈X〉完成" */
  message: string;
  progress: { current: number; total: number } | null;
  /** 进入队列的时刻（毫秒）。排队展示与将来的超时判据都用它 */
  queuedAt: number;
  /** 真正开始执行的时刻，仍在排队时为 0 */
  startedAt: number;
}

interface AiTaskState {
  /** 有序数组：同一本书内下标即排队顺序 */
  tasks: AiTaskView[];
  /** 每本书最近一次失败/取消的文案（面板错误条读这里） */
  errorByNovel: Record<string, string>;
  /** 每本书最近一次检索实际用的引擎（面板那行「检索引擎:」读这里） */
  engineByNovel: Record<string, string>;
  addTask: (task: AiTaskView) => void;
  patchTask: (id: string, patch: Partial<Pick<AiTaskView, "status" | "message" | "progress" | "startedAt">>) => void;
  removeTask: (id: string) => void;
  setNovelError: (novelId: string, message: string) => void;
  clearNovelError: (novelId: string) => void;
  setNovelEngine: (novelId: string, engine: string) => void;
  /** 身份切换（退出登录/换用户）时整本台账作废 */
  resetAll: () => void;
}

export const useAiTaskStore = create<AiTaskState>((set) => ({
  tasks: [],
  errorByNovel: {},
  engineByNovel: {},

  addTask: (task) => set((s) => ({ tasks: [...s.tasks, task] })),

  patchTask: (id, patch) =>
    set((s) => {
      const at = s.tasks.findIndex((t) => t.id === id);
      // 任务已经收尾（或被取消）之后，它那些迟到的进度回调必须整体作废，
      // 否则会把已经空掉的队列又填回一条永远转圈的记录
      if (at < 0) return {};
      const next = s.tasks.slice();
      next[at] = { ...next[at], ...patch };
      return { tasks: next };
    }),

  removeTask: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),

  setNovelError: (novelId, message) =>
    set((s) => ({ errorByNovel: { ...s.errorByNovel, [novelId]: message } })),

  clearNovelError: (novelId) =>
    set((s) => {
      if (!(novelId in s.errorByNovel)) return {};
      const rest = { ...s.errorByNovel };
      delete rest[novelId];
      return { errorByNovel: rest };
    }),

  setNovelEngine: (novelId, engine) =>
    set((s) => ({ engineByNovel: { ...s.engineByNovel, [novelId]: engine } })),

  resetAll: () => set({ tasks: [], errorByNovel: {}, engineByNovel: {} }),
}));

/** 这本书当前的活儿：running 优先，其次排队中的第一条 */
export function taskForNovel(tasks: AiTaskView[], novelId: string): AiTaskView | null {
  return tasks.find((t) => t.novelId === novelId) ?? null;
}

/** 全局"有没有 AI 活儿"——同步链的门控读这里 */
export function hasAiWork(tasks: AiTaskView[]): boolean {
  return tasks.length > 0;
}
