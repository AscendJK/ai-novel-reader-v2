import { useCallback, useRef, useState, useEffect, useMemo } from "react";
import { Upload, BookOpen, FolderOpen, FileText, Search, Loader2 } from "lucide-react";
import { useFileParser } from "@/hooks/useFileParser";
import { useNovelStore, getLastOpenedTimes } from "@/stores/novel-store";
import { loadAllNovelMeta, deleteNovel, loadNovel } from "@/db/repositories";
import { sharedDB, getUserDB } from "@/db/database";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCharCount } from "@/lib/text-utils";
import { useBuildStore } from "@/stores/build-store";
import { useRAGStore } from "@/stores/rag-store";
import { useUIStore } from "@/stores/ui-store";
import { ensureModelReady } from "@/rag/model-loader";
import { resolveModelKey } from "@/rag/engines";
import { apiFetch } from "@/lib/api-client";
import { buildAndPollRAGIndex, downloadAndCacheIndex } from "@/rag/build-index";
import { onCacheEviction } from "@/rag/rag-cache-utils";
import { NovelBuildWindow } from "@/components/common/NovelBuildWindow";
import { NovelCard } from "./NovelCard";
import type { NovelMeta } from "@/parsers/types";

/** 服务器返回的小说数据类型 */
interface ServerNovel {
  id: string;
  title: string;
  author?: string;
  fileName: string;
  fileFormat: string;
  totalChars: number;
  chapterCount: number;
  createdAt: number;
  updatedAt: number;
  joined?: boolean;
}

