/**
 * 人物关系图谱 Agent
 */

import type { AgentContext, AgentResult } from "./types";
import { TaskType } from "./types";
import type { AgentEnvironment } from "./base-agent";
import { BaseAgent } from "./base-agent";
import { getRelevantContent, chatWithContextRetry, sampleChapterTitles } from "./utils";
import { extractJSON } from "./json-extractor";
import { useUIStore } from "@/stores/ui-store";
import { estimateTokens, computeAvailableInput, resolveOutputReserve, type TokenBudget } from "@/api/token-manager";
import { isEmptyResultError, classifyVendorRefusal, classifyTransportFailure, UNREACHABLE_HINT } from "@/api/error-handler";

interface GraphData {
  nodes: { id: string; group: string; description: string }[];
  edges: { source: string; target: string; label: string; autoLinked?: boolean }[];
}

/**
 * 当 AI 未生成边时，自动生成链式关系边兜底。
 *
 * 每条都打 `autoLinked`：这条链是按人物顺序连出来的，不是模型读出来的关系，而界面上一眼
 * 看不出区别（`CharacterGraphSection` 的提示行与 `CharacterGraph` 的虚线只认这个标记）。
 * 真后端那档 R-E7 就是因此被改过判据——"界面有 N 条关系"根本证明不了模型回了关系。
 */
function autoGenerateEdges(nodes: GraphData["nodes"]): GraphData["edges"] {
  const edges: GraphData["edges"] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ source: nodes[i].id, target: nodes[i + 1].id, label: "关联", autoLinked: true });
  }
  return edges;
}

/**
 * 人物关系图谱 Agent
 */
class CharacterGraphAgent extends BaseAgent {
  name = "character-graph";
  description = "只生成人物关系图谱JSON数据";
  taskType = TaskType.GRAPH;

  /** 同一个数：既从输入侧扣掉，也作为 `max_tokens` 发出去（原来三处的字面量 8192，值没变） */
  private reserve(b: TokenBudget): number {
    return resolveOutputReserve(b, 8192, "人物关系图谱");
  }

