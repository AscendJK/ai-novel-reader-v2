export type EngineId = string;

export interface EngineInfo {
  id: EngineId;
  name: string;
  description: string;
  size: string;
  modelKey: string;
  strengths: string[];
  weaknesses: string[];
}

export const ENGINES: Record<string, EngineInfo> = {
  tfidf: {
    id: "tfidf",
    name: "TF-IDF（内置）",
    description: "纯本地字符级检索，零依赖，即时可用",
    size: "0 MB",
    modelKey: "",
    strengths: [
      "无需额外文件，开箱即用",
      "关键词和短语匹配准确",
      "对中文词汇的字符级拆解有效",
    ],
    weaknesses: [
      "不理解语义，只做字面匹配",
      "无法识别同义词和近义词",
      "不能理解隐喻、成语和古文",
    ],
  },
  "bge-small-zh": {
    id: "bge-small-zh",
    name: "BGE Small 中文专精（内置·推荐）",
    description: "北京智源出品，专为中文优化的嵌入模型，中文场景最佳",
    size: "约 26 MB",
    modelKey: "Xenova/bge-small-zh-v1.5",
    strengths: [
      "中文语义匹配最优，理解成语和古诗文",
      "对中文修辞手法和隐喻识别强",
      "512维向量，检索精度高于384维模型",
      "INT8量化仅26MB，体积小巧",
    ],
    weaknesses: [
      "不支持英文文本查询",
      "加载时间4-6秒，略长于 TF-IDF",
    ],
  },
  "Xenova/multilingual-e5-small": {
    id: "Xenova/multilingual-e5-small",
    name: "Multilingual E5 Small",
    description: "微软多语言模型，100+语言支持，中英文兼顾",
    size: "约 120 MB",
    modelKey: "Xenova/multilingual-e5-small",
    strengths: [
      "100+语言支持，中英文兼顾",
      "语义级匹配，能理解同义词",
      "学术评测分数高，通用性强",
    ],
    weaknesses: [
      "模型文件较大（约120MB）",
      "中文成语、古文理解不如 BGE",
    ],
  },
  "gte-small": {
    id: "gte-small",
    name: "GTE Small（内置·推荐）",
    description: "阿里通义实验室出品，中英文均衡，检索评测表现优秀",
    size: "约 34 MB",
    modelKey: "Xenova/gte-small",
    strengths: [
      "中英文均衡，双语场景表现好",
      "阿里出品，中文语料训练充分",
      "384维向量，检索精度高",
      "INT8量化仅34MB，体积适中",
    ],
    weaknesses: [
      "中文古文理解不如 BGE",
      "加载时间与 BGE 相近",
    ],
  },
  "Xenova/all-MiniLM-L6-v2": {
    id: "Xenova/all-MiniLM-L6-v2",
    name: "All-MiniLM-L6-v2",
    description: "英文最佳轻量模型，体积小速度快，适合纯英文小说",
    size: "约 23 MB",
    modelKey: "Xenova/all-MiniLM-L6-v2",
    strengths: [
      "英文语义理解优秀",
      "体积仅 23MB，加载快",
      "推理速度快",
    ],
    weaknesses: [
      "中文支持差",
      "不适合中文为主的阅读场景",
    ],
  },
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2": {
    id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    name: "Multilingual MiniLM L12",
    description: "50+语言深度语义理解，12层Transformer，多语言场景最强",
    size: "约 120 MB",
    modelKey: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    strengths: [
      "50+语言支持，覆盖面广",
      "12层Transformer，语义理解深",
      "多语言场景表现最佳",
    ],
    weaknesses: [
      "模型文件较大（约120MB）",
      "推理速度比轻量模型慢",
    ],
  },
};

export function isEmbeddingEngine(engine: EngineId): boolean {
  return engine !== "tfidf";
}

export function resolveModelKey(engine: EngineId): string {
  if (engine === "tfidf") return "";
  const info = ENGINES[engine];
  if (info?.modelKey) return info.modelKey;
  return engine;
}

export function getEngineInfo(id: EngineId): EngineInfo | undefined {
  return ENGINES[id];
}

export function getEngineDisplayName(id: EngineId): string {
  const info = ENGINES[id];
  if (info) return info.name;
  const parts = id.split("/");
  return parts[parts.length - 1];
}
