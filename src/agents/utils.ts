/**
 * Agent 公共工具函数
 * 提取各 Agent 中重复的逻辑
 */

import type { AgentContext, AgentResult } from "./types";
import type { AIProvider, ProviderConfig } from "@/api/types";
import { getProvider } from "@/api/registry";
import { useAPIStore } from "@/stores/api-store";
import { loadNovel } from "@/db/repositories";
import type { Novel } from "@/parsers/types";
import { getTokenBudget, type TokenBudget } from "@/api/token-manager";
import { APIError } from "@/api/error-handler";

/**
 * 获取当前激活的 API Provider
 * @throws {Error} 如果未配置 API
 */
export function getActiveProvider(): AIProvider {
  const config = useAPIStore.getState().getActiveProvider();
  if (!config) throw new Error("请先在设置中配置 API");
  return getProvider(config);
}

/**
 * 获取 Provider 配置和 Token 预算
 */
export function getProviderBudget(): { config: ProviderConfig | null; budget: TokenBudget } {
  const config = useAPIStore.getState().getActiveProvider() as ProviderConfig | null;
  const model = config?.model || "";
  const budget = getTokenBudget(model, config?.contextWindow);
  return { config, budget };
}

/**
 * 加载小说数据
 * @param novelId 小说 ID
 * @param onStatus 状态回调
 * @returns 小说数据或 null
 */
export async function loadNovelData(
  novelId: string,
  onStatus?: (status: string) => void,
  options?: { loadAllContent?: boolean }
): Promise<Novel | null> {
  onStatus?.("正在加载小说数据...");
  const novel = await loadNovel(novelId, undefined, options?.loadAllContent);
  return novel;
}

/**
 * 准备 Agent 运行环境
 * 加载小说、获取 Provider 和 Token 预算
 *
 * @param context Agent 上下文
 * @returns 准备好的运行环境，如果失败返回错误结果
 */
export async function prepareAgentContext(
  context: AgentContext,
  options?: { loadAllContent?: boolean }
): Promise<
  | { success: true; novel: Novel; provider: AIProvider; budget: TokenBudget }
  | { success: false; error: string }
> {
  // 加载小说
  const novel = await loadNovelData(context.novelId, context.onStatus, options);
  if (!novel) {
    return { success: false, error: "小说数据未找到" };
  }

  // 获取 Provider
  let provider: AIProvider;
  try {
    provider = getActiveProvider();
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "获取 API Provider 失败" };
  }

  // 获取 Token 预算
  const { budget } = getProviderBudget();

  return { success: true, novel, provider, budget };
}

/**
 * 从章节列表中采样内容
 * 当没有预检索内容时，从章节中采样作为回退
 *
 * @param chapters 章节列表
 * @param maxSamples 最大采样章节数
 * @returns 采样后的内容
 */
export function sampleChaptersContent(
  chapters: Array<{ title: string; content: string }>,
  maxSamples: number = 5
): string {
  const indices: number[] = [0, 1, 2];
  if (chapters.length > 6) indices.push(Math.floor(chapters.length / 2));
  if (chapters.length > 3) indices.push(chapters.length - 1);

  return [...new Set(indices)]
    .filter((i) => i < chapters.length)
    .slice(0, maxSamples)
    .map((i) => `【${chapters[i].title}】\n${chapters[i].content.slice(0, 2000)}`)
    .join("\n\n---\n\n");
}

/**
 * 获取相关内容（预检索或回退采样）
 *
 * @param context Agent 上下文
 * @param chapters 章节列表
 * @returns 相关内容
 */
export function getRelevantContent(
  context: AgentContext,
  chapters: Array<{ title: string; content: string }>
): { content: string; label: string } {
  if (context.preRetrieved && context.preRetrieved.length > 100) {
    return { content: context.preRetrieved, label: "语义检索相关段落" };
  }
  return { content: sampleChaptersContent(chapters), label: "内容样本" };
}

/**
 * 格式化 Agent 错误
 *
 * @param err 错误对象
 * @returns 格式化的错误消息
 */
export function formatAgentError(err: unknown): string {
  if (err instanceof APIError) {
    return `[${err.apiCode || err.code}] ${err.message}`;
  }
  return err instanceof Error ? err.message : "未知错误";
}

/**
 * 执行 Agent 任务的通用包装器
 * 统一处理错误和状态
 *
 * @param taskName 任务名称
 * @param task 实际任务函数
 * @returns Agent 结果
 */