  protected async execute(context: AgentContext, env: AgentEnvironment): Promise<AgentResult> {
    const { novel, provider } = env;

    // 目录按预算抽样：上千章的书带着全量目录必 400（round 2 R-40）
    const chapterList = sampleChapterTitles(
      novel.chapters.map((c, i) => `${i + 1}. ${c.title}`),
      Math.floor(computeAvailableInput(env.budget, this.reserve(env.budget)) * 0.25)
    ).text;

    const { content: relevantContent, label: promptLabel } = getRelevantContent(context, novel.chapters);
    const charLimit = useUIStore.getState().graphCharacterLimit ?? 50;

    context.onStatus?.("正在准备分析数据...");

    // 尝试两次：第一次正常生成，第二次带上错误反馈
    let lastError: string | undefined;
    /**
     * 上一发有没有"等于没回话"——只有它有，第二发才关思考重发（口径同 `map-agent`：
     * 空正文与被输出上限切断的半截 JSON 都算，2026-09-28 制作人拍）。
     * 这里同样**故意不用** `askWithThinkingFallback`：第二趟专职"把上一趟的错误带回 prompt 让模型改"，
     * 套 helper 会把两发叠成四发。完整的理由与实测数据记在 `map-agent.ts` 那两只 flag 上。
     */
    let sawEmptyBody = false;
    let sawTruncated = false;

    for (let attempt = 1; attempt <= 2; attempt++) {
      // 取消之后不再进第二次尝试。这道守卫在浏览器层量不出来——已 abort 的 fetch 到不了
      // 厂商，第二发当场就失败，所以 e2e 只会看到"结果没落库"；真正的形状是重试分支把
      // 取消当成一次普通失败：再走一遍完整装配、再刷一次状态文案。判据在单测层钉
      // （signal 已 abort 时 provider 一次都不许被调用）
      if (context.signal?.aborted) return { success: false, cancelled: true, error: "操作已取消" };
      try {
        context.onStatus?.(attempt === 1 ? "AI 正在生成分析..." : "AI 正在重新分析...");

        const response = await chatWithContextRetry(env, async (b) => {
          const reserve = this.reserve(b);
          const prompt = buildPrompt(novel, chapterList, relevantContent, promptLabel, charLimit, lastError);
          const est = estimateTokens(prompt);
          const useFb = est >= computeAvailableInput(b, reserve);
          const useP = useFb
            ? `请根据小说《${novel.title}》的章节目录生成人物关系图谱JSON。\n章节目录：\n${chapterList}\n请只输出JSON。`
            : prompt;
          return provider.chat({
            model: "",
            messages: [
              { role: "system", content: "你是一个JSON数据生成器。只输出JSON，不要任何解释文字。" },
              { role: "user", content: useP },
            ],
            // 大 JSON 需要尽量多的输出空间，但不得超过模型自身的输出上限，
            // 否则上限低于 8192 的模型（如 4096 档）会直接 400。
            // 与输入侧 `computeAvailableInput(b, reserve)` 同一个数：分开写就会一个要得多、
            // 一个留得少，严格校验 input+max_tokens≤窗口的服务商必然 400。
            // 用户在设置里填过上限时由它顶开 8192（`resolveOutputReserve`）。
            max_tokens: reserve,
            temperature: 0.3,
            thinking: sawEmptyBody || sawTruncated ? false : undefined,
            signal: context.signal,
          });
        });

        // 厂商说这一发被输出上限切断了 → 与空正文同等对待，第二发关思考重发。
        // 照样先交给解析：截断不一定毁掉整份图（09-23 实测过 4852 字的截断回包仍拼得出可用图谱），
        // 只有解析或校验没过才会走到第二发。
        if (response.truncated) sawTruncated = true;

        // 检查响应内容
        if (!response.content || response.content.trim().length === 0) {
          if (attempt === 1) { sawEmptyBody = true; lastError = "API 返回了空响应"; continue; }
          return { success: false, error: "API 返回了空响应，请检查 API 配置或稍后重试。" };
        }

        // Parse JSON from response
        context.onStatus?.("正在解析分析结果...");
        const graphData = this.parseGraphData(response.content);

        if (!graphData) {
          if (attempt === 1) { lastError = "未能解析到 JSON 数据"; continue; }
          return { success: false, error: "未能从 AI 回复中提取到 JSON 图谱数据，请重试。" };
        }

        // Validate structure（只校验 nodes；边由下方兜底逻辑处理）
        const validationError = this.validateGraphData(graphData);
        if (validationError) {
          if (attempt === 1) { lastError = validationError; continue; }
          return { success: false, error: validationError };
        }

        // 到这里 nodes 已确认为有效非空数组；若边为空或全部引用无效节点，自动生成兜底边
        if (this.allEdgesInvalid(graphData)) {
          graphData.edges = autoGenerateEdges(graphData.nodes);
        }

        return { success: true, data: { graphData }, tokensUsed: response.tokensUsed?.output || response.content.length };
      } catch (err) {
        // 厂商明确拒了这一场（401/402/429）：第二发只会再撞一次同一个答案
        if (classifyVendorRefusal(err)) return { success: false, error: this.formatError(err) };
        if (attempt === 1) {
          // 「路的问题」两样分得开，口径与判法同 `map-agent`（那边 `classifyTransportFailure`
          // 手抄会漏掉真会出现的形状，笔 C 已收进一处）。不接上就是：后端没在跑时
          // 浏览器抛 `Failed to fetch`，图谱把它当一次普通失败 → 再装配一遍、白烧一发。
          const transport = classifyTransportFailure(err);
          if (transport === "unreachable") return { success: false, error: UNREACHABLE_HINT };
          if (transport === "timeout") { lastError = "API 请求超时"; continue; }
          if (isEmptyResultError(err)) sawEmptyBody = true;
          lastError = this.formatError(err);
          continue;
        }
        return { success: false, error: this.formatError(err) };
      }
    }

    return { success: false, error: lastError || "生成失败，请重试。" };
  }

