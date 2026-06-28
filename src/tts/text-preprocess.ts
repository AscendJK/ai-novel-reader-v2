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
 * - 合并相邻短段落减少 utterance 数量
 * - 超长段落按句号拆分
 * - 清理特殊字符
 * - paragraphBreaks 供移动端基于时间估算的段落追踪回退
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

  // 步骤2: 合并相邻短段落（合计 < 150 字），记录段落分割点
  interface MergedGroup {
    text: string;
    indices: number[];
    breaks: number[]; // 每个段落在 text 中的起始字符位置
  }
  const merged: MergedGroup[] = [];
  let buffer = "";
  let bufferIndices: number[] = [];
  let bufferBreaks: number[] = [0];

  for (const p of cleaned) {
    if (buffer.length > 0 && buffer.length + p.text.length + 1 < 150) {
      // 合并到当前缓冲区
      bufferBreaks.push(buffer.length + 1); // +1 for "。" separator
      bufferIndices.push(p.index);
      buffer += "。" + p.text;
    } else {
      // 输出当前缓冲区
      if (buffer.length > 0) {
        merged.push({ text: buffer, indices: [...bufferIndices], breaks: [...bufferBreaks] });
      }
      buffer = p.text;
      bufferIndices = [p.index];
      bufferBreaks = [0];
    }
  }
  if (buffer.length > 0) {
    merged.push({ text: buffer, indices: [...bufferIndices], breaks: [...bufferBreaks] });
  }

  // 步骤3: 拆分超长段落（拆分后的各片段共享同一组段落索引）
  const chunks: TTSChunk[] = [];
  for (const m of merged) {
    if (m.text.length <= maxChunkLength) {
      chunks.push({
        text: m.text,
        paragraphIndex: m.indices[0],
        paragraphIndices: m.indices,
        paragraphBreaks: m.breaks,
      });
    } else {
      // 长段落拆分：按句子边界切分
      const parts = splitBySentence(m.text, maxChunkLength);
      // 计算每个 part 覆盖哪些段落
      let charOffset = 0;
      for (const part of parts) {
        const partStart = charOffset;
        const partEnd = charOffset + part.length;
        // 找到起始和结束的段落索引
        let startPara = 0;
        let endPara = m.breaks.length - 1;
        for (let i = 0; i < m.breaks.length; i++) {
          if (m.breaks[i] <= partStart) startPara = i;
          if (m.breaks[i] < partEnd) endPara = i;
        }
        const indices = m.indices.slice(startPara, endPara + 1);
        const breaks = m.breaks.slice(startPara, endPara + 1).map(b => b - partStart);
        chunks.push({
          text: part,
          paragraphIndex: indices[0],
          paragraphIndices: indices,
          paragraphBreaks: breaks,
        });
        charOffset += part.length;
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