export async function executeAgentTask(
  taskName: string,
  task: () => Promise<AgentResult>
): Promise<AgentResult> {
  try {
    return await task();
  } catch (err) {
    const error = formatAgentError(err);
    console.error(`[Agent:${taskName}] Error:`, error);
    return { success: false, error };
  }
}

/**
 * 智能章节内容采样
 * 优先保留关键段落（开头、结尾、包含关键词的段落）
 *
 * @param content 原始内容
 * @param maxChars 最大字符数
 * @returns 采样后的内容
 */
export function sampleChapterContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;

  // 按段落分割
  const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 0);

  // 如果段落数很少，使用简单的截断
  if (paragraphs.length <= 5) {
    return simpleSample(content, maxChars);
  }

  // 识别关键段落
  const keyParagraphIndices = findKeyParagraphs(paragraphs);

  // 选择要保留的段落
  const selectedIndices = new Set<number>();

  // 1. 始终保留开头和结尾
  selectedIndices.add(0);
  selectedIndices.add(paragraphs.length - 1);

  // 2. 添加关键段落
  for (const idx of keyParagraphIndices) {
    if (selectedIndices.size >= 20) break; // 最多保留 20 段
    selectedIndices.add(idx);
  }

  // 3. 如果还有空间，均匀添加段落
  const remainingSlots = Math.floor((maxChars - selectedIndices.size * 100) / 200);
  if (remainingSlots > 0) {
    const step = Math.max(1, Math.floor(paragraphs.length / remainingSlots));
    for (let i = step; i < paragraphs.length - 1; i += step) {
      if (selectedIndices.size >= remainingSlots + selectedIndices.size) break;
      selectedIndices.add(i);
    }
  }

  // 4. 按顺序组合选中的段落
  const sortedIndices = Array.from(selectedIndices).sort((a, b) => a - b);
  const sampledParagraphs = sortedIndices.map(i => paragraphs[i]);

  // 5. 检查是否超长，如果超长则截断
  let result = sampledParagraphs.join("\n\n");
  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 30) + "\n\n[...内容已截断...]";
  }

  return `（以下为长章节智能节选，保留了关键段落）\n\n${result}`;
}

/**
 * 简单采样（用于段落很少的情况）
 */
function simpleSample(content: string, maxChars: number): string {
  const header = "（以下为长章节节选：开头、中间、结尾）\n\n";
  const available = maxChars - header.length;
  const headLen = Math.floor(available * 0.3);
  const endLen = Math.floor(available * 0.2);
  const midBudget = available - headLen - endLen;

  const head = content.slice(0, headLen);
  const end = content.slice(content.length - endLen);

  const midStart = headLen;
  const midEnd = content.length - endLen;
  const midLen = midEnd - midStart;
  const sampleSize = Math.floor(midBudget / 2);
  const step = Math.floor(midLen / 3);

  const midSamples: string[] = [];
  for (let i = 0; i < 2; i++) {
    const start = midStart + step * (i + 1) - Math.floor(sampleSize / 2);
    const clampedStart = Math.max(midStart, Math.min(start, midEnd - sampleSize));
    midSamples.push(`[...]\n${content.slice(clampedStart, clampedStart + sampleSize)}`);
  }

  return header + head + "\n\n" + midSamples.join("\n\n") + "\n\n[...]\n\n" + end;
}

/**
 * 识别关键段落
 * 返回包含关键词的段落索引
 */
function findKeyParagraphs(paragraphs: string[]): number[] {
  // 情节转折关键词
  const plotKeywords = [
    "突然", "忽然", "忽然间", "猛然", "骤然",
    "终于", "最终", "最后", "结局",
    "然而", "但是", "可是", "不过", "却",
    "发现", "发觉", "意识到", "明白",
    "决定", "决心", "选择", "放弃",
    "离开", "离去", "告别", "出发",
    "回来", "归来", "返回", "重逢",
    "死亡", "去世", "牺牲", "离世",
    "结婚", "婚礼", "在一起", "分离", "分手",
    "战斗", "决斗", "胜利", "失败", "投降",
    "真相", "秘密", "谎言", "欺骗",
  ];

  // 人物相关关键词
  const characterKeywords = [
    "主角", "主人公", "英雄", "反派", "敌人",
    "父亲", "母亲", "哥哥", "姐姐", "弟弟", "妹妹",
    "朋友", "敌人", "恋人", "妻子", "丈夫",
  ];

  const keyIndices: { index: number; score: number }[] = [];

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    let score = 0;

    // 检查情节关键词
    for (const keyword of plotKeywords) {
      if (para.includes(keyword)) score += 2;
    }

    // 检查人物关键词
    for (const keyword of characterKeywords) {
      if (para.includes(keyword)) score += 1;
    }

    // 对话通常包含重要内容
    if (para.includes('"') || para.includes('"') || para.includes('「')) {
      score += 1;
    }

    // 感叹号、问号表示情感强烈
    const exclamationCount = (para.match(/[!！?？]/g) || []).length;
    score += Math.min(exclamationCount, 3);

    if (score > 0) {
      keyIndices.push({ index: i, score });
    }
  }

  // 按分数排序，返回前 10 个
  return keyIndices
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(item => item.index);
}

