/**
 * JSON 提取工具 — 从 AI 响应中提取结构化 JSON 数据
 * 提取自 graph-agent.ts 和 map-agent.ts 中的重复逻辑
 */

/**
 * 从 AI 响应内容中提取 JSON 对象
 * 支持：markdown 代码块包裹、注释、尾逗号、平衡花括号提取、截断修复
 *
 * @param content AI 原始响应文本
 * @param options 选项
 * @returns 解析后的对象，失败返回 null
 */
export function extractJSON<T = unknown>(
  content: string,
  options?: {
    /** 尝试修复截断的 JSON（map-agent 场景，AI 输出可能被 max_tokens 截断） */
    fixTruncated?: boolean;
  }
): T | null {
  let raw = content.trim();

  // 移除 markdown 代码块包裹（```json ... ``` 或 ``` ... ```）
  raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```[\s\S]*$/i, "");

  // 移除单行注释（// ...）
  raw = raw.replace(/\/\/.*$/gm, "");

  // 移除尾逗号（,} 或 ,]）
  raw = raw.replace(/,\s*([}\]])/g, "$1");

  // 策略1：直接解析
  try {
    return JSON.parse(raw) as T;
  } catch { /* not valid JSON */ }

  // 策略2：尝试修复截断的 JSON（仅在启用时）
  if (options?.fixTruncated) {
    const fixed = fixTruncatedJson(raw);
    if (fixed) {
      try {
        return JSON.parse(fixed) as T;
      } catch { /* fix didn't help */ }
    }
  }

  // 策略3：提取第一个平衡的 JSON 对象（考虑字符串内的括号）
  const extracted = extractBalancedJSON(raw);
  if (extracted) {
    try {
      return JSON.parse(extracted) as T;
    } catch { /* extracted content is not valid JSON */ }
  }

  return null;
}

/**
 * 从文本中提取第一个平衡的 JSON 对象
 * 正确处理字符串内的花括号（转义和未转义）
 *
 * @param text 原始文本
 * @returns JSON 字符串，未找到返回 null
 */
function extractBalancedJSON(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

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
      return text.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * 尝试修复被截断的 JSON
 * 从后往前找到最后一个完整位置，然后闭合所有未闭合的括号
 *
 * @param json 截断的 JSON 字符串
 * @returns 修复后的 JSON 字符串，无法修复返回 null
 */
function fixTruncatedJson(json: string): string | null {
  try {
    // 从后往前找，尝试找到最后一个有效的 JSON 位置
    let lastValidPos = json.length;

    for (let i = json.length - 1; i >= 0; i--) {
      const char = json[i];
      if (char === '"' || char === "'" || char === "," || char === ":") {
        // 这些字符后面可能有不完整的内容
        lastValidPos = i;
      } else if (char === "}" || char === "]") {
        // 这是完整的结束符号
        lastValidPos = i + 1;
        break;
      }
    }

    // 截取到最后一个有效位置
    const truncated = json.slice(0, lastValidPos);

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
      if (char === "\\") {
        escapeNext = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (char === "{") openBraces++;
      else if (char === "}") openBraces--;
      else if (char === "[") openBrackets++;
      else if (char === "]") openBrackets--;
    }

    // 闭合未闭合的括号
    let fixed = truncated;
    for (let i = 0; i < openBrackets; i++) {
      fixed += "]";
    }
    for (let i = 0; i < openBraces; i++) {
      fixed += "}";
    }

    // 验证修复后的 JSON 是否有效
    JSON.parse(fixed);
    return fixed;
  } catch {
    return null;
  }
}
