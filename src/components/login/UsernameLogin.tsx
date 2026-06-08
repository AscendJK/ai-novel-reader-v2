import { useState, useEffect, useRef } from "react";
import { BookOpen, LogIn, Trash2, UserPlus, WifiOff, Server, Clock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { getServerUrl, setServerUrl, checkServerReachable } from "@/lib/api-client";

const RECENT_URLS_KEY = "novel-reader-recent-urls";
const MAX_RECENT = 5;

function getRecentUrls(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_URLS_KEY) || "[]");
  } catch { return []; }
}

function addRecentUrl(url: string) {
  const recent = getRecentUrls().filter(u => u !== url);
  recent.unshift(url);
  localStorage.setItem(RECENT_URLS_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
}

function removeRecentUrl(url: string) {
  const recent = getRecentUrls().filter(u => u !== url);
  localStorage.setItem(RECENT_URLS_KEY, JSON.stringify(recent));
}

interface Props {
  localUsers: string[];
  onLogin: (username: string) => Promise<void>;
  onDelete: (username: string) => void;
  error?: string | null;
  syncing?: boolean;
  /** 登录时服务器不可达（离线登录） */
  offlineLogin?: boolean;
}

export function UsernameLogin({ localUsers, onLogin, onDelete, error, syncing, offlineLogin }: Props) {
  const [selectedUser, setSelectedUser] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [serverUrl, setServerUrlState] = useState(getServerUrl());
  const [serverStatus, setServerStatus] = useState<"unknown" | "checking" | "ok" | "fail">("unknown");
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 检查服务器状态
  const checkServer = async (url: string) => {
    if (!url) { setServerStatus("unknown"); return; }
    setServerStatus("checking");
    const ok = await checkServerReachable(url);
    setServerStatus(ok ? "ok" : "fail");
  };

  // 保存服务器地址
  const handleSaveServerUrl = async () => {
    let url = serverUrl.trim().replace(/\/+$/, "");
    if (!url) return;
    // 自动补全协议头
    if (!/^https?:\/\//i.test(url)) {
      url = "http://" + url;
    }
    setServerUrlState(url);
    setServerUrl(url);
    addRecentUrl(url);
    await checkServer(url);
    setShowServerConfig(false);
    setShowRecent(false);
  };

  // 选择最近使用的地址
  const handleSelectRecent = (url: string) => {
    setServerUrlState(url);
    setServerUrl(url);
    setShowRecent(false);
    inputRef.current?.focus();
  };

  // 初始检查
  useEffect(() => {
    if (getServerUrl()) checkServer(getServerUrl());
  }, []);

  // 点击外部关闭下拉
  useEffect(() => {
    if (!showRecent) return;
    const handleClick = (e: MouseEvent) => {
      if (inputRef.current && !inputRef.current.parentElement?.contains(e.target as Node)) {
        setShowRecent(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showRecent]);

  const isNewUser = selectedUser === "__new__";
  const username = isNewUser ? newUsername.trim() : selectedUser;
  const canSubmit = username.length >= 2;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setLoading(true);
    try { await onLogin(username); }
    finally { setLoading(false); }
  };

  const handleDelete = () => {
    if (!selectedUser || selectedUser === "__new__") return;
    if (window.confirm(`确认删除用户 "${selectedUser}" 的所有本地数据？此操作不可恢复。`)) {
      onDelete(selectedUser);
      setSelectedUser("");
    }
  };

  if (syncing) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
        <Card className="w-full max-w-sm mx-4">
          <CardContent className="py-8 text-center space-y-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
            <p className="text-sm font-medium">正在同步云端数据...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <Card className="w-full max-w-sm mx-4">
        <CardHeader className="text-center">
          <BookOpen className="h-10 w-10 text-primary mx-auto mb-2" />
          <CardTitle>AI 小说精读助手</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            {showServerConfig ? "配置后端服务器地址（可选）" : "选择已有用户或创建新用户"}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 服务器地址配置 */}
          {showServerConfig ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Server className="h-4 w-4" />
                <span>后端服务器地址</span>
              </div>
              <div className="relative">
                <Input
                  ref={inputRef}
                  placeholder="http://192.168.1.100:5173"
                  value={serverUrl}
                  onChange={(e) => setServerUrlState(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSaveServerUrl()}
                  onFocus={() => { if (getRecentUrls().length > 0) setShowRecent(true); }}
                  autoFocus
                />
                {/* 最近使用的地址下拉 */}
                {showRecent && getRecentUrls().length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-popover border rounded-md shadow-md z-10 max-h-40 overflow-y-auto">
                    {getRecentUrls().map((url) => (
                      <div key={url} className="flex items-center justify-between px-3 py-1.5 hover:bg-accent text-sm cursor-pointer group"
                        onClick={() => handleSelectRecent(url)}>
                        <div className="flex items-center gap-2 min-w-0">
                          <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="truncate">{url}</span>
                        </div>
                        <button className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-destructive"
                          onClick={(e) => { e.stopPropagation(); removeRecentUrl(url); setServerUrlState(getServerUrl()); }}>
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground">
                输入运行后端服务的电脑 IP 地址和端口
              </p>
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  onClick={handleSaveServerUrl}
                  disabled={!serverUrl.trim() || serverStatus === "checking"}
                >
                  {serverStatus === "checking" ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" />检测中...</>
                  ) : (
                    "保存并连接"
                  )}
                </Button>
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setShowServerConfig(false)}
                >
                  跳过
                </Button>
              </div>
              {serverStatus === "fail" && (
                <p className="text-xs text-destructive text-center">无法连接到服务器，请检查地址是否正确</p>
              )}
              {serverStatus === "ok" && (
                <p className="text-xs text-green-600 text-center">连接成功！</p>
              )}
            </div>
          ) : (
            <>
              {/* 服务器状态 */}
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Server className="h-3 w-3" />
                  {getServerUrl() ? (
                    <span className="truncate max-w-[200px]">{getServerUrl()}</span>
                  ) : (
                    <span className="text-muted-foreground">未配置服务器（离线模式）</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {serverStatus === "ok" && <span className="text-green-600">● 已连接</span>}
                  {serverStatus === "fail" && <span className="text-destructive">● 无法连接</span>}
                  {serverStatus === "checking" && <span className="text-muted-foreground">● 检测中</span>}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => setShowServerConfig(true)}
                  >
                    {getServerUrl() ? "更改" : "配置"}
                  </Button>
                </div>
              </div>

              {/* User selector */}
              <div className="space-y-2">
                <select
                  id="user-select" name="user-select"
                  aria-label="选择用户"
                  className="w-full text-sm border rounded px-3 py-2 bg-background"
                  value={selectedUser}
                  onChange={(e) => setSelectedUser(e.target.value)}
                >
                  <option value="">-- 选择用户 --</option>
                  {localUsers.map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                  <option value="__new__">+ 创建新用户</option>
                </select>
              </div>

              {/* New username input */}
              {isNewUser && (
                <Input
                  id="new-username" name="new-username" autoComplete="username"
                  placeholder="输入用户名（2-30 字符）"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                  disabled={loading}
                  autoFocus
                />
              )}

              {error && (
                <p className="text-xs text-destructive text-center">{error}</p>
              )}

              {/* Action buttons */}
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  onClick={handleSubmit}
                  disabled={loading || !canSubmit}
                >
                  {isNewUser ? <UserPlus className="h-4 w-4 mr-2" /> : <LogIn className="h-4 w-4 mr-2" />}
                  {isNewUser ? "创建并进入" : "进入"}
                </Button>
                {selectedUser && selectedUser !== "__new__" && (
                  <Button
                    variant="outline"
                    className="text-destructive hover:bg-destructive/10"
                    onClick={handleDelete}
                    disabled={loading}
                    title="删除用户"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>

              <p className="text-[10px] text-muted-foreground text-center">
                数据保存在浏览器本地，服务器在线时自动同步
              </p>
              {offlineLogin && (
                <div className="flex items-start gap-2 p-2 rounded bg-amber-500/10 border border-amber-500/20 text-[10px] text-amber-600">
                  <WifiOff className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <p>当前为离线登录，服务器恢复后将自动重新连接。注意：服务器重启后需重新认证，同账号的其他设备可能被踢下线。</p>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