export function BookSelect() {
  const { parseFile, isParsing, progress, warning: parseWarning } = useFileParser();
  const setCurrentNovel = useNovelStore((s) => s.setCurrentNovel);
  const readingPositions = useNovelStore((s) => s.readingPositions);
  const addNovel = useNovelStore((s) => s.addNovel);
  const [savedNovels, setSavedNovels] = useState<NovelMeta[]>([]);
  const [serverNovels, setServerNovels] = useState<ServerNovel[]>([]);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const buildPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [batchParsing, setBatchParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // 订阅构建状态变化，触发重渲染
  const builds = useBuildStore((state) => state.builds);

  // Cleanup build polling on unmount
  useEffect(() => {
    return () => { if (buildPollRef.current) clearInterval(buildPollRef.current); };
  }, []);

  useEffect(() => {
    // 只有在用户登录后才加载数据
    const username = localStorage.getItem("sync-username");
    if (!username) return;

    loadAllNovelMeta().then((novels) => {
      const lastOpened = getLastOpenedTimes();
      novels.sort((a, b) => (lastOpened[b.id] || 0) - (lastOpened[a.id] || 0));
      setSavedNovels(novels);
    }).catch((err) => {
      console.error("loadAllNovelMeta failed:", err);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredNovels = useMemo(() => {
    if (!searchQuery.trim()) return savedNovels;
    const q = searchQuery.toLowerCase();
    return savedNovels.filter((n) =>
      n.title.toLowerCase().includes(q) ||
      (n.author?.toLowerCase().includes(q)) ||
      n.fileName.toLowerCase().includes(q)
    );
  }, [savedNovels, searchQuery]);

  const [serverScanned, setServerScanned] = useState(false);
  const [scanning, setScanning] = useState(false);
  const engine = useRAGStore((s) => s.engine);
  const cachedKeys = useRAGStore((s) => s.cachedKeys);
  const lruKeys = useRAGStore((s) => s.lruKeys);
  const offlineMode = useUIStore((s) => s.offlineMode);
  const addCachedKey = useRAGStore((s) => s.addCachedKey);
  const [buildingKeys, setBuildingKeys] = useState<Set<string>>(new Set());
  const [buildStatuses, setBuildStatuses] = useState<Record<string, Record<string, any>>>({});

  // Scan ragCache when novel count changes (new novel added or novel deleted)
  const prevNovelCountRef = useRef(savedNovels.length);
  useEffect(() => {
    if (savedNovels.length === prevNovelCountRef.current) return;
    prevNovelCountRef.current = savedNovels.length;
    const ids = savedNovels.map((n) => n.id);
    if (!ids.length) return;
    (async () => {
      try {
        const all = await sharedDB.ragCache.toArray();
        const novelIdSet = new Set(ids);
        let totalBytes = 0;
        for (const entry of all) {
          if (novelIdSet.has(entry.novelId) && entry.vectorsBuffer) {
            addCachedKey(entry.id);
          }
          if (entry.vectorsBuffer && entry.dim && entry.chunkCount) {
            totalBytes += entry.chunkCount * entry.dim * 4;
            if (entry.chunks && entry.chunks.length > 0) {
              totalBytes += entry.chunks.reduce((s: number, c: { content?: string }) => s + (c.content?.length || 0) * 2, 0);
            }
            if (entry.extraData) {
              totalBytes += entry.extraData.length * 2;
            }
          }
        }
        useRAGStore.getState().updateRagCacheSize(totalBytes);
      } catch { /* ignore */ }
    })();
  }, [savedNovels, addCachedKey]);

  // Poll build statuses for ALL engines (so switching engines shows correct state)
  useEffect(() => {
    const ids = savedNovels.map((n) => n.id);
    if (!ids.length) return;
    let active = true;
    const poll = async () => {
      try {
        if (!localStorage.getItem("sync-token") || useUIStore.getState().offlineMode) return;
        const resp = await apiFetch(`/api/rag/statuses/all?ids=${ids.join(",")}`);
        if (!active || !resp.ok) return;
        const statuses = await resp.json();
        setBuildStatuses(statuses);

        // 同步更新 Zustand store（用于构建状态窗口显示）
        const buildStore = useBuildStore.getState();
        for (const [novelId, engines] of Object.entries(statuses) as [string, Record<string, any>][]) {
          for (const [engine, st] of Object.entries(engines)) {
            if (st && typeof st === "object" && st.status) {
              const existing = buildStore.getBuildStatus(novelId, engine);
              const isBuilding = st.status === "building" || st.status === "loading" || st.status === "encoding" || st.status === "queued";
              const isDone = st.status === "ready" || st.status === "done";
              const isError = st.status === "error";

              // 如果 Zustand store 中没有这个构建状态，且服务器显示正在构建中，则添加
              if (!existing && isBuilding) {
                buildStore.startBuild(novelId, engine);
                buildStore.updateProgress(novelId, engine, {
                  status: st.status as any,
                  message: st.message || "正在构建...",
                  current: st.current || 0,
                  total: st.total || 0,
                  queuePosition: st.queuePosition,
                });
              } else if (existing) {
                // 更新现有状态
                if (isBuilding) {
                  buildStore.updateProgress(novelId, engine, {
                    status: st.status as any,
                    message: st.message || "正在构建...",
                    current: st.current || 0,
                    total: st.total || 0,
                    queuePosition: st.queuePosition,
                  });
                } else if (isDone && existing.status !== "done" && existing.status !== "ready") {
                  buildStore.finishBuild(novelId, engine);
                } else if (isError && existing.status !== "error") {
                  buildStore.failBuild(novelId, engine, st.error || "构建失败");
                }
              }
            }
          }
        }

        // Clear building keys that are now ready or errored
        setBuildingKeys(prev => {
          const next = new Set(prev);
          for (const key of prev) {
            const [nid, eng] = key.split(";");
            const st = statuses[nid]?.[eng];
            if (st && (st.status === "ready" || st.status === "error")) {
              next.delete(key);
            }
          }
          return next.size === prev.size ? prev : next;
        });
      } catch { /* server unreachable */ }
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [savedNovels]);

  // Auto-download indexes that are ready on server but missing from local cache
  const downloadingRef = useRef<Set<string>>(new Set());
  // 跟踪被淘汰的索引，防止缓存抖动（下载→淘汰→下载→淘汰...）
  const evictedKeysRef = useRef<Set<string>>(new Set());
  const prevEngineRef = useRef(engine);
  useEffect(() => {
    const unsub = onCacheEviction((evicted) => {
      for (const e of evicted) evictedKeysRef.current.add(e.id);
    });
    return unsub;
  }, []);
  // 切换引擎时清空淘汰记录（不同引擎的 key 不同，旧记录无意义）
  useEffect(() => {
    if (prevEngineRef.current !== engine) {
      prevEngineRef.current = engine;
      evictedKeysRef.current.clear();
    }
  }, [engine]);
  useEffect(() => {
    if (!savedNovels.length) return;
    for (const novel of savedNovels) {
      const cacheKey = `${novel.id}-${engine}`;
      const st = buildStatuses[novel.id]?.[engine];
      if (st?.status === "ready" && !cachedKeys.has(cacheKey) && !downloadingRef.current.has(cacheKey) && !evictedKeysRef.current.has(cacheKey)) {
        downloadingRef.current.add(cacheKey);
        (async () => {
          try {
            await downloadAndCacheIndex({ novelId: novel.id, engine });
            // 下载成功后从淘汰列表移除（说明用户主动需要）
            evictedKeysRef.current.delete(cacheKey);
          } catch { /* download failed, will retry on next effect run */ }
          finally { downloadingRef.current.delete(cacheKey); }
        })();
      }
    }
  }, [buildStatuses, cachedKeys, engine, savedNovels]);

  const handleBuild = async (novelId: string) => {
    // Capture the engine at build start so polling stays consistent even if user switches engines
    const buildEngine = engine;

    try {
      // Ensure engine model is downloaded before building
      const modelKey = resolveModelKey(buildEngine);
      const modelReady = modelKey ? await ensureModelReady(modelKey) : true;
      if (!modelReady) {
        console.warn("[BookSelect] 模型下载失败，无法构建索引");
        return;
      }

      // 使用新的 build store
      const buildStore = useBuildStore.getState();
      buildStore.startBuild(novelId, buildEngine);

      await buildAndPollRAGIndex({
        novelId,
        engine: buildEngine,
        onProgress: (progress) => {
          buildStore.updateProgress(novelId, buildEngine, {
            status: progress.status as any,
            message: progress.message,
            current: progress.current || 0,
            total: progress.total || 0,
            queuePosition: progress.queuePosition,
          });
        },
      });

      // 构建成功
      buildStore.finishBuild(novelId, buildEngine);
      // 更新 buildStatuses（触发 UI 刷新）
      setBuildStatuses(prev => ({
        ...prev,
        [novelId]: { ...(prev[novelId] || {}), [buildEngine]: { status: "ready" } },
      }));

    } catch (err) {
      const message = err instanceof Error ? err.message : "构建失败";
      useBuildStore.getState().failBuild(novelId, buildEngine, message);
    }
  };

  // Scan server novel library on demand
  const scanServer = async () => {
    setScanning(true);
    try {
      const username = localStorage.getItem("sync-username");
      const url = username ? `/api/novels?username=${encodeURIComponent(username)}` : "/api/novels";
      const r = await apiFetch(url);
      const list: ServerNovel[] = await r.json();
      setServerNovels(list.map((n) => ({
        id: n.id, title: n.title, author: n.author,
        fileName: n.fileName, fileFormat: n.fileFormat,
        totalChars: n.totalChars, chapterCount: n.chapterCount,
        createdAt: n.createdAt, updatedAt: n.updatedAt,
        joined: n.joined,
      })));
      setServerScanned(true);
    } catch { /* server unreachable */ }
    finally { setScanning(false); }
  };

  // Join a server novel (download chapters + register on server)
  const handleJoinNovel = async (novel: ServerNovel) => {
    setJoiningId(novel.id);
    try {
      const chResp = await apiFetch(`/api/novels/${novel.id}/chapters`);
      if (!chResp.ok) throw new Error(`获取章节失败 (${chResp.status})`);
      const chapters = await chResp.json();
      const udb = getUserDB();
      await udb.transaction("rw", udb.novels, udb.chapters, async () => {
        await udb.novels.put({
          id: novel.id, title: novel.title, author: novel.author,
          fileName: novel.fileName, fileFormat: novel.fileFormat,
          totalChars: novel.totalChars, chapterCount: chapters.length,
          createdAt: novel.createdAt, updatedAt: Date.now(),
        });
        for (const ch of chapters) {
          await udb.chapters.put({
            id: ch.id, novelId: novel.id, index: ch.index,
            title: ch.title, content: ch.content,
            startOffset: ch.startOffset ?? 0, endOffset: ch.endOffset ?? (ch.content?.length ?? 0),
          });
        }
      });
      addNovel({ ...novel, chapters, chapterCount: chapters.length });
      apiFetch(`/api/novels/${novel.id}/join`, {
        method: "POST",
      }).catch((e) => console.warn("[BookSelect] join novel failed:", e));
      setSavedNovels((prev) => [{ ...novel, chapterCount: chapters.length }, ...prev]);
      setServerNovels((prev) => prev.map((n) => n.id === novel.id ? { ...n, joined: true } : n));
    } catch (e) { console.error("join failed:", e); }
    finally { setJoiningId(null); }
  };

  const processFiles = useCallback(
    async (files: File[]) => {
      const valid = files.filter(
        (f) => f.name.endsWith(".txt") || f.name.endsWith(".epub")
      );
      if (valid.length === 0) {
        setError("所选文件夹中未找到 .txt 或 .epub 文件");
        return;
      }
      setError(null);

      // Check for duplicate filenames against existing novels
      const existingMeta = await loadAllNovelMeta();
      const existingNames = new Set(existingMeta.map((n) => n.fileName));
      const skipped: string[] = [];
      const toProcess: File[] = [];
      for (const file of valid) {
        if (existingNames.has(file.name)) {
          skipped.push(file.name);
        } else {
          toProcess.push(file);
        }
      }
      if (skipped.length > 0) {
        setError(`已跳过 ${skipped.length} 本重复小说：${skipped.join("、")}`);
      }
      if (toProcess.length === 0) return;

      for (const file of toProcess) {
        const novel = await parseFile(file);
        if (novel) {
          const meta: NovelMeta = {
            id: novel.id, title: novel.title, author: novel.author,
            fileName: novel.fileName, fileFormat: novel.fileFormat,
            totalChars: novel.totalChars, chapterCount: novel.chapterCount,
            createdAt: novel.createdAt, updatedAt: novel.updatedAt,
          };
          setSavedNovels((prev) => {
            const filtered = prev.filter((n) => n.id !== meta.id);
            return [meta, ...filtered];
          });
        }
      }
    },
    [parseFile]
  );

  // Folder import: try showOpenFilePicker first (files visible + type filter), fallback to webkitdirectory
  const handleFolderPick = useCallback(async () => {
    setBatchParsing(true);
    setError(null);

    try {
      // Primary: showOpenFilePicker - shows individual files with proper type filtering
      if ("showOpenFilePicker" in window) {
        const fileHandles = await (window as any).showOpenFilePicker({
          types: [
            {
              description: "小说文件",
              accept: {
                "text/plain": [".txt"],
                "application/epub+zip": [".epub"],
              },
            },
          ],
          multiple: true,
        });

        const files: File[] = [];
        for (const handle of fileHandles) {
          try {
            files.push(await handle.getFile());
          } catch {
            // skip unreadable files
          }
        }
        await processFiles(files);
      } else {
        // Fallback: webkitdirectory on hidden input
        folderInputRef.current?.click();
      }
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") {
        // User cancelled - no error
      } else {
        setError("导入失败：" + (err instanceof Error ? err.message : "未知错误"));
      }
    } finally {
      setBatchParsing(false);
    }
  }, [processFiles]);

  // Fallback handler for webkitdirectory
  const handleFolderFallback = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) {
        setBatchParsing(false);
        return;
      }
      await processFiles(Array.from(files));
      // Reset so same folder can be picked again
      e.target.value = "";
      setBatchParsing(false);
    },
    [processFiles]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = e.dataTransfer.files;
      setBatchParsing(true);
      processFiles(Array.from(files)).finally(() => setBatchParsing(false));
    },
    [processFiles]
  );

  const handleDelete = async (e: React.MouseEvent, novelId: string, title: string) => {
    e.stopPropagation();
    if (!window.confirm(`从书架移除《${title}》？\n\n将删除你关于此书的所有数据：\n- AI 总结和分析\n- 人物关系图谱\n- 笔记\n- 阅读进度\n\n小说本身仍保留在服务器书库中。`)) return;
    apiFetch(`/api/novels/${novelId}/leave`, {
      method: "POST",
    }).catch((e) => console.warn("[BookSelect] leave novel failed:", e));
    await deleteNovel(novelId);
    useNovelStore.getState().removeNovel(novelId);
    setSavedNovels((prev) => prev.filter((n) => n.id !== novelId));
    setServerNovels((prev) => prev.map((n) => n.id === novelId ? { ...n, joined: false } : n));
  };

  const loading = isParsing || batchParsing;

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-5xl mx-auto p-6 space-y-8">
        {/* Hero area */}
        <div className="text-center py-4 md:py-8">
          <BookOpen className="h-10 md:h-16 w-10 md:w-16 text-primary mx-auto mb-2 md:mb-4" />
          <h1 className="text-xl md:text-3xl font-bold mb-1 md:mb-2">AI 小说精读助手</h1>
          <p className="text-sm md:text-base text-muted-foreground max-w-md mx-auto">
            上传小说，借助 AI 进行深度阅读、章节总结和全书分析
          </p>
        </div>

        {/* Upload Zone */}
        <Card
          className={`border-2 border-dashed transition-colors cursor-pointer ${
            dragOver ? "border-primary bg-primary/5" : "border-border"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <CardContent className="flex flex-col items-center justify-center py-10 gap-3">
            <Upload className="h-10 w-10 text-muted-foreground" />
            <div className="text-center">
              <p className="font-medium">
                {dragOver ? "释放以上传" : "点击上传或拖拽小说文件到此处"}
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                支持 .txt、.epub 格式，可多选文件
              </p>
            </div>
            <div className="flex gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
              {/* Regular file input */}
              <input
                ref={fileInputRef}
                type="file"
                id="novel-file-input" name="novel-file-input"
                accept=".txt,.epub"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = e.target.files;
                  if (!files) return;
                  setBatchParsing(true);
                  processFiles(Array.from(files)).finally(() => setBatchParsing(false));
                }}
              />
              {/* Folder picker button: opens showOpenFilePicker or falls back to webkitdirectory */}
              <Button variant="outline" size="sm" onClick={handleFolderPick}>
                <FolderOpen className="h-4 w-4 mr-2" />
                从文件夹导入
              </Button>
              {/* Fallback: hidden webkitdirectory input (only used if showOpenFilePicker unsupported) */}
              <input
                ref={folderInputRef}
                type="file"
                id="novel-folder-input" name="novel-folder-input"
                /* @ts-expect-error webkitdirectory */
                webkitdirectory=""
                className="hidden"
                onChange={handleFolderFallback}
              />
            </div>
          </CardContent>
        </Card>

        {/* Loading */}
        {loading && (
          <Card>
            <CardContent className="py-4 space-y-2">
              <p className="text-sm font-medium">
                {batchParsing ? "正在批量导入..." : "正在解析文件..."}
              </p>
              <Progress value={isParsing ? progress : undefined} />
            </CardContent>
          </Card>
        )}

        {/* Error */}
        {error && (
          <Card className="border-destructive">
            <CardContent className="py-4">
              <p className="text-sm text-destructive">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* Warning */}
        {parseWarning && (
          <Card className="border-amber-500">
            <CardContent className="py-4">
              <p className="text-sm text-amber-600">{parseWarning}</p>
            </CardContent>
          </Card>
        )}

        {/* Book Grid */}
        {savedNovels.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <BookOpen className="h-5 w-5" />
              我的书架 ({searchQuery.trim() ? `${filteredNovels.length}/${savedNovels.length}` : savedNovels.length})
            </h2>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                id="bookshelf-search" name="bookshelf-search"
                placeholder="搜索书名、作者、文件名..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
              {filteredNovels.map((novel) => (
                <NovelCard
                  key={novel.id}
                  novel={novel}
                  position={readingPositions[novel.id]}
                  engine={engine}
                  lruKeys={lruKeys}
                  cachedKeys={cachedKeys}
                  builds={builds}
                  buildStatuses={buildStatuses}
                  offlineMode={offlineMode}
                  onOpen={async (novelId, chapterIndex) => {
                    const full = await loadNovel(novelId, chapterIndex);
                    if (full) setCurrentNovel(full);
                  }}
                  onDelete={handleDelete}
                  onBuild={handleBuild}
                />
              ))}
            </div>
          </div>
        )}

        {/* Server novel library */}
        <div className="space-y-4 mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold flex items-center gap-2 text-muted-foreground">
              <FolderOpen className="h-5 w-5" />书库
            </h2>
            <Button variant="outline" size="sm" onClick={scanServer} disabled={scanning || offlineMode}>
              <Search className="h-4 w-4 mr-2" />
              {offlineMode ? "离线不可用" : scanning ? "扫描中..." : serverScanned ? "重新扫描" : "扫描书库"}
            </Button>
          </div>
          {offlineMode && (
            <p className="text-xs text-muted-foreground text-center py-2">书库需要服务器在线才能访问</p>
          )}
          {serverScanned && serverNovels.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">书库为空</p>
          )}
          {serverScanned && serverNovels.length > 0 && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
                {serverNovels.map((novel) => (
                  <Card key={novel.id} className="transition-all hover:shadow-md">
                    <CardContent className="p-5">
                      <div className="flex items-start gap-3 mb-3">
                        <div className="w-10 h-14 rounded bg-muted flex items-center justify-center shrink-0">
                          <FileText className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <h3 className="font-semibold truncate">《{novel.title}》</h3>
                          {novel.author && <p className="text-xs text-muted-foreground">{novel.author}</p>}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        <Badge variant="secondary" className="text-xs">{novel.fileFormat.toUpperCase()}</Badge>
                        <Badge variant="secondary" className="text-xs">{novel.chapterCount} 章</Badge>
                        <Badge variant="secondary" className="text-xs">{formatCharCount(novel.totalChars)}</Badge>
                      </div>
                      <div className="flex justify-end">
                        {novel.joined ? (
                          <Badge variant="outline" className="text-xs text-muted-foreground">已添加</Badge>
                        ) : (
                          <Button variant="outline" size="sm" onClick={() => handleJoinNovel(novel)} disabled={joiningId === novel.id || offlineMode}>
                            {offlineMode ? "离线" : joiningId === novel.id ? "加载中..." : "加入书架"}
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          )}
        </div>

        {savedNovels.length === 0 && !loading && (
          <div className="text-center py-8">
            <FileText className="h-12 w-12 text-muted-foreground/20 mx-auto mb-3" />
            <p className="text-muted-foreground">书架上还没有书，上传第一本小说吧</p>
          </div>
        )}
      </div>

      {/* 构建状态窗口 - 每本书独立 */}
      {Array.from(builds.values()).map((build) => (
        <NovelBuildWindow
          key={`${build.novelId}-${build.engine}`}
          build={build}
          onRetry={() => handleBuild(build.novelId)}
          onFallbackToTFIDF={() => {
            useRAGStore.getState().setEngine("tfidf");
            useBuildStore.getState().dismissWindow(build.novelId, build.engine);
          }}
        />
      ))}
    </div>
  );
}
