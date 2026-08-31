/**
 * 存储管理面板（设置页）
 * 展示浏览器存储总览与各分类占用，提供可清理分类的清理入口：
 * - RAG 索引缓存：清除全部索引（重新构建）
 * - TTS 语音模型：删除浏览器离线模型（服务端推理 / Web Speech 不受影响）
 * - 嵌入模型：按模型删除 transformers-cache 中的缓存文件
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  HardDrive, RefreshCw, Trash2, Database, Brain, Volume2, Cpu, Loader2, CheckCircle2,
} from "lucide-react";
import { getStorageBreakdown, formatBytes, type StorageBreakdown } from "@/lib/storage-stats";
import { clearCache as clearRAGCache } from "@/rag/index";
import { clearCache as clearTTSCache, cleanupOrphanFiles } from "@/tts/tts-cache";
import { deleteModelCache, getTransformersCacheInfo, type TransformersCacheInfo } from "@/rag/model-loader";
import { useRAGStore } from "@/stores/rag-store";
import { getActiveTTSManager } from "@/tts/tts-manager";
import { resetWorker } from "@/tts/zipvoice-engine";

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  "user-data": <Database className="h-3.5 w-3.5" />,
  "rag-index": <Brain className="h-3.5 w-3.5" />,
  "tts-cache": <Volume2 className="h-3.5 w-3.5" />,
  "embedding-models": <Cpu className="h-3.5 w-3.5" />,
  "pwa-cache": <HardDrive className="h-3.5 w-3.5" />,
  "config": <HardDrive className="h-3.5 w-3.5" />,
};

export function StorageManager() {
  const [breakdown, setBreakdown] = useState<StorageBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [modelInfo, setModelInfo] = useState<TransformersCacheInfo | null>(null);
  const downloadedModels = useRAGStore((s) => s.downloadedModels);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [bd, info] = await Promise.all([getStorageBreakdown(), getTransformersCacheInfo()]);
      setBreakdown(bd);
      setModelInfo(info);
    } finally {
      setLoading(false);
    }
  }, []);

  // 初始加载：setState 在异步回调中执行，避免同步级联渲染
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [bd, info] = await Promise.all([getStorageBreakdown(), getTransformersCacheInfo()]);
      if (cancelled) return;
      setBreakdown(bd);
      setModelInfo(info);
      setLoading(false);
    })().catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const runCleanup = async (id: string, confirmText: string, action: () => Promise<void>) => {
    if (!window.confirm(confirmText)) return;
    setBusyAction(id);
    setMessage(null);
    try {
      await action();
      setMessage({ type: "ok", text: "清理完成" });
      await refresh();
    } catch (e) {
      setMessage({ type: "err", text: `清理失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusyAction(null);
    }
  };

  // RAG 索引缓存清理（复用 rag/index 的 clearCache）
  const cleanRAG = () => runCleanup(
    "rag-index",
    "确认清除所有 RAG 索引缓存？\n\n清除后打开小说时需要重新构建索引（较慢），不影响小说正文与 AI 分析结果。",
    async () => {
      clearRAGCache();
      const { updateRagCacheSize } = await import("@/rag/rag-cache-utils");
      await updateRagCacheSize();
    },
  );

  // TTS 模型清理（停止朗读 → 删除 IndexedDB 缓存 → 释放内存中已加载的模型）
  const cleanTTS = () => runCleanup(
    "tts-cache",
    "确认删除浏览器中的 TTS 语音模型（约 380MB）？\n\n• 服务端推理 / Web Speech 朗读不受影响\n• 浏览器推理（离线朗读）需重新下载后才能使用\n• 若正在朗读，将先停止",
    async () => {
      try {
        const manager = getActiveTTSManager();
        if (manager) manager.stop();
      } catch { /* 无活跃 manager 忽略 */ }
      await clearTTSCache();
      try { resetWorker(); } catch { /* 模型未加载忽略 */ }
    },
  );

  // 嵌入模型缓存清理（按模型删除）
  const removeEmbeddingModel = (key: string) => runCleanup(
    `model-${key}`,
    `确认删除嵌入模型 ${key} 的浏览器缓存？\n\n删除后需重新下载才能使用该检索引擎。`,
    async () => { await deleteModelCache(key); },
  );

  const usagePct = breakdown && breakdown.quota > 0
    ? Math.round((breakdown.usage / breakdown.quota) * 100)
    : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <HardDrive className="h-4 w-4" />
          存储管理
        </CardTitle>
        <CardDescription>
          浏览器本地存储占用总览。各分类独立统计，清理只影响对应功能。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 总览 */}
        {breakdown && breakdown.support && (
          <div className="space-y-1.5 rounded-lg border p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">浏览器存储用量（本站点）</span>
              <span className="font-mono">
                {formatBytes(breakdown.usage)} / {formatBytes(breakdown.quota)}
              </span>
            </div>
            <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  usagePct > 95 ? "bg-destructive" : usagePct > 80 ? "bg-amber-500" : "bg-primary"
                }`}
                style={{ width: `${Math.min(usagePct, 100)}%` }}
              />
            </div>
            <p className="text-[10px] text-muted-foreground">
              浏览器配额约等于磁盘可用空间的 60%，不同浏览器策略不同
            </p>
          </div>
        )}

        {/* 分类明细 */}
        <div className="space-y-1.5">
          {loading && !breakdown ? (
            <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> 正在统计存储占用...
            </div>
          ) : (
            breakdown?.categories.map((cat) => (
              <div key={cat.id} className="flex items-center justify-between rounded-lg border px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-muted-foreground shrink-0">{CATEGORY_ICONS[cat.id]}</span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium flex items-center gap-1.5">
                      {cat.label}
                      <span className="font-mono text-muted-foreground">{formatBytes(cat.bytes)}</span>
                    </p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {cat.description}{cat.detail ? `（${cat.detail}）` : ""}
                    </p>
                  </div>
                </div>
                {cat.cleanable && (
                  <Button
                    variant="outline" size="sm"
                    className="h-6 text-[10px] text-destructive hover:bg-destructive/10 shrink-0 ml-2"
                    disabled={busyAction !== null}
                    onClick={() => {
                      if (cat.id === "rag-index") cleanRAG();
                      else if (cat.id === "tts-cache") cleanTTS();
                    }}
                  >
                    {busyAction === cat.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                    <span className="ml-1">清理</span>
                  </Button>
                )}
              </div>
            ))
          )}
        </div>

        {/* 嵌入模型明细 */}
        {downloadedModels.size > 0 && (
          <div className="space-y-1.5 rounded-lg border p-2.5">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Cpu className="h-3 w-3" /> 已下载的嵌入模型
            </p>
            {[...downloadedModels].map((key) => {
              const files = modelInfo?.modelFiles.get(key);
              return (
                <div key={key} className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex items-center gap-1.5">
                    <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                    <p className="text-xs truncate font-mono">{key}</p>
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {files && files.count > 0 ? `${files.count} 文件${files.bytes > 0 ? ` · ${formatBytes(files.bytes)}` : ""}` : "缓存文件缺失"}
                    </span>
                  </div>
                  <Button
                    variant="ghost" size="sm"
                    className="h-5 text-[10px] text-destructive hover:bg-destructive/10 shrink-0"
                    disabled={busyAction !== null}
                    onClick={() => removeEmbeddingModel(key)}
                  >
                    {busyAction === `model-${key}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {/* 孤儿清理（TTS 下载中断残留） */}
        <div className="flex items-center justify-between rounded-lg border border-dashed px-3 py-2">
          <div>
            <p className="text-xs font-medium">TTS 残留文件清理</p>
            <p className="text-[10px] text-muted-foreground">删除下载中断 / 已废弃版本残留的孤儿文件（不影响当前必需文件）</p>
          </div>
          <Button
            variant="outline" size="sm" className="h-6 text-[10px] shrink-0 ml-2"
            disabled={busyAction !== null}
            onClick={() => runCleanup(
              "tts-orphan",
              "确认清理 TTS 残留文件？仅删除不在当前必需清单内的孤儿文件。",
              async () => {
                const removed = await cleanupOrphanFiles();
                if (removed > 0) setMessage({ type: "ok", text: `已清理 ${removed} 个残留文件` });
                else setMessage({ type: "ok", text: "没有发现残留文件" });
              },
            )}
          >
            {busyAction === "tts-orphan" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            <span className="ml-1">清理残留</span>
          </Button>
        </div>

        {message && (
          <p className={`text-xs flex items-center gap-1 ${message.type === "ok" ? "text-green-600" : "text-destructive"}`}>
            {message.type === "ok" ? <CheckCircle2 className="h-3 w-3" /> : null}
            {message.text}
          </p>
        )}

        <Separator />

        <div className="flex items-center justify-between">
          <p className="text-[10px] text-muted-foreground">
            {breakdown ? `统计耗时 ${breakdown.elapsed}ms · 小说数据在书架中删除，此处仅展示` : ""}
          </p>
          <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-3 w-3 mr-1 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