// ============================================================
// 分段分析
// ============================================================

/** 分段分析结果 */
export interface SegmentedAnalysisResult {
  /** 合并后的分析内容 */
  content: string;
  /** 使用的段数 */
  segments: number;
  /** 是否使用了分段分析 */
  usedSegmentation: boolean;
}

/**
 * 将长文本分成多段
 * @param text 原始文本
 * @param maxSegmentChars 每段最大字符数
 * @returns 分段后的文本数组
 */
export function splitTextIntoSegments(text: string, maxSegmentChars: number): string[] {
  // 如果文本不长，直接返回
  if (text.length <= maxSegmentChars) {
    return [text];
  }

  const paragraphs = text.split(/\n\n+/);
  const segments: string[] = [];
  let currentSegment = '';

  for (const paragraph of paragraphs) {
    // 如果单个段落就超过限制，强制分割
    if (paragraph.length > maxSegmentChars) {
      if (currentSegment) {
        segments.push(currentSegment);
        currentSegment = '';
      }
      // 将长段落按句子分割
      const sentences = paragraph.split(/(?<=[。！？.!?])/);
      let sentenceSegment = '';
      for (const sentence of sentences) {
        if ((sentenceSegment + sentence).length > maxSegmentChars) {
          if (sentenceSegment) segments.push(sentenceSegment);
          sentenceSegment = sentence;
        } else {
          sentenceSegment += sentence;
        }
      }
      if (sentenceSegment) segments.push(sentenceSegment);
      continue;
    }

    // 正常段落处理
    if ((currentSegment + '\n\n' + paragraph).length > maxSegmentChars) {
      if (currentSegment) segments.push(currentSegment);
      currentSegment = paragraph;
    } else {
      currentSegment = currentSegment ? currentSegment + '\n\n' + paragraph : paragraph;
    }
  }

  if (currentSegment) segments.push(currentSegment);

  return segments;
}

/**
 * 分段分析长文本
 * @param text 长文本
 * @param maxCharsPerSegment 每段最大字符数
 * @param analyzeSegment 分析单个段落的函数
 * @param mergeAnalyses 合并多个分析结果的函数
 * @returns 分析结果
 */
export async function analyzeLongText(
  text: string,
  maxCharsPerSegment: number,
  analyzeSegment: (segment: string, index: number, total: number) => Promise<string>,
  mergeAnalyses: (analyses: string[]) => Promise<string>
): Promise<SegmentedAnalysisResult> {
  // 如果文本不长，直接分析
  if (text.length <= maxCharsPerSegment) {
    const content = await analyzeSegment(text, 0, 1);
    return {
      content,
      segments: 1,
      usedSegmentation: false,
    };
  }

  // 分段
  const segments = splitTextIntoSegments(text, maxCharsPerSegment);

  // 并行分析各段
  const analyses = await Promise.all(
    segments.map((segment, i) => analyzeSegment(segment, i, segments.length))
  );

  // 合并分析结果
  const content = await mergeAnalyses(analyses);

  return {
    content,
    segments: segments.length,
    usedSegmentation: true,
  };
}

/**
 * 创建默认的合并 prompt
 */
export function createMergePrompt(analyses: string[], analysisType: string): string {
  return `请将以下多个${analysisType}分析结果合并为一个完整的分析：

${analyses.map((a, i) => `--- 第 ${i + 1} 部分 ---\n${a}`).join('\n\n')}

要求：
1. 去除重复内容
2. 按逻辑顺序组织
3. 保持分析的完整性
4. 输出合并后的完整分析`;
}
