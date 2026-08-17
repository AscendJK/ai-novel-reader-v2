/**
 * 轻量级全局 Toast 通知容器组件
 * 非组件 store 见 @/lib/toast-store
 */

import { useState, useEffect } from "react";
import { Info, AlertTriangle, CheckCircle, X } from "lucide-react";
import {
  showToast,
  setToastDispatch,
  clearToastDispatch,
  clearPendingToastTimers,
  type ToastType,
  type ToastItem,
} from "@/lib/toast-store";

const icons: Record<ToastType, React.ReactNode> = {
  info: <Info className="h-4 w-4 text-blue-500 shrink-0" />,
  warn: <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />,
  success: <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />,
};

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    setToastDispatch(setToasts);
    const onReconnected = () => showToast("已重新连接到服务器。注意：此操作可能已断开其他设备的连接。", "warn");
    const onOffline = () => showToast("服务器不可达，已自动切换到离线模式。阅读和笔记仍可用。", "warn");
    window.addEventListener("sync-reconnected", onReconnected);
    window.addEventListener("sync-offline", onOffline);
    return () => {
      clearToastDispatch();
      window.removeEventListener("sync-reconnected", onReconnected);
      window.removeEventListener("sync-offline", onOffline);
      // 清理所有 pending 定时器
      clearPendingToastTimers();
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="bg-card border rounded-lg shadow-lg px-4 py-2.5 flex items-start gap-2.5 text-sm"
          style={{ animation: "slideUp 0.2s ease-out" }}
        >
          {icons[t.type]}
          <span className="flex-1">{t.message}</span>
          <button
            className="text-muted-foreground hover:text-foreground shrink-0"
            onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            aria-label="关闭通知"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
