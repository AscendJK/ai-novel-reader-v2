/**
 * 人物关系图谱 Agent
 */

import type { AgentContext, AgentResult } from "./types";
import { TaskType } from "./types";
import type { AgentEnvironment } from "./base-agent";
import { BaseAgent } from "./base-agent";
import { getRelevantContent } from "./utils";
import { extractJSON } from "./json-extractor";
import { useUIStore } from "@/stores/ui-store";
import { estimateTokens } from "@/api/token-manager";

interface GraphData {
  nodes: { id: string; group: string; description: string }[];
  edges: { source: string; target: string; label: string }[];
}

/**
 * 人物关系图谱 Agent
 */
class CharacterGraphAgent extends BaseAgent {
  name = "character-graph";
  description = "只生成人物关系图谱JSON数据";
  taskType = TaskType.GRAPH as const;

  protected async execute(context: AgentContext, env: AgentEnvironment): Promise<AgentResult> {
    const { novel, provider, budget } = env;

    const chapterList = novel.chapters.map((c, i) => `${i + 1}. ${c.title}`).join("\n");

    const { content: relevantContent, label: promptLabel } = getRelevantContent(context, novel.chapters);
    const charLimit = useUIStore.getState().graphCharacterLimit ?? 50;

    context.onStatus?.("正在准备分析数据...");
    const prompt = `你是一位专业的小说人物关系分析专家。请根据以下小说信息，生成人物关系图谱的JSON数据。

**小说：**《${novel.title}》
**章节目录：**
${chapterList}

**${promptLabel}：**
${relevantContent}

请**只输出**一个JSON对象（不要其他任何文字），格式如下：
{"nodes":[{"id":"张三","group":"主角","description":"勇敢的青年剑客，性格坚毅"}],"edges":[{"source":"张三","target":"李四","label":"敌对"}]}

要求：
- 识别10-${charLimit}个重要角色
- **每个角色必须包含 description 字段**：用 15-30 字描述角色的身份、性格或关键特征
- group 用于分类角色类型，你可以根据小说特点自定义分类，常见的有：主角/配角/反派/导师/恋人/中立/悲剧/幕后黑手/工具人/其他
- label 用于描述人物关系，你可以根据小说特点自定义关系类型，常见的有：亲情/友情/爱情/敌对/师徒/利用/暗恋/仇敌/合作/主仆/同门/邻居/信任/背叛/保护/被保护
- 确保同一类别的值保持一致（如不要同时使用"主角"和"主要角色"）
- 确保所有source和target都在nodes中存在`;

    const estimatedInput = estimateTokens(prompt);
    const useFallback = estimatedInput >= budget.maxInputTokens * 0.7;
    const usePrompt = useFallback
      ? `请根据小说《${novel.title}》的章节目录生成人物关系图谱JSON。\n章节目录：\n${chapterList}\n请只输出JSON。`
      : prompt;

    try {
      context.onStatus?.("AI 正在生成分析...");
      const response = await provider.chat({
        model: "",
        messages: [
          { role: "system", content: "你是一个JSON数据生成器。只输出JSON，不要任何解释文字。" },
          { role: "user", content: usePrompt },
        ],
        max_tokens: 16384,
        temperature: 0.3,
        signal: context.signal,
      });

      // 检查响应内容
      if (!response.content || response.content.trim().length === 0) {
        return { success: false, error: "API 返回了空响应，请检查 API 配置或稍后重试。" };
      }

      // Parse JSON from response
      context.onStatus?.("正在解析分析结果...");
      const graphData = this.parseGraphData(response.content);

      if (!graphData) {
        return { success: false, error: "未能从 AI 回复中提取到 JSON 图谱数据，请重试。" };
      }

      // Validate structure
      const validationError = this.validateGraphData(graphData);
      if (validationError) {
        return { success: false, error: validationError };
      }

      return { success: true, data: { graphData }, tokensUsed: response.tokensUsed.total };
    } catch (err) {
      return { success: false, error: this.formatError(err) };
    }
  }

  /**
   * 解析图谱 JSON 数据
   */
  private parseGraphData(content: string): GraphData | null {
    return extractJSON<GraphData>(content);
  }

  /**
   * 验证图谱数据结构（会修改输入数据：过滤无效的边、补全缺失字段）
   */
  private validateGraphData(graphData: GraphData): string | null {
    if (!Array.isArray(graphData?.nodes) || graphData.nodes.length === 0) {
      return "图谱数据不完整（nodes 为空或不是数组），请重试。";
    }
    if (!Array.isArray(graphData?.edges) || graphData.edges.length === 0) {
      return "图谱数据不完整（edges 为空或不是数组），请重试。";
    }

    // 补全缺失的 description 字段
    for (const node of graphData.nodes) {
      if (!node.description) {
        node.description = `${node.id}（${node.group || "未知"}）`;
      }
      if (!node.group) {
        node.group = "其他";
      }
    }

    // Filter out invalid edges (edges referencing non-existent nodes)
    const nodeIds = new Set(graphData.nodes.map((n) => n.id));
    const validEdges = graphData.edges.filter(
      (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)
    );

    if (validEdges.length === 0) {
      return "图谱数据有误：所有边都引用了不存在的节点，请重试。";
    }

    // Use filtered edges
    graphData.edges = validEdges;
    return null;
  }

  private formatError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return "未知错误";
  }
}

// 导出 Agent 实例
export const characterGraphAgent = new CharacterGraphAgent();
