import { useState, useEffect, useRef } from "react";
import { Download, Upload, FileText, FileJson, Package, HardDrive, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { loadAllNovelMeta } from "@/db/repositories";
import type { NovelMeta } from "@/parsers/types";
import { exportNovelAsJSON, exportNovelAsTXT, exportAllAsJSON, importFromJSON } from "@/lib/export";

export function ExportPanel() {
  const [novels, setNovels] = useState<NovelMeta[]>([]);
  const [selectedNovelId, setSelectedNovelId] = useState<string>("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [storageUsage, setStorageUsage] = useState<{ usage: number; quota: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadAllNovelMeta().then(setNovels); }, []);
  useEffect(() => {
    if (navigator.storage?.estimate) {
      navigator.storage.estimate().then((e) => setStorageUsage({ usage: e.usage || 0, quota: e.quota || 0 }));
    }
  }, []);

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const result = await importFromJSON(file);
      setImportResult(`导入成功：${result.novels} 本小说，${result.chapters} 个章节，${result.summaries} 条摘要，${result.notes} 条笔记`);
      loadAllNovelMeta().then(setNovels);
    } catch (e) {
      setImportResult(`导入失败：${e instanceof Error ? e.message : "文件格式错误"}`);
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const selectedNovel = novels.find((n) => n.id === selectedNovelId);

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const usagePct = storageUsage && storageUsage.quota > 0
    ? Math.round((storageUsage.usage / storageUsage.quota) * 100)
    : 0;
  const isWarning = usagePct >= 80;
  const isCritical = usagePct >= 95;

  return (
    <div className="space-y-4">
      {/* Storage usage */}
      {storageUsage && (
        <Card className={isCritical ? "border-destructive" : isWarning ? "border-amber-500/50" : ""}>
          <CardContent className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium flex items-center gap-2">
                <HardDrive className="h-4 w-4" />
                浏览器存储用量
              </p>
              <span className="text-xs text-muted-foreground">
                {formatSize(storageUsage.usage)} / {formatSize(storageUsage.quota)}
              </span>
            </div>
            <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${isCritical ? "bg-destructive" : isWarning ? "bg-amber-500" : "bg-primary"}`}
                style={{ width: `${Math.min(usagePct, 100)}%` }}
              />
            </div>
            {(isWarning || isCritical) && (
              <p className={`text-xs flex items-center gap-1 ${isCritical ? "text-destructive" : "text-amber-600"}`}>
                <AlertTriangle className="h-3 w-3" />
                {isCritical
                  ? "存储空间即将用尽，建议删除不需要的小说或导出备份后清理"
                  : "存储空间使用较多，建议定期清理不需要的数据"}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <h3 className="text-sm font-semibold flex items-center gap-2">
        <Package className="h-4 w-4" /> 导出 / 备份
      </h3>

      {/* Export all + Import — grouped as a pair */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">导出全部数据</p>
              <p className="text-xs text-muted-foreground">所有小说、摘要、笔记（不含 API Key）</p>
            </div>
            <Button size="sm" onClick={exportAllAsJSON}>
              <Download className="h-4 w-4 mr-1" /> 导出 JSON
            </Button>
          </div>
          <div className="border-t" />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">导入备份</p>
              <p className="text-xs text-muted-foreground">从 JSON 备份文件恢复数据</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={importing}>
              <Upload className="h-4 w-4 mr-1" /> {importing ? "导入中..." : "选择文件"}
            </Button>
          </div>
          <input ref={fileRef} type="file" id="import-backup" name="import-backup" accept=".json" className="hidden" onChange={handleImport} />
          {importResult && (
            <p className={`text-xs ${importResult.includes("成功") ? "text-green-500" : "text-destructive"}`}>
              {importResult}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Per-novel export — dropdown select */}
      {novels.length > 0 && (
        <Card>
          <CardContent className="p-3 space-y-2">
            <p className="text-sm font-medium">单本导出</p>
            <div className="flex gap-2">
              <Select value={selectedNovelId} onValueChange={setSelectedNovelId}>
                <SelectTrigger id="export-novel" name="export-novel" className="flex-1 h-8 text-xs">
                  <SelectValue placeholder="选择小说..." />
                </SelectTrigger>
                <SelectContent>
                  {novels.map((n) => (
                    <SelectItem key={n.id} value={n.id} className="text-xs">
                      {n.title} ({n.chapterCount} 章)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" className="h-8 px-2" title="JSON 格式"
                disabled={!selectedNovelId} onClick={() => selectedNovelId && exportNovelAsJSON(selectedNovelId)}>
                <FileJson className="h-3.5 w-3.5" />
              </Button>
              <Button variant="outline" size="sm" className="h-8 px-2" title="TXT 格式"
                disabled={!selectedNovelId} onClick={() => selectedNovelId && exportNovelAsTXT(selectedNovelId)}>
                <FileText className="h-3.5 w-3.5" />
              </Button>
            </div>
            {selectedNovel && (
              <p className="text-xs text-muted-foreground">
                {selectedNovel.author || "未知作者"} · {selectedNovel.chapterCount} 章
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
