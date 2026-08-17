/**
 * RAG 调试面板的全局 store（非组件部分）
 * 组件见 @/components/common/DebugPanel
 */

export interface DebugEntry {
  id: number;
  time: number;
  query: string;
  duration?: number;
  results: { content: string; score: number }[];
  engine: string;
}

let entryId = 0;
const listeners: Set<() => void> = new Set();
const entries: DebugEntry[] = [];
const logLines: string[] = [];

function log(msg: string) {
  // 已经是格式化的消息，直接使用
  logLines.push(msg);
  if (logLines.length > 500) logLines.shift();
  listeners.forEach((fn) => fn());
}

export function addDebugEntry(e: Omit<DebugEntry, "id" | "time">) {
  // Only accumulate when debug panel is mounted (listeners exist)
  if (listeners.size === 0) return;
  entries.unshift({ ...e, id: ++entryId, time: Date.now() });
  if (entries.length > 10) entries.pop();
  const ts = new Date().toLocaleTimeString();
  log(`[${ts}] 检索: ${e.query.slice(0, 60)} → ${e.results.length}条 · ${e.engine} · ${e.duration?.toFixed(2) || "?"}s`);
  listeners.forEach((fn) => fn());
}

export function clearDebugEntries() {
  entries.length = 0;
  logLines.length = 0;
  listeners.forEach((fn) => fn());
}

/** 订阅 store 变化（组件挂载时调用，返回取消订阅函数） */
export function subscribeDebugStore(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 向调试日志追加一条消息（供 ragLog 事件转发） */
export function appendDebugLog(msg: string) {
  log(msg);
}

/** 读取当前检索条目（只读引用） */
export function getDebugEntries(): readonly DebugEntry[] {
  return entries;
}

/** 读取当前日志行（只读引用） */
export function getDebugLogLines(): readonly string[] {
  return logLines;
}
