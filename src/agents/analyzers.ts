/**
 * 人物分析和时间线 Agent
 */

import type { AgentContext, AgentResult } from "./types";
import { TaskType } from "./types";
import type { AgentEnvironment } from "./base-agent";
import { BaseAgent } from "./base-agent";
import { getRelevantContent, chatWithContextRetry, sampleChapterTitles } from "./utils";
import { estimateTokens, computeAvailableInput, resolveOutputReserve, type TokenBudget } from "@/api/token-manager";

/**
 * 人物分析与时间线的默认输出预算。
 *
 * 两次变化。第一次：它从"硬顶"降级成"默认"——用户在设置里填过输出上限时由它顶开。
 * 起因是真厂商实测：`deepseek-flash` 会把 4096 的预算全花在 reasoning 上、正文回 0 字，
 * 而同一个人在设置里填的 8192 对地图（常数 16384）生效、对这两类任务一点作用都没有。
 * 第二次：这个默认本身从 4096 抬到 8192（制作人拍的）——人物名单连关系、大事记连评述，
 * 都是"一次写一整篇"，4096 对一本长篇真的会写在半句上收尾。代价实测过：预留与可用输入
 * 1:1 兑换，128k 窗口少喂 4,096 字，所以只抬这两类和全书总览，章节总结的 1024 不动。
 */
const ANALYZER_OUTPUT_TOKENS = 8192;

/**
 * 人物分析 Agent
 */
class CharacterAnalysisAgent extends BaseAgent {
  name = "character-analysis";
  description = "分析小说主要人物及其关系";
  taskType = TaskType.CHARACTER;

  /** 同一个数：既从输入侧扣掉，也作为 `max_tokens` 发出去 */
  private reserve(b: TokenBudget): number {
    return resolveOutputReserve(b, ANALYZER_OUTPUT_TOKENS, "人物关系分析");
  }

  protected async execute(context: AgentContext, env: AgentEnvironment): Promise<AgentResult> {
    const { novel, provider, budget } = env;

    const chapterLines = novel.chapters
      .map((c, i) => {
        const charCount = c.content.length;
        return charCount > 0 ? `${i + 1}. ${c.title} (${charCount.toLocaleString()}字)` : `${i + 1}. ${c.title}`;
      });
    // 长书的全量目录本身就能把请求顶到 400（旧实现的"精简版"也带着它），
    // 所以目录同样按预算抽样，并明确告诉模型这是抽样（round 2 R-40）
    const chapterList = sampleChapterTitles(chapterLines, Math.floor(computeAvailableInput(budget, this.reserve(budget)) * 0.25)).text;

    const { content: relevantContent, label: promptLabel } = getRelevantContent(context, novel.chapters);

    context.onStatus?.("正在准备分析数据...");
    const prompt = `你是一位专业的小说人物关系分析专家。请根据以下小说信息，深入分析主要人物及其关系网络。

**小说：**《${novel.title}》${novel.author ? ` · 作者：${novel.author}` : ""}
**总字数：** ${novel.totalChars.toLocaleString()} 字
**章节数：** ${novel.chapters.length} 章

**章节目录：**
${chapterList}

**${promptLabel}：**
${relevantContent}

请输出以下分析内容：

1. **主要人物档案**（识别 8-15 个重要角色）：每个角色列出姓名、性格关键词、角色定位、人物简介、角色弧光
2. **人物关系网络**：详细描述每对重要人物之间的关系类型、互动方式及关系演变过程
3. **人物冲突与张力**：分析主要角色之间的矛盾冲突、利益纠葛和情感张力
4. **人物成长轨迹**：追踪关键角色从故事开始到结束的成长变化
5. **人物重要性评估**：按剧情推动作用排序，说明每个角色对主线的影响`;

    const estimatedInput = estimateTokens(prompt);
    const usedFallback = estimatedInput >= computeAvailableInput(budget, this.reserve(budget));
    let effectiveFallback = usedFallback;

    try {
      context.onStatus?.("AI 正在生成分析...");
      const response = await chatWithContextRetry(env, async (b) => {
        // 400 自愈时用最新预算重新决定是否精简（预留与请求同一个数，见 `reserve`）
        const reserve = this.reserve(b);
        const est = estimateTokens(prompt);
        const useFb = est >= computeAvailableInput(b, reserve);
        effectiveFallback = useFb;
        const useP = useFb
          ? `请根据小说《${novel.title}》的章节目录分析人物关系。\n\n章节目录：\n${chapterList}\n\n请分析主要人物的关系网络、性格特征与成长变化。`
          : prompt;
        return provider.chat({
          model: "",
          messages: [
            { role: "system", content: "你是一位资深的小说人物分析师，擅长深入剖析角色性格、关系网络和人物弧光。" },
            { role: "user", content: useP },
          ],
          // 与上面 `computeAvailableInput(b, reserve)` 同一个值：请求超过预留量会在
          // 严格校验 input+max_tokens≤context 的服务商触发 400
          max_tokens: reserve,
          temperature: 0.4,
          signal: context.signal,
        });
      });

      return {
        success: true,
        data: { content: response.content, usedFallback: effectiveFallback },
        tokensUsed: response.content.length,
      };
    } catch (err) {
      return { success: false, error: this.formatError(err) };
    }
  }

