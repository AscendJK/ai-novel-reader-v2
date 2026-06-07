/**
 * 轻量级全局 Toast 通知
 * 使用方式：import { showToast } from "./Toast";
 *           showToast("消息内容", "info" | "warn" | "success");
 */

import { useState, useEffect } from "react";
import { Info, AlertTriangle, CheckCircle, X } from "lucide-react";

type ToastType = "info" | "warn" | "success";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

let _nextId = 0;
let _setToasts: React.Dispatch<React.SetStateAction<ToastItem[]>> | null = null;
const _pendingTimers = new Set<ReturnType<typeof setTimeout>>();

export function showToast(message: string, type: ToastType = "info") {
  if (!_setToasts) return;
  const id = ++_nextId;
  _setToasts((prev) => [...prev, { id, message, type }]);
  const timer = setTimeout(() => {
    _pendingTimers.delete(timer);
    _setToasts?.((prev) => prev.filter((t) => t.id !== id));
  }, 5000);
  _pendingTimers.add(timer);
}

const icons: Record<ToastType, React.ReactNode> = {
  info: <Info className="h-4 w-4 text-blue-500 shrink-0" />,
  warn: <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />,
  success: <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />,
};

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    _setToasts = setToasts;
    const onReconnected = () => showToast("已重新连接到服务器。注意：此操作可能已断开其他设备的连接。", "warn");
    window.addEventListener("sync-reconnected", onReconnected);
    return () => {
      _setToasts = null;
      window.removeEventListener("sync-reconnected", onReconnected);
      // 清理所有 pending 定时器
      for (const t of _pendingTimers) clearTimeout(t);
      _pendingTimers.clear();
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
            onClick={() => _setToasts?.((prev) => prev.filter((x) => x.id !== t.id))}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
