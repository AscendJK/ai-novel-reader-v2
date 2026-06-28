/**
 * TTS 文本预处理
 * 将小说章节内容分割为适合 TTS 朗读的段落
 * 保留原始段落索引 + 段落分割点用于 UI 逐段高亮
 */

export interface TTSChunk {
  text: string;
  paragraphIndex: number;        // 组内第一段的原始索引（兼容旧字段）
  paragraphIndices: number[];    // 组内所有段落的原始索引
  paragraphBreaks: number[];     // 每个段落在合并文本中的起始字符位置（用于 onboundary 追踪）
}

/**
 * 将章节文本分割为适合 TTS 的段落
 * - 按自然段落分割
 * - 过滤过短段落（< 5 字）
 * - 每个段落独立成 chunk（不合并，移动端 onboundary 不可靠）
 * - 超长段落按句号拆分
 * - 清理特殊字符
 */
export function prepareTextForTTS(content: string, maxChunkLength: number = 300): TTSChunk[] {
  if (!content || content.trim().length === 0) return [];

  // 步骤1: 清洗每个段落，保留原始索引
  const cleaned = content
    .replace(/<[^>]*>/g, "") // 去除 HTML 标签
    .split(/\n+/) // 按换行分割
    .map((p, i) => ({
      text: p
        .replace(/\s+/g, " ") // 合并连续空白
        .replace(/["""]/g, "，") // 引号替换为逗号停顿
        .replace(/[''']/g, "，")
        .replace(/\s*[—–]\s*/g, "，") // 破折号替换为逗号停顿
        .replace(/[《》〈〉]/g, "，") // 书名号替换为逗号停顿
        .trim(),
      index: i,
    }))
    .filter(p => p.text.length >= 5); // 过滤过短段落

  if (cleaned.length === 0) return [];

  // 步骤2: 每个段落独立成 chunk，不合并相邻短段落
  // R13: 移除合并逻辑。预队列机制已消除段落间停顿，且合并段落需要 onboundary
  // 做段内追踪，而移动端 onboundary 对中文文本不可靠。段落高亮改为通过
  // onChunkStart 精确追踪（每个段落独立触发）。
  const chunks: TTSChunk[] = [];

  for (const p of cleaned) {
    if (p.text.length <= maxChunkLength) {
      chunks.push({
        text: p.text,
        paragraphIndex: p.index,
        paragraphIndices: [p.index],
        paragraphBreaks: [0],
      });
    } else {
      // 超长段落按句子边界拆分（保留为同一段落的多个片段）
      const parts = splitBySentence(p.text, maxChunkLength);
      for (const part of parts) {
        chunks.push({
          text: part,
          paragraphIndex: p.index,
          paragraphIndices: [p.index],
          paragraphBreaks: [0],
        });
      }
    }
  }

  return chunks;
}

/**
 * 按句子边界拆分长段落
 * 优先按句号拆分，无标点时按逗号拆分，最后按固定长度截断
 */
function splitBySentence(text: string, maxLength: number): string[] {
  // 按中文句号、问号、叹号、分号分割
  let sentences = text.split(/(?<=[。！？；\n])/);

  // 如果只有一段（无标点），按逗号分割
  if (sentences.length <= 1) {
    sentences = text.split(/(?<=[，,])/);
  }

  const parts: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if ((current + sentence).length > maxLength && current.length > 0) {
      parts.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }

  if (current.trim().length >= 5) {
    // 最终兜底：如果单个 chunk 仍然超长，按固定长度截断
    let remaining = current.trim();
    while (remaining.length > maxLength) {
      parts.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength);
    }
    if (remaining.length >= 5) {
      parts.push(remaining);
    }
  }

  return parts;
}
