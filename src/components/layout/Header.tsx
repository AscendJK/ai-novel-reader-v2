import { useState } from "react";
import { ArrowLeft, Book, Settings, Moon, Sun, LogOut, User, StickyNote, WifiOff, Wifi, Download, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUIStore } from "@/stores/ui-store";
import { useRAGStore } from "@/stores/rag-store";
import { syncClient } from "@/sync/sync-client";

interface HeaderProps {
  inBook: boolean;
  bookTitle?: string;
  onBack: () => void;
  onSettings: () => void;
  onNotes: () => void;
}

export function Header({ inBook, bookTitle, onBack, onSettings, onNotes }: HeaderProps) {
  const { theme, toggleTheme, offlineMode, setOfflineMode } = useUIStore();
  const username = syncClient.user || localStorage.getItem("sync-username");
  const [showUser, setShowUser] = useState(false);
  const [showOfflineTip, setShowOfflineTip] = useState(false);

  // 判断是否为手动离线（非自动离线）
  const isManualOffline = offlineMode && !syncClient.isAutoOffline;

  const handleToggleOffline = () => {
    if (offlineMode) {
      // 切换回在线模式 — 重置自动离线状态
      syncClient.resetAutoOffline();
      setOfflineMode(false);
      setShowOfflineTip(false);
      // 触发同步
      if (syncClient.isLoggedIn) {
        syncClient.pushNow();
      }
    } else {
      // 切换到离线模式
      setOfflineMode(true);
    }
  };

  const handleLogout = async () => {
    if (!window.confirm("确定退出登录？\n\n数据保留在本地，重新登录同一用户名可恢复。")) return;
    // logout() 会发送 disconnect 请求、清除定时器、重置所有状态
    syncClient.logout();
    window.location.reload();
  };

  return (
    <header className="border-b bg-card px-4 py-2.5 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        {inBook ? (
          <>
            <Button variant="outline" size="sm" onClick={onBack} className="shrink-0">
              <ArrowLeft className="h-4 w-4 md:mr-1.5" />
              <span className="hidden md:inline">书架</span>
            </Button>
            <span className="hidden md:block w-px h-5 bg-border mx-1" />
            <Book className="h-5 w-5 text-primary shrink-0" />
            <h1 className="text-sm font-semibold truncate max-w-[150px] md:max-w-[300px]">《{bookTitle}》</h1>
          </>
        ) : (
          <>
            <Book className="h-5 w-5 text-primary" />
            <h1 className="text-base font-semibold hidden md:block">AI 小说精读助手</h1>
          </>
        )}
      </div>

      <div className="flex items-center gap-1">
        {/* 离线模式标识 */}
        {offlineMode && (
          <div className="relative">
            <button
              className={`text-xs flex items-center gap-1 px-1.5 py-0.5 rounded mr-1 transition-colors ${
                isManualOffline
                  ? "text-blue-500 bg-blue-500/10 hover:bg-blue-500/20"
                  : "text-amber-500 bg-amber-500/10 hover:bg-amber-500/20"
              }`}
              onClick={() => setShowOfflineTip((v) => !v)}
              title={isManualOffline ? "手动离线模式 - 点击查看详情" : "自动离线模式 - 点击查看详情"}
            >
              {isManualOffline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              <span className="hidden md:inline">
                {isManualOffline ? "手动离线" : "离线"}
              </span>
            </button>

            {/* 离线模式详情弹窗 */}
            {showOfflineTip && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowOfflineTip(false)} />
                <div className="absolute top-full right-0 mt-1.5 z-50 bg-popover border rounded-md shadow-md p-3 text-xs whitespace-nowrap">
                  <div className="space-y-2">
                    <p className="font-medium">
                      {isManualOffline ? "手动离线模式" : "自动离线模式"}
                    </p>
                    <p className="text-muted-foreground">
                      {isManualOffline
                        ? "您手动开启了离线模式，服务器同步已暂停。"
                        : "服务器不可达，已自动切换到离线模式。"}
                    </p>
                    <p className="text-muted-foreground">
                      离线模式下：阅读、笔记、AI 分析（直连 API）可用。
                    </p>
                    {!isManualOffline && (
                      <p className="text-muted-foreground/70">
                        服务器重启后所有设备需重新认证，在线恢复时同账号的其他设备可能被踢下线。
                      </p>
                    )}
                    <Button
                      size="sm"
                      className="w-full h-7 text-xs"
                      onClick={handleToggleOffline}
                    >
                      <Wifi className="h-3 w-3 mr-1" />
                      切换回在线
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* 模型下载状态 */}
        <ModelDownloadIndicator />

        {/* 在线状态（可点击切换到离线） */}
        {!offlineMode && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-green-500"
            onClick={handleToggleOffline}
            title="在线 - 点击切换到离线模式"
          >
            <Wifi className="h-3.5 w-3.5" />
          </Button>
        )}

        {/* Username + logout */}
        {username && (
          <div className="flex items-center gap-2 mr-1 relative">
            <button
              className="text-xs text-muted-foreground flex items-center gap-1 bg-muted px-2 py-1 rounded hover:bg-accent transition-colors"
              onClick={() => setShowUser((v) => !v)}
              title={username}
            >
              <User className="h-3 w-3" />
              <span className="hidden md:inline">{username}</span>
            </button>
            {showUser && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowUser(false)} />
                <div className="absolute top-full left-0 mt-1.5 z-50 bg-popover border rounded-md shadow-md px-3 py-1.5 text-xs whitespace-nowrap">
                  {username}
                </div>
              </>
            )}
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleLogout} title="退出登录">
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        {!inBook && (
          <Button variant="ghost" size="icon" onClick={onNotes} title="全部笔记">
            <StickyNote className="h-4 w-4" />
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={onSettings} title="设置">
          <Settings className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          title={theme === "light" ? "暗色模式" : "亮色模式"}
        >
          {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </Button>
      </div>
    </header>
  );
}

function ModelDownloadIndicator() {
  const { currentDownload, downloadProgress } = useRAGStore();

  if (!currentDownload) return null;

  const engineName = currentDownload.split("/").pop() || currentDownload;

  return (
    <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-blue-500" title={downloadProgress}>
      <Loader2 className="h-3 w-3 animate-spin" />
      <span className="hidden md:inline max-w-[150px] truncate">
        {downloadProgress || `下载 ${engineName}...`}
      </span>
    </div>
  );
}
