/**
 * 轻量级全局 Toast 通知（非组件 store 部分）
 * 组件见 @/components/common/Toast
 */

import type React from "react";

export type ToastType = "info" | "warn" | "success";

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

let _nextId = 0;
let _setToasts: React.Dispatch<React.SetStateAction<ToastItem[]>> | null = null;
const _pendingTimers = new Set<ReturnType<typeof setTimeout>>();

/** 由 ToastContainer 挂载时注册 dispatch */
export function setToastDispatch(fn: React.Dispatch<React.SetStateAction<ToastItem[]>>) {
  _setToasts = fn;
}

/** 由 ToastContainer 卸载时清除 dispatch */
export function clearToastDispatch() {
  _setToasts = null;
}

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

/** 清理所有待执行的定时器（供组件卸载时调用） */
export function clearPendingToastTimers() {
  for (const t of _pendingTimers) clearTimeout(t);
  _pendingTimers.clear();
}
