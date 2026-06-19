export interface AgentContext {
  novelId: string;
  chapterIds?: string[];
  customInstruction?: string;
  signal?: AbortSignal;
  /** Pre-retrieved relevant text from RAG — if provided, agents skip random sampling */
  preRetrieved?: string;
  /** Callback to report current status/phase to the UI */
  onStatus?: (msg: string) => void;
}

/** 分析结果的元数据 */
export interface AnalysisMetadata {
  /** 是否使用了精简模式 */
  usedFallback?: boolean;
  /** 是否截断了内容 */
  truncated?: boolean;
  /** 原始内容长度（字符数） */
  originalLength?: number;
  /** 实际分析的内容长度（字符数） */
  analyzedLength?: number;
  /** 分段数（如果使用了分段分析） */
  segments?: number;
}

export interface AgentResult {
  success: boolean;
  data?: unknown;
  error?: string;
  tokensUsed?: number;
  /** 分析元数据 */
  metadata?: AnalysisMetadata;
}

/**
 * 任务类型常量 — 用于 UI 状态检测，替代脆弱的中文字符串匹配
 * 每个 Agent 声明自己的 taskType，runAgentTask 用它来标识当前任务
 */
export const TaskType = {
  CHAPTER: "chapter",
  GLOBAL: "global",
  TIMELINE: "timeline",
  CHARACTER: "character",
  GRAPH: "graph",
  MAP: "map",
  QA: "qa",
  RANGE: "range",
} as const;

export type TaskTypeValue = (typeof TaskType)[keyof typeof TaskType];

export interface Agent {
  name: string;
  description: string;
  /** 任务类型标识，用于 UI 判断哪个功能正在运行 */
  taskType?: TaskTypeValue;
  run(context: AgentContext): Promise<AgentResult>;
}

export interface OrchestratorTask {
  id: string;
  agentName: string;
  context: AgentContext;
  dependsOn?: string[];
  status: "pending" | "running" | "completed" | "failed";
  result?: AgentResult;
}

/** 地图数据结构 */
export interface MapData {
  /** 层级定义 */
  layers: Array<{
    level: number;
    name: string;
    description: string;
  }>;
  /** 地点 */
  places: Array<{
    id: string;
    name: string;
    type: string;
    level: number;
    parentId: string;
    description: string;
    importance: number;
    x: number;
    y: number;
    affiliation: string;
  }>;
  /** 区域 */
  regions: Array<{
    name: string;
    places: string[];
  }>;
  /** 势力 */
  forces: Array<{
    id: string;
    name: string;
    type: string;
    places: string[];
  }>;
}
