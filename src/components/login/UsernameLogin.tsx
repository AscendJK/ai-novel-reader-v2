import { useState, useEffect, useRef } from "react";
import { BookOpen, LogIn, Trash2, UserPlus, WifiOff, Server, Clock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import {
  getServerUrl, setServerUrl, detectAndSetServerUrl, probeServer,
  serverSchemeOf, explicitSchemeOf, withScheme, PROBE_FAILURE_TEXT,
  type ProbeFailure, type ServerScheme,
} from "@/lib/api-client";
import { APP_VERSION } from "@/config/version";

const RECENT_URLS_KEY = "novel-reader-recent-urls";
const MAX_RECENT = 5;

/**
 * 登录页草稿。存在的唯一理由：装成 PWA 之后，首启那一次导航发生在 Service Worker
 * 接管**之前**，拿不到跨源隔离头，于是 `main.tsx` 的 `ensureCrossOriginIsolated` 会让页面
 * 自己再刷一次（实测约 1.8 秒）。登录页只有一个输入框，用户基本都在那一秒里开始打字，
 * 刷完敲进去的用户名就没了 —— 症状是"我明明输了名字，按钮又灰回去了"。
 *
 * 用 sessionStorage 不用 localStorage：这只该救"同一次开机的那一刷"，
 * 不该在用户下次开标签页时把一个旧名字塞回登录框。
 */
const LOGIN_DRAFT_KEY = "login-draft";

function readLoginDraft(): { selected: string; typed: string } {
  try {
    const raw = sessionStorage.getItem(LOGIN_DRAFT_KEY);
    if (!raw) return { selected: "", typed: "" };
    const d = JSON.parse(raw) as { selected?: unknown; typed?: unknown };
    return {
      // 只恢复"创建新用户"这条路：选中的老用户在下拉里本来就在
      selected: d.selected === "__new__" ? "__new__" : "",
      typed: typeof d.typed === "string" ? d.typed.slice(0, 30) : "",
    };
  } catch {
    return { selected: "", typed: "" };
  }
}

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
  const [selectedUser, setSelectedUser] = useState(() => readLoginDraft().selected);
  const [newUsername, setNewUsername] = useState(() => readLoginDraft().typed);
  const [loading, setLoading] = useState(false);
  const [serverUrl, setServerUrlState] = useState(getServerUrl());
  /** 连接方式：选哪条就只连哪条，默认 http（制作人 09-29 拍）。地址里写了协议时以它为准，见 `shownScheme` */
  const [scheme, setScheme] = useState<ServerScheme>(() => serverSchemeOf(getServerUrl(), ""));
  const [serverStatus, setServerStatus] = useState<"unknown" | "checking" | "ok" | "fail">("unknown");
  /** 探测失败的原因（`probeServer` 分出来的那一类）；null 表示没探过、探通了、或那条不知道原因的入口 */
  const [serverReason, setServerReason] = useState<ProbeFailure | null>(null);
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 框里写了协议就照它显示（那两枚选中的跟着输入走）；点按钮会连输入一起改掉，见 `handlePickScheme`
  const typedScheme = explicitSchemeOf(serverUrl);
  const shownScheme = typedScheme ?? scheme;

  // 检查服务器状态
  const checkServer = async (url: string) => {
    if (!url) { setServerStatus("unknown"); setServerReason(null); return; }
    setServerStatus("checking");
    const r = await probeServer(url);
    setServerStatus(r.ok ? "ok" : "fail");
    setServerReason(r.ok ? null : r.reason);
  };

  // 换连接方式：连地址里的协议一起改掉，再按新那条重探。
  // 只改内部 state 是不够的——已存过地址的人打开面板时框里就带着 `http://`（`setServerUrl` 一律规范化过），
  // 那样这两枚对老用户永远是空的。09-29 真浏览器跑 D6 时撞到的就是这个。
  const handlePickScheme = (next: ServerScheme) => {
    setScheme(next);
    const raw = serverUrl.trim();
    if (!raw) return;
    const rewritten = withScheme(raw, next);
    setServerUrlState(rewritten);
    void checkServer(rewritten);
  };

  // 保存服务器地址
  const handleSaveServerUrl = async () => {
    const raw = serverUrl.trim().replace(/\/+$/, "");
    if (!raw) return;
    setServerStatus("checking");
    try {
      // 只探所选那一条（探不通也先把那条存下来，界面才说得出为什么连不上）
      const r = await detectAndSetServerUrl(raw, shownScheme);
      setServerUrlState(r.url);
      addRecentUrl(r.url);
      setServerStatus(r.ok ? "ok" : "fail");
      setServerReason(r.ok ? null : r.reason);
    } catch {
      setServerStatus("fail");
      setServerReason(null);
    }
    setShowServerConfig(false);
    setShowRecent(false);
  };

  // 选择最近使用的地址
  const handleSelectRecent = (url: string) => {
    setServerUrlState(url);
    setServerUrl(url);
    const fromUrl = explicitSchemeOf(url);
    if (fromUrl) setScheme(fromUrl);
    setShowRecent(false);
    inputRef.current?.focus();
  };

  // 初始检查（延迟到微任务，避免 effect 中同步 setState 造成级联渲染）
  useEffect(() => {
    const url = getServerUrl();
    if (url) {
      const t = setTimeout(() => { void checkServer(url); }, 0);
      return () => clearTimeout(t);
    }
  }, []);

  // 原来这里有一道"点框外就收起"的 mousedown 监听。删掉它：清单现在是内联的，
  // 那点它旁边的任何控件都会先触发"收起→整块往上跳"，mousedown 与 mouseup 落在不同元素上，
  // 浏览器把 click 交给共同祖先，按钮的 onClick 一次都不跑（09-29 真浏览器量到的就是这一形）。
  // 现在它只跟着"选中一条 / 保存 / 开始打字"走。

  const isNewUser = selectedUser === "__new__";
  const username = isNewUser ? newUsername.trim() : selectedUser;
  const canSubmit = username.length >= 2;

  // 草稿跟着敲走，为的是扛过首启那一次自刷（理由见 LOGIN_DRAFT_KEY 上面那段）
  useEffect(() => {
    try {
      if (isNewUser && newUsername.trim()) {
        sessionStorage.setItem(LOGIN_DRAFT_KEY, JSON.stringify({ selected: "__new__", typed: newUsername }));
      } else {
        sessionStorage.removeItem(LOGIN_DRAFT_KEY);
      }
    } catch { /* 写不进去（隐私模式之类）就退回"刷了重敲"，不许因此挡住登录 */ }
  }, [isNewUser, newUsername]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setLoading(true);
    try {
      await onLogin(username);
      // 进到书架之后这份草稿就没意义了：留着它，同一标签页下次退回登录页会凭空带出旧名字
      try { sessionStorage.removeItem(LOGIN_DRAFT_KEY); } catch { /* 同上 */ }
    } finally { setLoading(false); }
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
      <div data-testid="login-gate" className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
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
    <div data-testid="login-gate" className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
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
                  name="server-url"
                  ref={inputRef}
                  placeholder="192.168.1.100"
                  value={serverUrl}
                  onChange={(e) => {
                    setServerUrlState(e.target.value);
                    // 一开始打字就收起那份清单：它内联排在框下面，留在那儿会把行高顶来顶去
                    if (e.target.value.trim()) setShowRecent(false);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && handleSaveServerUrl()}
                  onFocus={() => { if (!serverUrl.trim() && getRecentUrls().length > 0) setShowRecent(true); }}
                  autoFocus
                />
                {/* 最近使用的地址：**内联**排在输入框下面，且只在框是空的时候展开。
                    原来它是 `absolute top-full` 浮层 + 一 focus 就展开 + 点框外才收起，三件事凑在一起
                    09-29 真浏览器里量到两种咬手：①浮层盖住下面的「连接方式」两枚，点不到；
                    ②改成内联之后，点下面任何控件都会先"点框外→收起"，那一收让整块往上跳 ~34px，
                    mousedown 与 mouseup 落在不同元素上，浏览器把 click 交给共同祖先，按钮的 onClick 根本不触发
                    （读数：radio 拿到 focus 但 aria-checked 不动）。收起改成只跟着"选中/保存/开始打字"走。 */}
                {showRecent && getRecentUrls().length > 0 && (
                  <div className="mt-1 bg-popover border rounded-md shadow-md max-h-40 overflow-y-auto">
                    {getRecentUrls().map((url) => (
                      <div key={url} className="flex items-center justify-between px-3 py-1.5 hover:bg-accent text-sm cursor-pointer group"
                        onClick={() => handleSelectRecent(url)}>
                        <div className="flex items-center gap-2 min-w-0">
                          <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="truncate">{url}</span>
                        </div>
                        <button className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-destructive"
                          aria-label="删除"
                          onClick={(e) => { e.stopPropagation(); removeRecentUrl(url); setServerUrlState(getServerUrl()); }}>
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* 连接方式：选哪条连哪条，默认 HTTP。点它会把地址开头的协议（和那条的默认端口）一起改掉 */}
              <div role="radiogroup" aria-label="连接方式" className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground shrink-0">连接方式</span>
                {(["http", "https"] as ServerScheme[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    name={`server-scheme-${s}`}
                    aria-checked={shownScheme === s}
                    onClick={() => handlePickScheme(s)}
                    className={`flex-1 rounded border px-2 py-1 text-[11px] ${
                      shownScheme === s
                        ? "border-primary text-foreground font-medium"
                        : "text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    {s === "http" ? "HTTP :5173" : "HTTPS :8443"}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">
                只填 IP 时按上面选的方式连：HTTP 走 :5173，HTTPS 走 :8443；地址里已经写了协议，点这两枚会把开头的协议一起改掉（自己写过的端口保留）。
                第一次连本机或局域网的设备，浏览器可能问一次「允许访问本地网络」——授权记在这个网站上，允许过一次就不再问。
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
                <p className="text-xs text-destructive text-center">
                  {serverReason ? PROBE_FAILURE_TEXT[serverReason].note : "无法连接到服务器，请检查地址是否正确"}
                </p>
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
                  {serverStatus === "fail" && (
                    <span className="text-destructive">● {serverReason ? PROBE_FAILURE_TEXT[serverReason].badge : "无法连接"}</span>
                  )}
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
                  data-testid="login-submit"
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
        <p className="text-[10px] text-muted-foreground text-center pb-3 -mt-1">
          前端版本 v{APP_VERSION}
        </p>
      </Card>
    </div>
  );
}
