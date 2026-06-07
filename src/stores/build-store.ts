import { create } from "zustand";

/** 构建状态类型 */
export type BuildStatusType = "idle" | "queued" | "loading" | "building" | "encoding" | "ready" | "done" | "error";

/** 单本书的构建状态 */
export interface NovelBuildStatus {
  novelId: string;
  engine: string;
  status: BuildStatusType;
  message: string;
  current: number;
  total: number;
  error?: string;
  queuePosition?: number;
  open: boolean;  // 是否显示状态窗口
  startTime: number;
}

/** 构建状态 Store */
interface BuildState {
  /** 所有书的构建状态 Map，key = `${novelId}-${engine}` */
  builds: Map<string, NovelBuildStatus>;

  /** 开始构建 */
  startBuild: (novelId: string, engine: string) => void;

  /** 更新进度 */
  updateProgress: (novelId: string, engine: string, progress: Partial<NovelBuildStatus>) => void;

  /** 构建完成 */
  finishBuild: (novelId: string, engine: string) => void;

  /** 构建失败 */
  failBuild: (novelId: string, engine: string, error: string) => void;

  /** 切换窗口显示 */
  toggleWindow: (novelId: string, engine: string) => void;

  /** 关闭窗口 */
  dismissWindow: (novelId: string, engine: string) => void;

  /** 获取指定书的构建状态 */
  getBuildStatus: (novelId: string, engine: string) => NovelBuildStatus | undefined;

  /** 检查是否有构建正在进行 */
  isBuilding: (novelId: string, engine: string) => boolean;

  /** 清除完成/错误的状态（自动清理） */
  cleanupCompleted: () => void;
}

/** 生成构建 key */
function buildKey(novelId: string, engine: string): string {
  return `${novelId}-${engine}`;
}

export const useBuildStore = create<BuildState>((set, get) => ({
  builds: new Map(),

  startBuild: (novelId, engine) => {
    const key = buildKey(novelId, engine);
    set((state) => {
      const newBuilds = new Map(state.builds);
      newBuilds.set(key, {
        novelId,
        engine,
        status: "building",
        message: "正在准备...",
        current: 0,
        total: 0,
        open: true,
        startTime: Date.now(),
      });
      return { builds: newBuilds };
    });
  },

  updateProgress: (novelId, engine, progress) => {
    const key = buildKey(novelId, engine);
    set((state) => {
      const newBuilds = new Map(state.builds);
      const existing = newBuilds.get(key);
      if (existing) {
        // 避免不必要的更新
        if (
          existing.status === progress.status &&
          existing.message === progress.message &&
          existing.current === progress.current &&
          existing.total === progress.total &&
          existing.queuePosition === progress.queuePosition
        ) {
          return state; // 无变化，不触发更新
        }
        newBuilds.set(key, { ...existing, ...progress });
      }
      return { builds: newBuilds };
    });
  },

  finishBuild: (novelId, engine) => {
    const key = buildKey(novelId, engine);
    set((state) => {
      const newBuilds = new Map(state.builds);
      const existing = newBuilds.get(key);
      if (existing) {
        newBuilds.set(key, {
          ...existing,
          status: "done",
          message: "索引构建成功",
          open: true,
        });
      }
      return { builds: newBuilds };
    });

    // 3 秒后自动关闭窗口
    setTimeout(() => {
      get().dismissWindow(novelId, engine);
    }, 3000);
  },

  failBuild: (novelId, engine, error) => {
    const key = buildKey(novelId, engine);
    set((state) => {
      const newBuilds = new Map(state.builds);
      const existing = newBuilds.get(key);
      if (existing) {
        newBuilds.set(key, {
          ...existing,
          status: "error",
          message: "构建失败",
          error,
          open: true,
        });
      }
      return { builds: newBuilds };
    });
  },

  toggleWindow: (novelId, engine) => {
    const key = buildKey(novelId, engine);
    set((state) => {
      const newBuilds = new Map(state.builds);
      const existing = newBuilds.get(key);
      if (existing) {
        newBuilds.set(key, { ...existing, open: !existing.open });
      }
      return { builds: newBuilds };
    });
  },

  dismissWindow: (novelId, engine) => {
    const key = buildKey(novelId, engine);
    set((state) => {
      const newBuilds = new Map(state.builds);
      const existing = newBuilds.get(key);
      if (existing) {
        newBuilds.set(key, { ...existing, open: false });
      }
      return { builds: newBuilds };
    });
  },

  getBuildStatus: (novelId, engine) => {
    const key = buildKey(novelId, engine);
    return get().builds.get(key);
  },

  isBuilding: (novelId, engine) => {
    const key = buildKey(novelId, engine);
    const status = get().builds.get(key)?.status;
    return status === "building" || status === "loading" || status === "encoding" || status === "queued";
  },

  cleanupCompleted: () => {
    set((state) => {
      const newBuilds = new Map(state.builds);
      for (const [key, build] of newBuilds) {
        // 清除超过 1 小时的完成/错误状态
        if (
          (build.status === "done" || build.status === "error") &&
          Date.now() - build.startTime > 60 * 60 * 1000
        ) {
          newBuilds.delete(key);
        }
      }
      return { builds: newBuilds };
    });
  },
}));
