import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { Header } from "./Header";
import { BookSelect } from "./BookSelect";
import { ReadingPanel } from "@/components/reader/ReadingPanel";
import { ApiSettings } from "@/components/settings/ApiSettings";
import { UsernameLogin } from "@/components/login/UsernameLogin";
import { DebugPanel } from "@/components/common/DebugPanel";
import { ShortcutHelp } from "@/components/common/ShortcutHelp";
import { GlobalNotes } from "@/components/notes/GlobalNotes";
import { LocalErrorBoundary } from "@/components/common/LocalErrorBoundary";
import { useKeyboardShortcuts, type ShortcutBinding } from "@/hooks/useKeyboardShortcuts";
import { useRAGStore } from "@/stores/rag-store";
import { setupModelLoader } from "@/rag/model-loader";
import { broadcast } from "@/lib/broadcast";
import { setCurrentNovelIdGetter } from "@/rag/rag-cache-utils";
import { useSyncOrchestration } from "@/hooks/useSyncOrchestration";

// Configure Transformers.js to load models from local public/models/
setupModelLoader();
import { useUIStore } from "@/stores/ui-store";
import { useNovelStore } from "@/stores/novel-store";
import { loadAllNovels, loadSummaries, getLocalUsers } from "@/db/repositories";
import { useSummaryStore } from "@/stores/summary-store";
import { useAPIStore } from "@/stores/api-store";
import { setCurrentUser, sharedDB } from "@/db/database";
import { syncClient } from "@/sync/sync-client";

export function AppLayout() {
  const theme = useUIStore((s) => s.theme);
  const debugMode = useUIStore((s) => s.debugMode);
  const offlineMode = useUIStore((s) => s.offlineMode);
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const setCurrentNovel = useNovelStore((s) => s.setCurrentNovel);
  const addNovel = useNovelStore((s) => s.addNovel);
  const { setSummaries } = useSummaryStore();
  const [showSettings, setShowSettings] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [syncReady, setSyncReady] = useState(false);
  const [loginError] = useState<string | null>(null);
  const [localUsers, setLocalUsers] = useState<string[]>(getLocalUsers);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const dbInitialized = useRef(false);

  const onSyncReady = useCallback(() => setSyncReady(true), []);

  const { handleLogin, handleDeleteUser, startSync, syncJoinedNovels } = useSyncOrchestration({
    onSyncReady,
    setLocalUsers,
  });

  // 同步初始化用户数据库（只在首次渲染时执行）
  if (!dbInitialized.current) {
    dbInitialized.current = true;
    const storedUser = localStorage.getItem("sync-username");
    if (storedUser) {
      try {
        setCurrentUser(storedUser);
      } catch { /* ignore */ }
    }
    setCurrentNovelIdGetter(() => useNovelStore.getState().currentNovel?.id);
  }

  const globalShortcuts = useMemo<ShortcutBinding[]>(() => [
    { key: "t", action: () => useUIStore.getState().toggleTheme(), description: "切换主题" },
    { key: "Escape", action: () => { setShowSettings(false); setShowNotes(false); setShowShortcutHelp(false); }, description: "关闭弹窗" },
    { key: "?", shift: true, action: () => setShowShortcutHelp((v) => !v), description: "显示快捷键帮助" },
  ], []);
  useKeyboardShortcuts(globalShortcuts);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    useAPIStore.getState().loadFromDB();
    const currentUser = localStorage.getItem("sync-username");
    if (currentUser) {
      loadAllNovels().then((novels) => {
        novels.forEach((n) => addNovel(n));
      });
    }
    (async () => {
      try {
        const all = await sharedDB.ragCache.toArray();
        const validKeys = new Set<string>();
        let totalBytes = 0;
        for (const entry of all) {
          if (entry.vectorsBuffer && entry.dim && entry.chunkCount) {
            totalBytes += entry.chunkCount * entry.dim * 4;
            if (entry.id) validKeys.add(entry.id);
          }
        }
        useRAGStore.setState({ cachedKeys: validKeys, ragCacheSizeBytes: totalBytes });
      } catch { /* ignore */ }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (currentNovel) {
      loadSummaries(currentNovel.id).then((dbSummaries) => {
        if (dbSummaries.length > 0) setSummaries(dbSummaries);
      });
    }
  }, [currentNovel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync integration (auto-login from stored session) ──
  useEffect(() => {
    const hasStoredSession = !!localStorage.getItem("sync-username");
    if (hasStoredSession) setSyncReady(true);
    if (offlineMode || !hasStoredSession) return;
    startSync();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (offlineMode) return;
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && syncClient.isLoggedIn) {
        syncClient.pushNow();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [offlineMode]);

  useEffect(() => {
    const unsubs = [
      broadcast.onSyncComplete(() => {
        if (syncClient.isLoggedIn && !offlineMode) {
          syncClient.pushNow();
        }
      }),
      broadcast.onUserSwitched((username) => {
        const currentUser = localStorage.getItem('sync-username');
        if (currentUser !== username) {
          window.location.reload();
        }
      }),
      broadcast.onLogout(() => {
        window.location.reload();
      }),
    ];
    return () => unsubs.forEach(unsub => unsub());
  }, [offlineMode]);

  const handleBackToLibrary = useCallback(() => {
    setShowSettings(false);
    setCurrentNovel(null);
  }, [setCurrentNovel]);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      {/* Login / syncing overlay — blocks UI until first sync completes */}
      {!syncReady && (
        <UsernameLogin
          localUsers={localUsers}
          onLogin={handleLogin}
          onDelete={handleDeleteUser}
          error={loginError}
          syncing={syncClient.isLoggedIn}
          offlineLogin={offlineMode}
        />
      )}

      <Header
        inBook={!!currentNovel}
        bookTitle={currentNovel?.title}
        onBack={handleBackToLibrary}
        onSettings={() => setShowSettings(true)}
        onNotes={() => setShowNotes(true)}
      />
      <main className="flex-1 overflow-hidden relative">
        {/* Reading — always mounted so panel state survives */}
        <div style={{ display: !showSettings && currentNovel ? undefined : "none" }} className="h-full">
          <LocalErrorBoundary name="ReadingPanel">
            <ReadingPanel />
          </LocalErrorBoundary>
        </div>
        {/* Settings overlay */}
        {showSettings && (
          <div className="h-full overflow-auto">
            <ApiSettings onBack={() => setShowSettings(false)} />
          </div>
        )}
        {/* Notes overlay */}
        {showNotes && !currentNovel && (
          <div className="h-full overflow-auto">
            <GlobalNotes onBack={() => setShowNotes(false)} />
          </div>
        )}
        {/* Book select — key forces remount when sync completes */}
        {!currentNovel && !showSettings && !showNotes && (
          <div className="h-full overflow-auto" key={String(syncReady)}>
            <BookSelect />
          </div>
        )}
      </main>
      {debugMode && !isMobile && <DebugPanel />}
      {showShortcutHelp && (
        <ShortcutHelp
          shortcuts={[
            ...globalShortcuts,
            { key: "ArrowLeft", action: () => {}, description: "滚动: 上一章 / 翻页: 上一页" },
            { key: "ArrowRight", action: () => {}, description: "滚动: 下一章 / 翻页: 下一页" },
            { key: " ", action: () => {}, description: "翻页模式: 下一页" },
            { key: "+", action: () => {}, description: "增大字号" },
            { key: "-", action: () => {}, description: "减小字号" },
            { key: "i", action: () => {}, description: "切换沉浸模式" },
          ]}
          onClose={() => setShowShortcutHelp(false)}
        />
      )}
    </div>
  );
}
