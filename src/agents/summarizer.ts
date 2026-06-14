/**
 * 章节总结和全书总结 Agent
 */

import type { AgentContext, AgentResult, AnalysisMetadata } from "./types";
import type { AgentEnvironment } from "./base-agent";
import { BaseAgent } from "./base-agent";
import { buildChapterSummaryPrompt } from "@/lib/prompt-templates";
import { sampleChapterContent } from "./utils";
import { estimateTokens } from "@/api/token-manager";
import { APIError } from "@/api/error-handler";

/**
 * 章节总结 Agent
 */
class SummarizerAgent extends BaseAgent {
  name = "summarizer";
  description = "生成章节摘要或全书总结";

  protected async execute(context: AgentContext, env: AgentEnvironment): Promise<AgentResult> {
    const { novel, provider, budget } = env;
    const maxChapterChars = Math.floor(budget.maxInputTokens * 0.5 * 3); // 50% of budget, ~3 chars per token

    const targetChapterIds = context.chapterIds || novel.chapters.map((c) => c.id);
    const chapters = novel.chapters.filter((c) => targetChapterIds.includes(c.id));

    if (chapters.length === 0) {
      return { success: false, error: "未找到指定章节" };
    }

    const results: { chapterTitle: string; content: string; tokens: number }[] = [];
    let totalTokens = 0;
    let usedFallback = false;
    let truncated = false;

    for (const chapter of chapters) {
      context.onStatus?.("正在准备分析数据...");
      const originalLength = chapter.content.length;
      let chapterContent = chapter.content;

      // 检查是否需要截断
      if (originalLength > maxChapterChars) {
        chapterContent = sampleChapterContent(chapter.content, maxChapterChars);
        usedFallback = true;
        truncated = true;
      }

      const prompt = buildChapterSummaryPrompt(chapter.title, chapterContent);

      try {
        context.onStatus?.("AI 正在生成分析...");
        const response = await provider.chat({
          model: "",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1024,
          temperature: 0.5,
          signal: context.signal,
        });

        results.push({
          chapterTitle: chapter.title,
          content: response.content,
          tokens: response.tokensUsed.total,
        });
        totalTokens += response.tokensUsed.total;
      } catch (err) {
        results.push({
          chapterTitle: chapter.title,
          content: `总结生成失败: ${this.formatError(err)}`,
          tokens: 0,
        });
      }
    }

    const hasAnySuccess = results.some((r) => !r.content.startsWith("总结生成失败:"));

    // 构建元数据
    const metadata: AnalysisMetadata = {
      usedFallback,
      truncated,
      originalLength: chapters.reduce((sum, ch) => sum + ch.content.length, 0),
      analyzedLength: truncated ? maxChapterChars * chapters.length : undefined,
    };

    return {
      success: hasAnySuccess || results.length === 0,
      data: { summaries: results, totalTokens },
      tokensUsed: totalTokens,
      metadata,
    };
  }

  private formatError(err: unknown): string {
    if (err instanceof APIError) {
      return `[${err.apiCode || err.code}] ${err.message}`;
    }
    return err instanceof Error ? err.message : "未知错误";
  }
}

/**
 * 全书总结 Agent
 */
class GlobalSummarizerAgent extends BaseAgent {
  name = "global-summarizer";
  description = "生成全书总结（发送小说结构信息+内容样本，让大模型自行分析）";

  protected async execute(context: AgentContext, env: AgentEnvironment): Promise<AgentResult> {
    const { novel, provider, budget } = env;

    // Build a prompt with metadata + chapter structure + content samples
    const chapterList = novel.chapters
      .map((c, i) => `${i + 1}. ${c.title} (${c.content.length.toLocaleString()} 字)`)
      .join("\n");

    // Use pre-retrieved relevant text from RAG if available, else fall back to samples
    const relevantContent = context.preRetrieved && context.preRetrieved.length > 100
      ? context.preRetrieved
      : this.sampleChapters(novel.chapters);

    const promptLabel = context.preRetrieved ? "语义检索相关段落" : "内容样本（开头几章+中间+结尾的片段）";

    const metadataPrompt = this.buildMetadataPrompt(novel, chapterList, promptLabel, relevantContent);
    const fallbackPrompt = this.buildFallbackPrompt(novel, chapterList, relevantContent, budget.maxInputTokens);

    // If the full prompt is too large, use the fallback
    context.onStatus?.("正在准备分析数据...");
    const estimatedInput = estimateTokens(metadataPrompt);
    const useFallback = estimatedInput >= budget.maxInputTokens * 0.7;
    const usePrompt = useFallback ? fallbackPrompt : metadataPrompt;

    try {
      context.onStatus?.("AI 正在生成分析...");
      const response = await provider.chat({
        model: "",
        messages: [
          {
            role: "system",
            content: "你是一位经验丰富的小说分析专家，擅长从有限信息中提取洞察。当信息不足时，你会诚实地标注推断的不确定性。",
          },
          { role: "user", content: usePrompt },
        ],
        max_tokens: 4096,
        temperature: 0.5,
        signal: context.signal,
      });

      return {
        success: true,
        data: {
          content: response.content,
          usedFallback: usePrompt === fallbackPrompt,
        },
        tokensUsed: response.tokensUsed.total,
      };
    } catch (err) {
      if (err instanceof APIError) {
        const code = err.apiCode || err.code;
        return {
          success: false,
          error: `[${code}] ${err.message}${code === "context_length" ? " (提示：小说文本过长，已自动使用精简模式，但仍超出限制。请尝试使用支持更长上下文的模型。)" : ""}`,
        };
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : "未知错误",
      };
    }
  }

