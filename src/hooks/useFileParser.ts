import { useState, useCallback, useRef } from "react";
import { parseTxt } from "@/parsers/txt";
import { parseEpub } from "@/parsers/epub";
import { createNovel } from "@/parsers/utils";
import { saveNovel } from "@/db/repositories";
import { useNovelStore } from "@/stores/novel-store";
import { apiFetch } from "@/lib/api-client";
import { showToast } from "@/lib/toast-store";
import { clearCache } from "@/rag/index";
import type { Novel } from "@/parsers/types";

// 文件大小限制
const FILE_SIZE_WARNING = 10 * 1024 * 1024; // 10MB
const FILE_SIZE_LIMIT = 100 * 1024 * 1024; // 100MB

/**
 * 格式化文件大小
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function useFileParser() {
  const [isParsing, setIsParsing] = useState(false);
  const parseCountRef = useRef(0);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const addNovel = useNovelStore((s) => s.addNovel);

  const parseFile = useCallback(async (file: File): Promise<Novel | null> => {
    setIsParsing(true);
    parseCountRef.current++;
    setProgress(0);
    setError(null);
    setWarning(null);

    try {
      // 检查文件大小
      if (file.size > FILE_SIZE_LIMIT) {
        throw new Error(`文件太大（${formatFileSize(file.size)}），最大支持 ${formatFileSize(FILE_SIZE_LIMIT)}`);
      }
      if (file.size > FILE_SIZE_WARNING) {
        setWarning(`文件较大（${formatFileSize(file.size)}），解析可能需要较长时间`);
      }

      const ext = file.name.split(".").pop()?.toLowerCase();
      let result;

      if (ext === "epub") {
        setProgress(30);
        result = await parseEpub(file);
      } else if (ext === "txt" || !ext) {
        setProgress(30);
        result = await parseTxt(file);
      } else {
        throw new Error(`不支持的文件格式: .${ext}。当前支持 .txt 和 .epub 格式。`);
      }

      setProgress(70);

      const novel = createNovel(
        result,
        file.name,
        (ext === "epub" ? "epub" : "txt") as "txt" | "epub"
      );

      setProgress(90);
      await saveNovel(novel);

      // 内容变更后清除旧的 RAG 缓存（重新上传同 ID 小说时避免使用过期索引）
      try {
        clearCache(novel.id);
      } catch (e) { console.warn("[useFileParser] 清除 RAG 缓存失败:", e); }

      // Upload to server + auto-join (await + retry, 修复根因2：fir-and-forget 导致小说未达服务器)
      const uploadToServer = async (retries = 2): Promise<boolean> => {
        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            const r = await apiFetch(`/api/novels`, {
              method: "POST",
              body: JSON.stringify({
                novel: {
                  id: novel.id, title: novel.title, author: novel.author,
                  fileName: novel.fileName, fileFormat: novel.fileFormat,
                  totalChars: novel.totalChars, chapterCount: novel.chapterCount,
                  createdAt: novel.createdAt,
                },
                chapters: novel.chapters.map((c) => ({
                  id: c.id, novelId: c.novelId, index: c.index,
                  title: c.title, content: c.content,
                  startOffset: c.startOffset, endOffset: c.endOffset,
                })),
              }),
            });
            if (!r?.ok) {
              console.error(`[upload] ${novel.title} attempt ${attempt}/${retries} failed: HTTP ${r?.status}`);
              if (attempt < retries) await new Promise(r => setTimeout(r, 2000));
              continue;
            }
            const data = await r.json();
            const nid = data.novelId;
            if (!nid) {
              console.error(`[upload] ${novel.title}: no novelId in response`);
              if (attempt < retries) await new Promise(r => setTimeout(r, 2000));
              continue;
            }
            // Auto-join
            try {
              const jr = await apiFetch(`/api/novels/${nid}/join`, { method: "POST" });
              if (!jr?.ok) console.error(`[upload] ${novel.title} join failed: HTTP ${jr?.status}`);
            } catch (e) {
              console.error(`[upload] ${novel.title} join error:`, e);
            }
            return true;
          } catch (e) {
            console.error(`[upload] ${novel.title} attempt ${attempt}/${retries} error:`, e);
            if (attempt < retries) await new Promise(r => setTimeout(r, 2000));
          }
        }
        return false;
      };
      const uploaded = await uploadToServer();
      if (!uploaded) {
        console.warn(`[upload] ${novel.title} all retries exhausted, data will sync when server becomes available`);
        showToast("小说已保存到本地，上传到服务器失败，将在有网络时自动同步", "warn");
      }

      setProgress(100);
      addNovel(novel);
      return novel;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "文件解析失败";
      setError(msg);
      return null;
    } finally {
      parseCountRef.current--;
      if (parseCountRef.current <= 0) setIsParsing(false);
    }
  }, [addNovel]);

  return { parseFile, isParsing, progress, error, warning };
}
