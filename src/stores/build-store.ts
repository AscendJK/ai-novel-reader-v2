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
  /** 最后一次状态变化的时刻——用来识别"再也不会推进"的僵死构建 */
  lastUpdate: number;
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
        lastUpdate: Date.now(),
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
        newBuilds.set(key, { ...existing, ...progress, lastUpdate: Date.now() });
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
          lastUpdate: Date.now(),
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
          lastUpdate: Date.now(),
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
      const now = Date.now();
      for (const [key, build] of newBuilds) {
        const since = now - (build.lastUpdate ?? build.startTime);
        // 清除超过 1 小时的完成/错误状态
        if (
          (build.status === "done" || build.status === "error") &&
          since > 60 * 60 * 1000
        ) {
          newBuilds.delete(key);
          continue;
        }
        // 进行中的构建长时间没有任何状态推进 → 判为僵死。轮询依赖 sync-token
        // 且离线时会直接 return，一旦 token 失效/切页/离线，就再没人把这条推进
        // 或收尾；不判定的话状态窗口永远"构建中"、构建按钮永久禁用（R-25）。
        // 20 分钟远大于服务端每 chunk 的动态超时节奏，不会误杀正常构建。
        if (
          (build.status === "building" || build.status === "loading"
            || build.status === "encoding" || build.status === "queued") &&
          since > 20 * 60 * 1000
        ) {
          newBuilds.set(key, {
            ...build,
            status: "error",
            message: "构建状态长时间未更新",
            error: "服务器或网络在中途失联，请重新构建",
            open: true,
            lastUpdate: now,
          });
        }
      }
      return { builds: newBuilds };
    });
  },
}));
