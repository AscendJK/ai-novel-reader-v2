import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw, WifiOff } from "lucide-react";

let _updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;

export function setUpdateSW(fn: (reloadPage?: boolean) => Promise<void>) {
  _updateSW = fn;
}

export function UpdateBanner() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);

  useEffect(() => {
    const onNeedRefresh = () => setNeedRefresh(true);
    const onOfflineReady = () => setOfflineReady(true);
    window.addEventListener("sw-need-refresh", onNeedRefresh);
    window.addEventListener("sw-offline-ready", onOfflineReady);
    return () => {
      window.removeEventListener("sw-need-refresh", onNeedRefresh);
      window.removeEventListener("sw-offline-ready", onOfflineReady);
    };
  }, []);

  if (!needRefresh && !offlineReady) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-card border rounded-lg shadow-lg px-4 py-2.5 flex items-center gap-3 text-sm">
      {needRefresh ? (
        <>
          <RefreshCw className="h-4 w-4 text-primary shrink-0" />
          <span>有新版本可用</span>
          <Button size="sm" className="h-7 text-xs" onClick={() => _updateSW?.(true)}>
            更新
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setNeedRefresh(false)}>
            忽略
          </Button>
        </>
      ) : (
        <>
          <WifiOff className="h-4 w-4 text-green-500 shrink-0" />
          <span>离线资源已缓存</span>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOfflineReady(false)}>
            知道了
          </Button>
        </>
      )}
    </div>
  );
}
