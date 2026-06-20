import { useState, useEffect, useRef } from "react";
import { useRAGStore } from "@/stores/rag-store";
import { useUIStore } from "@/stores/ui-store";
import { ALL_ENGINES, downloadModel, getMirrorId, setMirrorId, getMirrorOptions } from "@/rag/model-loader";
import { clearCache } from "@/rag/index";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import {
  CheckCircle2, Brain, ExternalLink,
  AlertTriangle, Cpu, Star, RotateCcw, Download, Loader2,
} from "lucide-react";

export function RAGSettings() {
  const {
    engine, setEngine, downloadedModels, currentDownload, downloadProgress: globalProgress,
    cacheSizeMB, ragCacheSizeBytes, setCacheSizeMB,
    topKDefault, topKTiers, setTopKDefault, setTopKTiers, resetTopKConfig, getTopK,
  } = useRAGStore();
  const { graphCharacterLimit, setGraphCharacterLimit } = useUIStore();
  const [isMobile] = useState(() => window.innerWidth < 768);
  const mountedRef = useRef(true);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  // BroadcastChannel: listen for download complete from other tabs
  useEffect(() => {
    const bc = new BroadcastChannel("novel-reader-model-sync");
    bc.onmessage = (e) => {
      if (e.data === "model-download-complete") {
        // Force re-render to update downloaded status
        useRAGStore.setState({ downloadedModels: new Set(useRAGStore.getState().downloadedModels) });
      }
    };
    return () => bc.close();
  }, []);

  const handleDownload = async (modelKey: string) => {
    // Check if another download is in progress
    if (currentDownload && currentDownload !== modelKey) {
      alert(`当前正在下载 ${currentDownload.split("/").pop()}，请等待完成后再下载其他引擎。`);
      return;
    }
    await downloadModel(modelKey);
  };

  // Build unified engine list
  const engineList = [
    {
      key: "tfidf",
      modelKey: "",
      name: "TF-IDF",
      size: "0 MB",
      description: "内置字符级检索，即时可用，无需下载",
      url: "",
      downloaded: true,
    },
    ...ALL_ENGINES.map((e) => ({
      ...e,
      downloaded: downloadedModels.has(e.modelKey),
    })),
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Brain className="h-4 w-4" />
          检索引擎
        </CardTitle>
        <CardDescription>
          选择文本检索后端。所有引擎需从网络下载，下载后缓存到浏览器。切换后重新打开小说生效。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Download source mirror */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">下载源：</span>
          {getMirrorOptions().map((mirror) => (
            <Button
              key={mirror.id}
              variant={getMirrorId() === mirror.id ? "default" : "outline"}
              size="sm"
              className="h-6 text-[10px] px-2"
              onClick={() => setMirrorId(mirror.id)}
            >
              {mirror.name}
            </Button>
          ))}
        </div>

        {/* Unified engine list */}
        <div className="space-y-1.5">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5 mb-2">
            <Cpu className="h-3.5 w-3.5" />
            引擎列表
          </h4>
          {engineList.map((m) => {
            const isActive = engine === m.key;
            const isDownloading = currentDownload === m.modelKey;
            const isOtherDownloading = currentDownload !== null && !isDownloading;
            const isDefault = m.key === "Xenova/bge-small-zh-v1.5";

            return (
              <div
                key={m.key}
                className={`p-2.5 rounded-lg border transition-colors ${
                  m.downloaded || m.key === "tfidf"
                    ? "cursor-pointer " + (isActive ? "border-primary bg-primary/5" : "hover:border-primary/50 hover:bg-accent/50")
                    : "opacity-70"
                }`}
                onClick={() => {
                  if (m.downloaded || m.key === "tfidf") setEngine(m.key);
                }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium">{m.name}</span>
                    <Badge variant="outline" className="text-xs">{m.size}</Badge>
                    {isDefault && <Star className="h-3 w-3 text-amber-500" aria-label="默认" />}
                    {isActive && <Badge className="text-xs bg-primary">当前</Badge>}
                    {m.key === "tfidf" && <span title="始终可用"><CheckCircle2 className="h-3.5 w-3.5 text-green-500" /></span>}
                    {m.downloaded && m.key !== "tfidf" && <span title="已下载"><CheckCircle2 className="h-3.5 w-3.5 text-green-500" /></span>}
                  </div>
                  {m.url && (
                    <a
                      href={m.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline flex items-center gap-0.5 shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      HuggingFace <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  )}
                </div>

                <p className="text-xs text-muted-foreground mt-1">{m.description}</p>

                {/* Download button for engines that need downloading */}
                {m.key !== "tfidf" && !m.downloaded && (
                  <div className="flex items-center gap-2 mt-1.5">
                    {isDownloading ? (
                      <p className="text-xs text-blue-500">{globalProgress || "下载中..."}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {isOtherDownloading ? "等待其他下载完成" : "需要网络下载"}
                      </p>
                    )}
                    <Button
                      variant="outline" size="sm" className="h-5 text-[10px] px-1.5"
                      disabled={isDownloading || isOtherDownloading}
                      onClick={(e) => { e.stopPropagation(); handleDownload(m.modelKey); }}
                    >
                      {isDownloading ? (
                        <><Loader2 className="h-3 w-3 animate-spin" /> 下载中</>
                      ) : isOtherDownloading ? (
                        "等待中"
                      ) : (
                        <><Download className="h-3 w-3" /> 下载</>
                      )}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <Separator />

        {/* Engine behavior info */}
        <div className="space-y-2 text-xs text-muted-foreground">
          <p className="font-medium text-foreground/80">说明</p>
          <div className="space-y-1">
            <p>• BGE Small ZH 是默认引擎，登录时自动下载</p>
            <p>• 同一时间只能下载一个引擎，切换到已下载的引擎可直接使用</p>
            <p>• 引擎选择会自动保存，关闭浏览器后依然生效</p>
            <p>• 切换引擎后已有分析结果不会清除，仅影响后续新生成的分析</p>
            <p>• 无可用模型时自动回退到 TF-IDF</p>
          </div>
        </div>

        <Separator className="my-4" />

        {/* Cache size */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-sm">索引缓存上限</p>
              <p className="text-xs text-muted-foreground">仅管理浏览器本地构建缓存，超过自动淘汰旧索引</p>
            </div>
            <select
              id="rag-cache-size" name="rag-cache-size"
              className="text-xs border rounded px-2 py-1 bg-background"
              value={cacheSizeMB}
              onChange={(e) => setCacheSizeMB(parseInt(e.target.value))}
            >
              {[100, 200, 300, 400, 500].map((mb) => (
                <option key={mb} value={mb}>{mb} MB</option>
              ))}
            </select>
          </div>
          {(() => {
            const usedMB = ragCacheSizeBytes / 1024 / 1024;
            const pct = cacheSizeMB > 0 ? (usedMB / cacheSizeMB) * 100 : 0;
            const color = pct > 95 ? "text-red-500" : pct > 80 ? "text-yellow-500" : "text-green-500";
            return (
              <div className="flex items-center gap-2 text-xs">
                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${pct > 95 ? "bg-red-500" : pct > 80 ? "bg-yellow-500" : "bg-green-500"}`}
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
                <span className={`font-mono ${color}`}>
                  {usedMB.toFixed(1)} / {cacheSizeMB} MB
                </span>
              </div>
            );
          })()}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10px] text-destructive hover:bg-destructive/10"
              onClick={() => {
                if (window.confirm("确认清除所有 RAG 索引缓存？清除后需要重新构建。")) {
                  clearCache();
                  // 重新计算缓存大小
                  import("@/rag/rag-cache-utils").then(m => m.updateRagCacheSize());
                }
              }}
            >
              清除全部缓存
            </Button>
          </div>
        </div>

        <Separator className="my-4" />

        {/* Graph character limit */}
        <div className="space-y-2">
          <div>
            <p className="font-medium text-sm">图谱人物上限</p>
            <p className="text-xs text-muted-foreground">生成人物关系图谱时，AI 识别的最大角色数量（下限 10）</p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              id="graph-char-limit" name="graph-char-limit"
              type="number" min={10} max={150} step={5}
              className="h-7 w-24 text-xs"
              value={graphCharacterLimit}
              onChange={(e) => setGraphCharacterLimit(parseInt(e.target.value) || 50)}
            />
            <span className="text-xs text-muted-foreground">人</span>
          </div>
        </div>

        <Separator className="my-4" />

        {/* TopK configuration */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-sm">RAG 检索数量 (TopK)</p>
              <p className="text-xs text-muted-foreground">
                全书分析时检索的相关段落数量，根据书籍大小自动调整
              </p>
            </div>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={resetTopKConfig}>
              <RotateCcw className="h-3 w-3 mr-1" /> 恢复默认
            </Button>
          </div>

          <div className="flex items-center gap-3">
            <label htmlFor="topk-default" className="text-xs text-muted-foreground shrink-0">默认值</label>
            <Input
              id="topk-default" name="topk-default"
              type="number" min={1} max={200}
              className="h-7 w-20 text-xs"
              value={topKDefault}
              onChange={(e) => setTopKDefault(parseInt(e.target.value) || 30)}
            />
          </div>

          <div className="rounded-lg border overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-left px-3 py-1.5 font-medium">向量数量上限</th>
                  <th className="text-left px-3 py-1.5 font-medium">对应 TopK</th>
                  <th className="text-left px-3 py-1.5 font-medium">适用场景</th>
                </tr>
              </thead>
              <tbody>
                {topKTiers.map((tier, i) => {
                  const label = tier.maxChunks <= 200 ? "短篇"
                    : tier.maxChunks <= 1000 ? "中篇"
                    : tier.maxChunks <= 5000 ? "长篇"
                    : "超长篇";
                  return (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-1.5">
                        <Input
                          id={`topk-tier-max-${i}`} name={`topk-tier-max-${i}`}
                          type="number" min={1}
                          className="h-6 w-20 text-xs"
                          value={tier.maxChunks === Infinity ? "" : tier.maxChunks}
                          placeholder="无上限"
                          onChange={(e) => {
                            const val = e.target.value === "" ? Infinity : parseInt(e.target.value) || 1;
                            const next = [...topKTiers];
                            next[i] = { ...tier, maxChunks: val };
                            setTopKTiers(next);
                          }}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <Input
                          id={`topk-tier-val-${i}`} name={`topk-tier-val-${i}`}
                          type="number" min={1} max={200}
                          className="h-6 w-20 text-xs"
                          value={tier.topK}
                          onChange={(e) => {
                            const val = Math.max(1, Math.min(200, parseInt(e.target.value) || 1));
                            const next = [...topKTiers];
                            next[i] = { ...tier, topK: val };
                            setTopKTiers(next);
                          }}
                        />
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{label}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="text-xs text-muted-foreground bg-muted/30 rounded p-2">
            <span className="font-medium text-foreground/70">预览：</span>
            100 向量 → {getTopK(100)}，
            500 向量 → {getTopK(500)}，
            2000 向量 → {getTopK(2000)}，
            6000 向量 → {getTopK(6000)}
          </div>

          <div className="text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground/70">推荐值</p>
            <p>短篇（10万字以下）：15-20 | 中篇（10-50万字）：25-40 | 长篇（50-200万字）：40-60 | 超长篇（200万字以上）：60-100</p>
            {topKTiers.some((t) => t.topK > 100) && (
              <div className="flex items-start gap-1.5 mt-2 p-2 rounded bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <p className="font-medium">TopK 过大可能导致：</p>
                  <p>- 超出模型上下文限制，导致请求失败</p>
                  <p>- AI 回答质量下降（信息过多反而干扰判断）</p>
                  <p>- API 调用成本增加</p>
                  <p>建议从默认值开始，根据分析质量逐步调高。</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {!isMobile && (
          <>
            <Separator className="my-4" />

            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">调试模式</p>
                <p className="text-xs text-muted-foreground">开启后在右下角显示 RAG 检索详情面板</p>
              </div>
              <Button
                variant={useUIStore.getState().debugMode ? "default" : "outline"}
                size="sm"
                onClick={() => useUIStore.getState().setDebugMode(!useUIStore.getState().debugMode)}
              >
                {useUIStore.getState().debugMode ? "已开启" : "已关闭"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