  private sampleChapters(chapters: Array<{ title: string; content: string }>): string {
    const samples: string[] = [];
    if (chapters.length > 0) samples.push(`【${chapters[0].title}】开头:\n${chapters[0].content.slice(0, 1500)}`);
    if (chapters.length > 1) samples.push(`【${chapters[1].title}】开头:\n${chapters[1].content.slice(0, 1500)}`);
    if (chapters.length > 4) {
      const mid = Math.floor(chapters.length / 2);
      samples.push(`【${chapters[mid].title}】开头:\n${chapters[mid].content.slice(0, 1500)}`);
    }
    if (chapters.length > 2) {
      samples.push(`【${chapters[chapters.length - 1].title}】开头:\n${chapters[chapters.length - 1].content.slice(0, 1500)}`);
    }
    return samples.join("\n\n---\n\n");
  }

  private buildMetadataPrompt(
    novel: { title: string; author?: string; fileName: string; totalChars: number; chapters: Array<{ title: string }> },
    chapterList: string,
    promptLabel: string,
    relevantContent: string
  ): string {
    return `你是一位专业的小说分析助手。你需要分析一部小说，以下是该小说的基本信息，请基于这些信息生成一份全面的分析报告。

**小说基本信息：**
- 书名：《${novel.title}》${novel.author ? `\n- 作者：${novel.author}` : ""}
- 文件：${novel.fileName}
- 总字数：${novel.totalChars.toLocaleString()} 字
- 章节数：${novel.chapters.length} 章

**完整章节目录：**
${chapterList}

**${promptLabel}：**
${relevantContent}

**分析要求：**
请根据以上信息，生成一份详细的分析报告，包含：

1. **故事主线**：根据章节目录和内容样本，推断并梳理核心剧情走向。如果信息不足以完整还原，请标注"基于现有信息推断"。
2. **主要人物**：从内容样本中识别出现的重要角色，描述其特征和关系。
3. **主题分析**：识别小说的核心主题（爱情、复仇、成长、悬疑等），并引用章节内容佐证。
4. **结构特点**：分析小说的章节结构、叙事节奏。
5. **阅读建议**：基于章节分布，给读者提供阅读建议。

注意：由于只提供了内容样本，部分分析可能需要基于样本推断，请如实标注不确定的部分。`;
  }

  private buildFallbackPrompt(
    novel: { title: string; author?: string; totalChars: number; chapters: Array<{ title: string }> },
    chapterList: string,
    relevantContent: string,
    maxInputTokens: number
  ): string {
    return `你是一位专业的小说分析助手。请根据以下小说基本信息生成分析报告。

书名：《${novel.title}》
作者：${novel.author || "未知"}
总字数：${novel.totalChars.toLocaleString()} 字
章节数：${novel.chapters.length} 章

章节目录：
${chapterList}

${relevantContent.length > 0 ? `**语义检索相关段落（节选）：**\n${relevantContent.slice(0, Math.floor(maxInputTokens * 0.3))}` : "（无内容样本）"}

请基于以上信息生成：
1. 故事主线推断
2. 可能的主题方向
3. 结构分析
4. 阅读建议

（注意：内容可能不完整，请基于已有信息进行合理推断，并在回复中注明）`;
  }
}

// 导出 Agent 实例
export const summarizerAgent = new SummarizerAgent();
export const globalSummarizerAgent = new GlobalSummarizerAgent();
