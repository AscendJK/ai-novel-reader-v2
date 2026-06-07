/**
 * 小说地图生成 Agent
 * 直接让 AI 根据小说名字和章节目录生成地图数据
 */

import type { AgentContext, AgentResult, MapData } from "./types";
import type { AgentEnvironment } from "./base-agent";
import { BaseAgent } from "./base-agent";

/**
 * 地图生成 Agent
 */
class MapAgent extends BaseAgent {
  name = "map-generator";
  description = "生成小说地图，分析地理位置和势力分布";

  protected async execute(context: AgentContext, env: AgentEnvironment): Promise<AgentResult> {
    const { novel, provider, budget } = env;

    // 1. 构建章节目录
    context.onStatus?.("正在准备分析数据...");
    const chapterList = novel.chapters
      .map((c, i) => `${i + 1}. ${c.title}`)
      .join("\n");

    // 2. 构建提示词（不使用 RAG 检索）
    const prompt = this.buildPrompt(novel, chapterList);

    // 4. 调用 AI
    context.onStatus?.("AI 正在生成分析...");
    let response;
    try {
      response = await provider.chat({
        model: "",
        messages: [
          { role: "system", content: "你是一个 JSON 数据生成器。只输出 JSON，不要任何解释文字。" },
          { role: "user", content: prompt },
        ],
        max_tokens: 16384,
        temperature: 0.3,
        signal: context.signal,
      });
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes("CORS") || err.message.includes("blocked")) {
          return { success: false, error: "API 请求被 CORS 策略阻止，请检查 API 地址是否正确，或尝试使用支持代理的 API。" };
        }
        if (err.message.includes("524") || err.message.includes("timeout") || err.message.includes("超时")) {
          return { success: false, error: "API 请求超时（524），可能是网络问题或 API 服务器响应过慢，请稍后重试。" };
        }
      }
      throw err;
    }

    // 检查响应内容
    if (!response.content || response.content.trim().length === 0) {
      return { success: false, error: "API 返回了空响应，请检查 API 配置或稍后重试。" };
    }

    // 5. 解析和验证
    context.onStatus?.("正在解析分析结果...");
    const mapData = this.parseMapData(response.content);
    if (!mapData) {
      return { success: false, error: "未能从 AI 响应中解析有效的地图数据。请检查 API 是否正常工作，或尝试使用其他模型。" };
    }

    // 6. 验证数据结构
    const validationError = this.validateMapData(mapData);
    if (validationError) {
      return { success: false, error: validationError };
    }

    return {
      success: true,
      data: { mapData },
      tokensUsed: response.tokensUsed.total,
    };
  }

  /**
   * 构建提示词
   */
  private buildPrompt(
    novel: { title: string; author?: string },
    chapterList: string
  ): string {
    return `你是专业小说地理地图解析Agent，专为小说生成可渲染的结构化地图JSON。
请根据小说《${novel.title}》${novel.author ? `（作者：${novel.author}）` : ""}的书名、作者与章节目录，结合小说题材、公开世界观设定及章节信息，自主推演、构建一套完整且逻辑自洽的地理与势力体系，生成标准地图数据。
若该小说无公开设定，则结合题材风格原创贴合剧情的世界观。

---
【一、强制规则：必须100%严格遵守，不可改动】
1. 层级规则
- level=1 为世界观最高级地理单元（世界/大陆/天下/位面）
- level 数字越大，代表地理范围越小
- 子地点 level 必须严格大于父地点 level
- 整体必须形成 level1 → level2 → level3 逐级嵌套的树形结构，禁止全部节点扁平挂载
- 最少生成 3 个层级（level1、level2、level3），可根据需要生成更多层级

2. 父子关系规则
- 顶级地理单元（level1）parentId 设为空字符串
- 所有非顶级地点必须绑定唯一合法 parentId
- 父节点必须是已存在、层级数字更小的地点

3. 坐标规则（坐标区间固定 0~1000）
- 地图全局中心坐标：(500,500)
- 方位映射：东→X增大，西→X减小；南→Y增大，北→Y减小
- 按地理片区、疆域范围规划坐标：二级大区域均匀分布在中心四周，区分方位；三级及以下地点落在所属父级周边，同片区点位合理分散，杜绝大量重叠；整体版图疏密自然、方位符合常规认知。
- 同一区域内的地点坐标应保持至少 50 单位的间距，避免重叠
- 坐标使用整数，不要使用小数
- 不同层级的坐标间距要求：level 2 与 level 3 之间至少 100 单位间距，level 1 与 level 2 之间至少 200 单位间距

4. ID 规则（非常重要！）
- ID 必须全局唯一，推荐使用纯数字（1, 2, 3...）或英文+数字组合
- 禁止使用中文作为 ID
- 同名不同地点区分ID，语义相近的同一地点统一为单一条目
- parentId 和 places 中引用的 ID 必须与地点 id 完全一致，不得有任何差异
- 生成完成后请自行检查：所有 parentId 是否都在 places.id 中存在，所有 forces.places 和 regions.places 引用的 ID 是否都在 places.id 中存在

5. 地点类型限制
- 只生成人工建筑和行政区划：城市、关隘、渡口、要塞、都城、州郡等
- 不生成自然地理元素：河流、山脉、湖泊、海洋等自然地形不作为独立地点
- 地点类型应与剧情相关，只包含故事中出现或提及的地点

---
【二、自主发挥区域：结合小说内容自由设计】
基于书名、目录、题材自主完成以下内容，风格贴合原作世界观：
- 地点类型 type：自定义，如城市、宗门、山脉、秘境、关隘、渡口、部落等
- 地点描述 description：结合剧情、地理特征撰写简介
- 重要程度 importance：取值 1-10，章节高频出现、剧情核心地标打分偏高
- 势力归属 affiliation：梳理王国、宗门、家族、联盟等归属关系
- 地理区域 regions：按地理位置、疆域片区自主划分分组
- 势力体系 forces：提取/创建小说内所有势力，定义势力类型与管辖范围

---
【三、内容体量要求】
- 根据小说规模生成 20-50 个地点
- 优先提取章节目录中出现的地名、势力名作为核心点位
- 确保覆盖所有重要地标、城市、山脉、河流、关隘
- 仅保留剧情相关有效地点，不生成冗余临时点位
- 势力数量根据小说实际设定，不少于 3 个

---
【四、输出格式强制要求】
章节目录：
${chapterList}

仅输出纯JSON字符串，禁止任何解释、备注、换行说明、Markdown、多余话术。
字段严格匹配下方结构：数值类型使用纯数字，空内容填空字符串，空集合填空数组，不增、不减、不改字段名。

{
  "layers": [
    {
      "level": 1,
      "name": "",
      "description": ""
    }
  ],
  "places": [
    {
      "id": "",
      "name": "",
      "type": "",
      "level": 1,
      "parentId": "",
      "description": "",
      "importance": 5,
      "x": 500,
      "y": 500,
      "affiliation": ""
    }
  ],
  "regions": [
    {
      "name": "",
      "places": []
    }
  ],
  "forces": [
    {
      "id": "",
      "name": "",
      "type": "",
      "places": []
    }
  ]
}`;
  }

  /**
   * 解析地图数据
   */
  private parseMapData(content: string): MapData | null {
    let raw = content.trim();
    // 移除 markdown 代码块
    raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```[\s\S]*$/i, "");

    // 尝试直接解析
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.warn("[MapAgent] 直接 JSON 解析失败，尝试修复截断的 JSON:", e);

      // 尝试修复截断的 JSON
      const fixed = this.fixTruncatedJson(raw);
      if (fixed) {
        try {
          return JSON.parse(fixed);
        } catch (e2) {
          console.warn("[MapAgent] 修复后的 JSON 解析失败:", e2);
        }
      }

      // 尝试提取 JSON 对象（考虑字符串中的括号）
      const start = raw.indexOf("{");
      if (start >= 0) {
        let depth = 0;
        let inString = false;
        let escapeNext = false;
        for (let i = start; i < raw.length; i++) {
          const char = raw[i];
          if (escapeNext) {
            escapeNext = false;
            continue;
          }
          if (char === "\\") {
            escapeNext = true;
            continue;
          }
          if (char === '"') {
            inString = !inString;
            continue;
          }
          if (inString) continue;
          if (char === "{") depth++;
          else if (char === "}") depth--;
          if (depth === 0) {
            try {
              return JSON.parse(raw.slice(start, i + 1));
            } catch (e3) {
              console.warn("[MapAgent] 提取的 JSON 解析失败:", e3);
            }
            break;
          }
        }
      }
    }
    console.warn("[MapAgent] 无法从 AI 响应中解析 JSON，原始内容:", content.slice(0, 500));
    return null;
  }

  /**
   * 修复截断的 JSON
   */
  private fixTruncatedJson(json: string): string | null {
    try {
      // 找到最后一个完整的位置
      let lastValidPos = json.length;

      // 从后往前找，尝试找到最后一个有效的 JSON 位置
      for (let i = json.length - 1; i >= 0; i--) {
        const char = json[i];
        if (char === '"' || char === "'" || char === ',' || char === ':') {
          // 这些字符后面可能有不完整的内容
          lastValidPos = i;
        } else if (char === '}' || char === ']') {
          // 这是完整的结束符号
          lastValidPos = i + 1;
          break;
        }
      }

      // 截取到最后一个有效位置
      let truncated = json.slice(0, lastValidPos);

      // 统计未闭合的括号
      let openBraces = 0;
      let openBrackets = 0;
      let inString = false;
      let escapeNext = false;

      for (const char of truncated) {
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        if (char === '\\') {
          escapeNext = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;

        if (char === '{') openBraces++;
        else if (char === '}') openBraces--;
        else if (char === '[') openBrackets++;
        else if (char === ']') openBrackets--;
      }

      // 闭合未闭合的括号
      let fixed = truncated;
      for (let i = 0; i < openBrackets; i++) {
        fixed += ']';
      }
      for (let i = 0; i < openBraces; i++) {
        fixed += '}';
      }

      // 验证修复后的 JSON
      JSON.parse(fixed);
      console.log("[MapAgent] 成功修复截断的 JSON");
      return fixed;
    } catch {
      return null;
    }
  }

  /**
   * 验证地图数据结构（会修改输入数据：修复无效的 parentId、过滤无效引用）
   */
  private validateMapData(mapData: MapData): string | null {
    // 检查必要字段
    if (!Array.isArray(mapData.layers) || mapData.layers.length === 0) {
      return "layers 为空或不是数组";
    }

    if (!Array.isArray(mapData.places) || mapData.places.length === 0) {
      return "places 为空或不是数组";
    }

    if (!Array.isArray(mapData.regions)) {
      return "regions 不是数组";
    }

    if (!Array.isArray(mapData.forces)) {
      return "forces 不是数组";
    }

    // 验证层级结构
    const level1Count = mapData.layers.filter(l => l.level === 1).length;
    if (level1Count !== 1) {
      return `level 1 必须唯一，当前有 ${level1Count} 个`;
    }
    for (const layer of mapData.layers) {
      if (!layer.level || !layer.name) {
        return `层级缺少 level 或 name: ${JSON.stringify(layer)}`;
      }
    }

    // 验证地点 ID 唯一性
    const placeIds = new Set<string>();
    for (const place of mapData.places) {
      if (!place.id || !place.name) {
        return `地点缺少 id 或 name: ${JSON.stringify(place)}`;
      }
      if (placeIds.has(place.id)) {
        return `地点 ID 重复: ${place.id}`;
      }
      placeIds.add(place.id);
    }

    // 验证地点层级和父子关系
    for (const place of mapData.places) {
      if (!place.level || place.level < 1) {
        return `地点 ${place.name} 的 level 无效: ${place.level}`;
      }
      if (place.level > 1 && !place.parentId) {
        return `地点 ${place.name} 的 level > 1 但没有 parentId`;
      }
      // 自动修复无效的 parentId
      if (place.parentId && !placeIds.has(place.parentId)) {
        console.warn(`[MapAgent] 地点 ${place.name} 的 parentId 不存在: ${place.parentId}，自动清空`);
        place.parentId = "";
        place.level = 1; // 降级为顶级地点
      }
      if (place.x < 0 || place.x > 1000 || place.y < 0 || place.y > 1000) {
        return `地点 ${place.name} 的坐标超出范围: (${place.x}, ${place.y})`;
      }
    }

    // 验证势力引用的地点（自动过滤无效引用）
    for (const force of mapData.forces) {
      if (!force.id || !force.name) {
        return `势力缺少 id 或 name: ${JSON.stringify(force)}`;
      }
      force.places = (force.places || []).filter(id => {
        if (!placeIds.has(id)) {
          console.warn(`[MapAgent] 势力 ${force.name} 引用了不存在的地点: ${id}，已过滤`);
          return false;
        }
        return true;
      });
    }

    // 验证区域引用的地点（自动过滤无效引用）
    for (const region of mapData.regions) {
      if (!region.name) {
        return `区域缺少 name: ${JSON.stringify(region)}`;
      }
      region.places = (region.places || []).filter(id => {
        if (!placeIds.has(id)) {
          console.warn(`[MapAgent] 区域 ${region.name} 引用了不存在的地点: ${id}，已过滤`);
          return false;
        }
        return true;
      });
    }

    return null;
  }
}

// 导出 Agent 实例
export const mapAgent = new MapAgent();