  /**
   * 解析图谱 JSON 数据
   */
  private parseGraphData(content: string): GraphData | null {
    return extractJSON<GraphData>(content);
  }

  /**
   * 判断是否所有边都是无效的（空数组或全部引用不存在的节点）
   */
  private allEdgesInvalid(graphData: GraphData): boolean {
    if (!Array.isArray(graphData.edges) || graphData.edges.length === 0) return true;
    const nodeIds = new Set(graphData.nodes.map((n) => n.id));
    return graphData.edges.every(
      (edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target)
    );
  }

  /**
   * 验证图谱数据结构（会修改输入数据：过滤无效的边、补全缺失字段）
   */
  private validateGraphData(graphData: GraphData): string | null {
    if (!Array.isArray(graphData?.nodes) || graphData.nodes.length === 0) {
      return "图谱数据不完整（nodes 为空或不是数组），请重试。";
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

    // 有边时检查引用有效性
    if (Array.isArray(graphData.edges) && graphData.edges.length > 0) {
      const nodeIds = new Set(graphData.nodes.map((n) => n.id));
      graphData.edges = graphData.edges.filter(
        (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)
      );
    }
    // 边为空时由外层兜底逻辑处理，此处不报错

    return null;
  }

  private formatError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return "未知错误";
  }
}

/**
 * 构建图谱生成提示词
 */
function buildPrompt(
  novel: { title: string },
  chapterList: string,
  relevantContent: string,
  promptLabel: string,
  charLimit: number,
  lastError?: string
): string {
  const errorHint = lastError
    ? `\n\n【上次生成时出错】\n${lastError}\n请修正上述问题，确保 edges 数组不能为空，且每条边的 source 和 target 必须在 nodes 的 id 中存在。\n`
    : "";

  return `你是一位专业的小说人物关系分析专家。请根据以下小说信息，生成人物关系图谱的JSON数据。

**小说：**《${novel.title}》
**章节目录：**
${chapterList}

**${promptLabel}：**
${relevantContent}

请**只输出**一个JSON对象（不要其他任何文字），严格按以下格式，包含 nodes 和 edges 两个数组（示例中用了 4 个节点，实际根据需要生成更多）：

{
  "nodes": [
    {"id": "令狐冲", "group": "主角", "description": "华山派大弟子，性格洒脱不羁"},
    {"id": "任盈盈", "group": "主角", "description": "日月神教圣姑，聪慧深情"},
    {"id": "东方不败", "group": "反派", "description": "日月神教教主，武功天下第一"},
    {"id": "岳不群", "group": "反派", "description": "华山派掌门，表面君子剑"}
  ],
  "edges": [
    {"source": "令狐冲", "target": "任盈盈", "label": "恋人"},
    {"source": "令狐冲", "target": "东方不败", "label": "敌对"},
    {"source": "令狐冲", "target": "岳不群", "label": "师徒"}
  ]
}

要求：
- 识别10-${charLimit}个重要角色
- **每个角色必须包含 description 字段**：用 15-30 字描述角色的身份、性格或关键特征
- **edges 数组不能为空**，至少生成与节点数量相当的关系边
- group 用于分类角色类型，你可以根据小说特点自定义分类，常见的有：主角/配角/反派/导师/恋人/中立/悲剧/幕后黑手/工具人/其他
- label 用于描述人物关系，你可以根据小说特点自定义关系类型，常见的有：亲情/友情/爱情/敌对/师徒/利用/暗恋/仇敌/合作/主仆/同门/邻居/信任/背叛/保护/被保护
- 确保同一类别的值保持一致（如不要同时使用"主角"和"主要角色"）
- 确保所有source和target都在nodes中存在${errorHint}`;
}

// 导出 Agent 实例
export const characterGraphAgent = new CharacterGraphAgent();