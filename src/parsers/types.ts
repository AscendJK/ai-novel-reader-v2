export interface Chapter {
  id: string;
  novelId: string;
  index: number;
  title: string;
  content: string;
  startOffset: number;
  endOffset: number;
}

export interface NovelMeta {
  id: string;
  title: string;
  author?: string;
  fileName: string;
  fileFormat: "txt" | "epub";
  totalChars: number;
  chapterCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface Novel extends NovelMeta {
  chapters: Chapter[];
}

export interface ParseResult {
  title: string;
  author?: string;
  chapters: { title: string; content: string }[];
  totalChars: number;
}

export interface ParserOptions {
  encoding?: string;
  onProgress?: (percent: number) => void;
}
