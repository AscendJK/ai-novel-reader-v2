import { useState } from "react";
import { useAPIStore } from "@/stores/api-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ProviderSelect } from "./ProviderSelect";
import type { ProviderConfig, ProviderFormat } from "@/api/types";
import { Key, Trash2, ArrowLeft, Plus, WifiOff, Wifi, Keyboard, Edit2 } from "lucide-react";
import { sharedDB as db } from "@/db/database";
import { useUIStore } from "@/stores/ui-store";
import { syncClient } from "@/sync/sync-client";
import { RAGSettings } from "./RAGSettings";
import { TTSSettings } from "./TTSSettings";
import { ExportPanel } from "./ExportPanel";

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function ApiSettings({ onBack }: { onBack?: () => void }) {
  const { providers, addProvider, removeProvider, activeProviderId, setActiveProvider } = useAPIStore();
  const { offlineMode, setOfflineMode } = useUIStore();
  const [editing, setEditing] = useState<ProviderConfig | null>(null);

  const handleAdd = () => {
    setEditing({
      id: newId(),
      format: "openai",
      name: "",
      apiKey: "",
      baseUrl: "",
      model: "",
    });
  };

  const handleEdit = (config: ProviderConfig) => {
    setEditing({ ...config });
  };

  const handleSave = () => {
    if (!editing || !editing.apiKey.trim()) return;
    addProvider(editing);
    setEditing(null);
  };

  const handleDelete = (id: string) => {
    if (!window.confirm("确认删除此 API 配置？")) return;
    removeProvider(id);
  };

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      {onBack && (
        <div className="sticky top-0 z-10 -mx-6 -mt-6 px-6 py-3 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b">
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1.5" /> 返回
          </Button>
        </div>
      )}

      <div>
        <h2 className="text-2xl font-semibold">API 设置</h2>
        <p className="text-sm text-muted-foreground mt-1">
          配置大模型 API。支持 OpenAI 和 Anthropic 两种接口格式。
        </p>
      </div>

      {/* Active provider selector */}
      {providers.filter((p) => p.apiKey).length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">当前使用的 API</CardTitle></CardHeader>
          <CardContent><ProviderSelect /></CardContent>
        </Card>
      )}

      {/* Provider list */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">API 配置</h3>
          <Button variant="outline" size="sm" onClick={handleAdd}>
            <Plus className="h-4 w-4 mr-1" /> 添加 API
          </Button>
        </div>

        {providers.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">暂无 API 配置，点击上方按钮添加</p>
        )}

        {providers.map((p) => (
          <Card key={p.id}
            className={`cursor-pointer transition-colors hover:bg-accent/50 ${activeProviderId === p.id ? "border-primary" : ""}`}
            onClick={() => setActiveProvider(p.id)}>
            <CardContent className="py-3 flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <Key className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">{p.name || "未命名"}</p>
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      {p.format === "anthropic" ? "Anthropic" : "OpenAI"}
                    </Badge>
                    {activeProviderId === p.id && <Badge className="text-[10px] bg-primary shrink-0">当前</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {p.apiKey ? `${p.model || "未设模型"} · ${p.baseUrl || "默认地址"}` : "未配置"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleEdit(p)}>
                  <Edit2 className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive" onClick={() => handleDelete(p.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Edit / Add form */}
      {editing && (
        <Card className="border-primary">
          <CardHeader>
            <CardTitle className="text-base">
              {providers.some((p) => p.id === editing.id) ? "编辑 API" : "添加 API"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="api-format" className="text-xs">接口格式</Label>
              <select
                id="api-format" name="api-format"
                className="w-full text-sm border rounded px-3 py-1.5 bg-background"
                value={editing.format}
                onChange={(e) => setEditing((d) => d ? { ...d, format: e.target.value as ProviderFormat } : d)}
              >
                <option value="openai">OpenAI Chat Completions</option>
                <option value="anthropic">Anthropic Messages</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="api-name" className="text-xs">名称</Label>
              <Input id="api-name" name="api-name" placeholder="如：我的 DeepSeek" value={editing.name}
                onChange={(e) => setEditing((d) => d ? { ...d, name: e.target.value } : d)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="api-key" className="text-xs">API Key</Label>
              <Input id="api-key" name="api-key" type="password" placeholder="sk-..." value={editing.apiKey}
                onChange={(e) => setEditing((d) => d ? { ...d, apiKey: e.target.value } : d)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="api-baseurl" className="text-xs">Base URL</Label>
              <Input id="api-baseurl" name="api-baseurl" placeholder="https://api.example.com/v1" value={editing.baseUrl}
                onChange={(e) => setEditing((d) => d ? { ...d, baseUrl: e.target.value } : d)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="api-model" className="text-xs">模型名称</Label>
              <Input id="api-model" name="api-model" placeholder="gpt-4o / deepseek-chat / claude-sonnet-4-6" value={editing.model}
                onChange={(e) => setEditing((d) => d ? { ...d, model: e.target.value } : d)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="api-ctx" className="text-xs">上下文窗口（可选）</Label>
              <Input id="api-ctx" name="api-ctx" type="number" min={1024} step={1024}
                placeholder="留空使用默认值" value={editing.contextWindow || ""}
                onChange={(e) => setEditing((d) => d ? { ...d, contextWindow: e.target.value ? parseInt(e.target.value) : undefined } : d)}
                className="h-7 text-xs" />
              <p className="text-[10px] text-muted-foreground">
                模型的最大输入 token 数。留空则根据模型名称自动匹配（如 gpt-4o → 128k, claude → 200k），未匹配则使用默认值 128k
              </p>
              <details className="text-[10px] text-muted-foreground">
                <summary className="cursor-pointer hover:text-foreground">查看常用模型参考值</summary>
                <div className="mt-1 pl-2 border-l-2 border-muted space-y-0.5">
                  <p className="font-medium">OpenAI</p>
                  <p>GPT-4o / 4o-mini: 128,000</p>
                  <p>O1 / O3-mini: 200,000</p>
                  <p className="font-medium mt-1">Anthropic</p>
                  <p>Claude 3.5 Sonnet / Haiku: 200,000</p>
                  <p className="font-medium mt-1">其他</p>
                  <p>DeepSeek Chat: 128,000</p>
                  <p>Gemini 1.5/2.0: 1,000,000</p>
                  <p>Qwen Turbo/Plus/Max: 128,000</p>
                  <p>GLM-4: 128,000</p>
                  <p>ERNIE 4.0: 128,000</p>
                  <p>Moonshot 128k: 131,072</p>
                </div>
              </details>
            </div>
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={handleSave} disabled={!editing.apiKey.trim()}>保存</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>取消</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* CORS note */}
      <div className="text-xs text-muted-foreground bg-muted/30 rounded p-2.5 space-y-1">
        <p className="font-medium text-foreground/70">关于浏览器直连与代理</p>
        <p>API 请求优先从浏览器直连服务商。部分提供商（如 Anthropic）可能因 CORS 限制拒绝浏览器请求，此时会自动通过服务器代理转发。</p>
        <p>离线模式下服务器代理不可用，OpenAI 兼容接口通常可直连，Anthropic 可能需要服务器在线。</p>
        <p className="mt-1.5 pt-1.5 border-t border-border/50">你的 API Key 仅存储在浏览器 IndexedDB 中，仅在调用对应 API 时使用。所有 API 调用直接从浏览器发起，不经过任何第三方服务器。</p>
      </div>

      <Separator />
      <RAGSettings />
      <Separator />
      <TTSSettings />
      <Separator />

      {/* Keyboard shortcuts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Keyboard className="h-4 w-4" /> 键盘快捷键
          </CardTitle>
          <CardDescription>阅读时可用的快捷键</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">滚动模式</p>
          {[
            ["← / →", "上一章 / 下一章"],
            ["+ / −", "增大 / 减小字号"],
            ["i", "切换沉浸模式"],
          ].map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{desc}</span>
              <kbd className="px-2 py-0.5 text-xs rounded border bg-muted font-mono">{key}</kbd>
            </div>
          ))}
          <p className="text-xs font-medium text-muted-foreground pt-2">翻页模式（单页/双页）</p>
          {[
            ["← / → / Space", "上一页 / 下一页"],
            ["+ / −", "增大 / 减小字号"],
            ["i", "切换沉浸模式"],
          ].map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{desc}</span>
              <kbd className="px-2 py-0.5 text-xs rounded border bg-muted font-mono">{key}</kbd>
            </div>
          ))}
          <p className="text-xs font-medium text-muted-foreground pt-2">全局</p>
          {[
            ["t", "切换主题"],
            ["Esc", "关闭弹窗"],
            ["Shift + ?", "显示快捷键帮助"],
          ].map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{desc}</span>
              <kbd className="px-2 py-0.5 text-xs rounded border bg-muted font-mono">{key}</kbd>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Offline mode */}
      <Card className={offlineMode ? "border-amber-500/50" : ""}>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            {offlineMode ? <WifiOff className="h-4 w-4 text-amber-500" /> : <Wifi className="h-4 w-4" />}
            离线模式
          </CardTitle>
          <CardDescription>
            {offlineMode
              ? "已开启。浏览器不会与服务器通信，数据仅保存在本地。"
              : "服务器不可用时会自动开启（3 次心跳失败后）。手动切换会重置自动检测。"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant={offlineMode ? "outline" : "default"}
            size="sm"
            onClick={() => {
              if (!offlineMode && !window.confirm("开启离线模式后：\n\n• 服务器同步将停止\n• 已缓存的嵌入索引仍可使用，但无法构建新索引\n• 关闭浏览器再打开仍可使用本地数据\n• 退出登录后需服务器在线才能重新登录\n\n确认开启？")) return;
              syncClient.resetAutoOffline();
              setOfflineMode(!offlineMode);
            }}
          >
            {offlineMode ? "关闭离线模式" : "开启离线模式"}
          </Button>
        </CardContent>
      </Card>

      <Separator />

      <ExportPanel />
    </div>
  );
}
