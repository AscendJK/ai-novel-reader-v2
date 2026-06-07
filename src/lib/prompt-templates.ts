export function buildChapterSummaryPrompt(chapterTitle: string, chapterContent: string): string {
  return `你是一位专业的小说分析助手。请对以下小说章节进行深度总结，要求：

1. **核心情节**（2-3句话概括本章发生的主要事件）
2. **关键人物**（列出本章出现的主要角色及其行为）
3. **重要伏笔**（如果有的话，指出本章埋下的伏笔或悬念）
4. **主题发展**（本章对小说主题的推进作用）

请用简洁清晰的中文回答，总字数控制在 300-500 字。

章节标题：${chapterTitle}

章节内容：
${chapterContent}`;
}
