/**
 * TTS 文本预处理
 * 将小说章节内容分割为适合 TTS 朗读的段落
 */

/**
 * 将章节文本分割为适合 TTS 的段落
 * - 按自然段落分割
 * - 过滤过短段落（< 5 字）
 * - 超长段落按句号拆分
 * - 清理特殊字符
 */
export function prepareTextForTTS(content: string, maxChunkLength: number = 300): string[] {
  if (!content || content.trim().length === 0) return [];

  return content
    .split(/\n\n+/) // 按空行分割
    .map(p =>
      p
        .replace(/\s+/g, " ") // 合并连续空白
        .replace(/[""]/g, "") // 去除中文引号
        .replace(/['']/g, "") // 去除中文单引号
        .replace(/\s*[—–]\s*/g, "，") // 破折号转逗号
        .trim()
    )
    .filter(p => p.length >= 5) // 过滤过短段落
    .flatMap(p =>
      p.length > maxChunkLength ? splitBySentence(p, maxChunkLength) : [p]
    );
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

  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if ((current + sentence).length > maxLength && current.length > 0) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }

  if (current.trim().length >= 5) {
    // 最终兜底：如果单个 chunk 仍然超长，按固定长度截断
    let remaining = current.trim();
    while (remaining.length > maxLength) {
      chunks.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength);
    }
    if (remaining.length >= 5) {
      chunks.push(remaining);
    }
  }

  return chunks;
}