  private formatError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return "未知错误";
  }
}

/**
 * 时间线 Agent
 */
class TimelineAgent extends BaseAgent {
  name = "timeline";
  description = "提取小说剧情时间线";
  taskType = TaskType.TIMELINE;

  /** 同一个数：既从输入侧扣掉，也作为 `max_tokens` 发出去 */
  private reserve(b: TokenBudget): number {
    return resolveOutputReserve(b, ANALYZER_OUTPUT_TOKENS, "剧情时间线");
  }

  protected async execute(context: AgentContext, env: AgentEnvironment): Promise<AgentResult> {
    const { novel, provider, budget } = env;

    const chapterLines = novel.chapters
      .map((c, i) => {
        const charCount = c.content.length;
        return charCount > 0 ? `${i + 1}. ${c.title} (${charCount.toLocaleString()}字)` : `${i + 1}. ${c.title}`;
      });
    // 长书的全量目录本身就能把请求顶到 400（旧实现的"精简版"也带着它），
    // 所以目录同样按预算抽样，并明确告诉模型这是抽样（round 2 R-40）
    const chapterList = sampleChapterTitles(chapterLines, Math.floor(computeAvailableInput(budget, this.reserve(budget)) * 0.25)).text;

    const { content: relevantContent, label: promptLabel } = getRelevantContent(context, novel.chapters);

    context.onStatus?.("正在准备分析数据...");
    const prompt = `你是一位专业的小说剧情分析师。请根据以下小说信息，提取关键剧情时间线。

**小说：**《${novel.title}》${novel.author ? ` · 作者：${novel.author}` : ""}
**总字数：** ${novel.totalChars.toLocaleString()} 字
**章节数：** ${novel.chapters.length} 章

**章节目录：**
${chapterList}

**${promptLabel}：**
${relevantContent}

**分析要求：**

### 一、剧情主线时间线

按时间顺序列出 15-25 个关键事件。**每个事件必须是一个独立的编号列表项，且每个列表项只能是一整段文字，不要在列表项内使用子列表（不要用 - 开头的子项）。** 格式如下：

1. **【事件名称】**（第X章 · 类型）发生了什么。→ 因果关系。
2. **【事件名称】**（第X章 · 类型）发生了什么。→ 因果关系。
3. ...

以此类推，不要在编号列表内添加子列表。

### 二、剧情结构分析
分析开端/发展/转折/高潮/结局分别在哪些章节、叙事手法、主线与支线分布。

### 三、伏笔与回收
列出重要的伏笔及其回收章节。`;

    const estimatedInput = estimateTokens(prompt);
    const usedFallback = estimatedInput >= computeAvailableInput(budget, this.reserve(budget));
    let effectiveFallback = usedFallback;

    try {
      context.onStatus?.("AI 正在生成分析...");
      const response = await chatWithContextRetry(env, async (b) => {
        // 400 自愈时用最新预算重新决定是否精简（预留与请求同一个数，见 `reserve`）
        const reserve = this.reserve(b);
        const est = estimateTokens(prompt);
        const useFb = est >= computeAvailableInput(b, reserve);
        effectiveFallback = useFb;
        const useP = useFb
          ? `请根据《${novel.title}》的章节目录推断剧情时间线。\n章节目录：\n${chapterList}\n\n请按时间顺序逐条列出关键事件（不要在列表项内使用子列表），每个事件格式：\n1. **【事件名称】**（第X章 · 类型）发生了什么。→ 因果关系。\n\n标注"基于目录推断"。`
          : prompt;
        return provider.chat({
          model: "",
          messages: [
            { role: "system", content: "你是一位资深的小说剧情分析师，擅长提取和梳理剧情时间线。" },
            { role: "user", content: useP },
          ],
          // 与上面 `computeAvailableInput(b, reserve)` 同一个值（同人物分析 Agent）
          max_tokens: reserve,
          temperature: 0.4,
          signal: context.signal,
        });
      });

      return {
        success: true,
        data: { content: response.content, usedFallback: effectiveFallback },
        tokensUsed: response.content.length,
      };
    } catch (err) {
      return { success: false, error: this.formatError(err) };
    }
  }

  private formatError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return "未知错误";
  }
}

// 导出 Agent 实例
export const characterAnalysisAgent = new CharacterAnalysisAgent();
export const timelineAgent = new TimelineAgent();
