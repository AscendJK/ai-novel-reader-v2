/**
 * 人物分析和时间线 Agent
 */

import type { AgentContext, AgentResult } from "./types";
import { TaskType } from "./types";
import type { AgentEnvironment } from "./base-agent";
import { BaseAgent } from "./base-agent";
import { getRelevantContent } from "./utils";
import { estimateTokens } from "@/api/token-manager";

/**
 * 人物分析 Agent
 */
class CharacterAnalysisAgent extends BaseAgent {
  name = "character-analysis";
  description = "分析小说主要人物及其关系";
  taskType = TaskType.CHARACTER as const;

  protected async execute(context: AgentContext, env: AgentEnvironment): Promise<AgentResult> {
    const { novel, provider, budget } = env;

    const chapterList = novel.chapters
      .map((c, i) => {
        const charCount = c.content.length;
        return charCount > 0 ? `${i + 1}. ${c.title} (${charCount.toLocaleString()}字)` : `${i + 1}. ${c.title}`;
      })
      .join("\n");

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
    const usedFallback = estimatedInput >= budget.maxInputTokens * 0.7;
    const usePrompt = usedFallback
      ? `请根据小说《${novel.title}》的章节目录分析人物关系。\n\n章节目录：\n${chapterList}\n\n请分析主要人物的关系网络、性格特征与成长变化。`
      : prompt;

    try {
      context.onStatus?.("AI 正在生成分析...");
      const response = await provider.chat({
        model: "",
        messages: [
          { role: "system", content: "你是一位资深的小说人物分析师，擅长深入剖析角色性格、关系网络和人物弧光。" },
          { role: "user", content: usePrompt },
        ],
        max_tokens: 4096,
        temperature: 0.4,
        signal: context.signal,
      });

      return {
        success: true,
        data: { content: response.content, usedFallback },
        tokensUsed: response.tokensUsed.total,
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
  taskType = TaskType.TIMELINE as const;

  protected async execute(context: AgentContext, env: AgentEnvironment): Promise<AgentResult> {
    const { novel, provider, budget } = env;

    const chapterList = novel.chapters
      .map((c, i) => {
        const charCount = c.content.length;
        return charCount > 0 ? `${i + 1}. ${c.title} (${charCount.toLocaleString()}字)` : `${i + 1}. ${c.title}`;
      })
      .join("\n");

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

以此类推，不要使用表格，不要在编号列表内添加子列表。

### 二、剧情结构分析
分析开端/发展/转折/高潮/结局分别在哪些章节、叙事手法、主线与支线分布。

### 三、伏笔与回收
列出重要的伏笔及其回收章节。`;

    const estimatedInput = estimateTokens(prompt);
    const usedFallback = estimatedInput >= budget.maxInputTokens * 0.7;
    const usePrompt = usedFallback
      ? `请根据《${novel.title}》的章节目录推断剧情时间线。\n章节目录：\n${chapterList}\n\n请按时间顺序逐条列出关键事件（不要用表格，不要在列表项内使用子列表），每个事件格式：\n1. **【事件名称】**（第X章 · 类型）发生了什么。→ 因果关系。\n\n标注"基于目录推断"。`
      : prompt;

    try {
      context.onStatus?.("AI 正在生成分析...");
      const response = await provider.chat({
        model: "",
        messages: [
          { role: "system", content: "你是一位资深的小说剧情分析师，擅长提取和梳理剧情时间线。" },
          { role: "user", content: usePrompt },
        ],
        max_tokens: 4096,
        temperature: 0.4,
        signal: context.signal,
      });

      return {
        success: true,
        data: { content: response.content, usedFallback },
        tokensUsed: response.tokensUsed.total,
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
