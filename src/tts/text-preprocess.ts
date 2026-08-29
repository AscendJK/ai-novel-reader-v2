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
 * 由 chunks 构建“过滤后保留的原始段落索引”有序数组。
 * 进度条/段数显示/seek 统一用该数组中的位置（过滤后序号，0-based）作为坐标，
 * 与正文高亮使用的原始段落索引解耦，避免过滤短段落后出现 90/80 段、进度 >100% 的错位。
 */
export function buildOrderedParaIndices(chunks: TTSChunk[]): number[] {
  return chunks.flatMap(c => c.paragraphIndices);
}

/**
 * 按“原始段落索引”定位所在 chunk。
 * 优先匹配包含该段落的 chunk（组内任意段）；找不到（如段落已被过滤）时
 * 回退到第一个起点 >= paraIndex 的 chunk；再无则回退最后一个。
 * 用于位置恢复 / seek 跳转：避免只用组内第一段比较导致跳到下一组丢句。
 */
export function findChunkIndexByPara(chunks: TTSChunk[], paraIndex: number): number {
  if (chunks.length === 0) return -1;
  // 1) 包含该段落的 chunk（paraIndex 落在 [组首, 组尾] 区间内）
  const contain = chunks.findIndex(c =>
    paraIndex >= c.paragraphIndex &&
    paraIndex <= c.paragraphIndices[c.paragraphIndices.length - 1]
  );
  if (contain >= 0) return contain;
  // 2) 回退：第一个起点 >= paraIndex 的 chunk
  const next = chunks.findIndex(c => c.paragraphIndex >= paraIndex);
  if (next >= 0) return next;
  // 3) 兜底：最后一个 chunk
  return chunks.length - 1;
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
    .map((p, i): { text: string; index: number } | null => {
      const text = p
        .replace(/\s+/g, " ") // 合并连续空白
        .replace(/["""]/g, "，") // 引号替换为逗号停顿
        .replace(/[''']/g, "，")
        .replace(/\s*[—–]\s*/g, "，") // 破折号替换为逗号停顿
        .replace(/[《》〈〉]/g, "，") // 书名号替换为逗号停顿
        // 连续标点清理：标点后紧跟的逗号删除（"：，" → "："），与 zipvoice-engine.normalizeText 一致
        .replace(/([，。！？；：、])(\s*，)+/g, "$1")
        .trim();
      // 过滤整段由方括号包裹的装饰性内容（作者的话/网站标记/占位符，
      // 如 "[大家新年好]"、"[本章完]"、"[]"）。这类内容不属于正文，
      // 朗读出来就是正文里的“杂音”。
      if (/^\[[^\[\]]{1,40}\]$/.test(text)) return null;
      return {
        // 删除行内方括号：matcha-tts 词表无此字符（OOV 警告），
        // 且浏览器 TTS 会把 "[" 读成“左方括号”。
        text: text.replace(/[\[\]]/g, ""),
        index: i,
      };
    })
    .filter((p): p is { text: string; index: number } => p !== null && p.text.length >= 5); // 过滤过短段落

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
 * 优先按句号拆分，无标点时按逗号分割；
 * 保证句子完整：单个句子超过 maxLength 时整句独立成一个 chunk（宁超不拆），
 * 不会把一句话硬切成两段朗读。
 */
function splitBySentence(text: string, maxLength: number): string[] {
  // 按中文句号、问号、叹号、分号分割
  let sentences = text.split(/(?<=[。！？；\n])/);

  // 如果只有一段（无句号等），按逗号分割
  if (sentences.length <= 1) {
    sentences = text.split(/(?<=[，,])/);
  }

  const parts: string[] = [];
  let current = "";

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    // 单句超过上限：不硬切，整句独立成一个 chunk（保证句子完整）
    if (sentence.length > maxLength) {
      if (current.trim().length > 0) parts.push(current.trim());
      parts.push(sentence);
      current = "";
      continue;
    }
    if ((current + sentence).length > maxLength && current.length > 0) {
      parts.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }

  if (current.trim().length >= 5) {
    parts.push(current.trim());
  }

  return parts;
}
