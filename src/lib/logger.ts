/**
 * 独立的日志模块
 * 替代对 DebugPanel 的直接依赖
 */

type LogListener = (message: string) => void;

const listeners: Set<LogListener> = new Set();

/**
 * 添加日志监听器
 * @param listener 监听器函数
 * @returns 取消监听的函数
 */
export function onRagLog(listener: LogListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * RAG 日志函数
 * 用于记录 RAG 相关的操作日志
 */
export function ragLog(message: string): void {
  const timestamp = new Date().toLocaleTimeString("zh-CN");
  const logMessage = `[RAG ${timestamp}] ${message}`;

  // 输出到控制台
  console.log(logMessage);

  // 通知所有监听器
  for (const listener of listeners) {
    try {
      listener(logMessage);
    } catch {
      // 忽略监听器错误
    }
  }
}

/**
 * 通用日志函数
 */
export function log(message: string, ...args: unknown[]): void {
  console.log(`[App] ${message}`, ...args);
}

/**
 * 警告日志函数
 */
export function warn(message: string, ...args: unknown[]): void {
  console.warn(`[App] ${message}`, ...args);
}

/**
 * 错误日志函数
 */
export function error(message: string, ...args: unknown[]): void {
  console.error(`[App] ${message}`, ...args);
}
