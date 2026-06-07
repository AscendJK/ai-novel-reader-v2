import type { Agent, AgentContext, AgentResult } from "./types";

interface ChunkResult {
  chapterId: string;
  chapterTitle: string;
  chunks: { index: number; text: string; estimatedTokens: number }[];
}

export const chunkerAgent: Agent = {
  name: "chunker",
  description: "将小说文本按语义分块，构建索引",

  async run(context: AgentContext): Promise<AgentResult> {
    const { loadNovel } = await import("@/db/repositories");
    const novel = await loadNovel(context.novelId);
    if (!novel) return { success: false, error: "小说数据未找到" };

    const targetChapterIds = context.chapterIds || novel.chapters.map((c) => c.id);
    const chapters = novel.chapters.filter((c) => targetChapterIds.includes(c.id));

    const MAX_CHUNK_CHARS = 4000;
    const OVERLAP_CHARS = 200;
    const results: ChunkResult[] = [];

    for (const chapter of chapters) {
      const chunks: ChunkResult["chunks"] = [];
      const text = chapter.content;

      if (text.length <= MAX_CHUNK_CHARS) {
        chunks.push({
          index: 0,
          text,
          estimatedTokens: Math.ceil(text.length / 2),
        });
      } else {
        let start = 0;
        let idx = 0;

        while (start < text.length) {
          let end = start + MAX_CHUNK_CHARS;

          // Try to break at paragraph boundary
          if (end < text.length) {
            const paraBreak = text.lastIndexOf("\n\n", end);
            if (paraBreak > start + MAX_CHUNK_CHARS / 2) {
              end = paraBreak;
            } else {
              // Try to break at sentence boundary
              const sentBreak = text.lastIndexOf("。", end);
              if (sentBreak > start + MAX_CHUNK_CHARS / 2) {
                end = sentBreak + 1;
              }
            }
          }

          chunks.push({
            index: idx,
            text: text.slice(start, Math.min(end, text.length)),
            estimatedTokens: Math.ceil((end - start) / 2),
          });

          start = end - OVERLAP_CHARS;
          idx++;
        }
      }

      results.push({
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        chunks,
      });
    }

    return {
      success: true,
      data: results,
    };
  },
};
