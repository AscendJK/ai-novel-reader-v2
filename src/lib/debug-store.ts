/**
 * RAG 调试面板的全局 store（非组件部分）
 * 组件见 @/components/common/DebugPanel
 */
import { clockStamp, startsWithClock } from "@/lib/clock-format";

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

/**
 * 时刻由 store 统一贴在行首，而不是各生产者自己想起来拼一遍：
 * 真机自检那份报告就靠"熄屏前最后一行"与"亮屏后第一行"相减算时长，
 * 谁漏贴一枚这一格就判不了。已经自带时刻的行（logger 转写那类）不许多贴一层。
 */
function log(msg: string) {
  logLines.push(startsWithClock(msg) ? msg : `[${clockStamp()}] ${msg}`);
  if (logLines.length > 500) logLines.shift();
  listeners.forEach((fn) => fn());
}

export function addDebugEntry(e: Omit<DebugEntry, "id" | "time">) {
  // Only accumulate when debug panel is mounted (listeners exist)
  if (listeners.size === 0) return;
  entries.unshift({ ...e, id: ++entryId, time: Date.now() });
  if (entries.length > 10) entries.pop();
  log(`检索: ${e.query.slice(0, 60)} → ${e.results.length}条 · ${e.engine} · ${e.duration?.toFixed(2) || "?"}s`);
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
