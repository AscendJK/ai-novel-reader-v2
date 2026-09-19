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

  // 输出到控制台。capturing 挡住 console 包装的再次转发：本函数下面已经亲手
  // 通知过监听器，不挡的话每条 RAG 日志都会在 DebugPanel 里出现两遍
  capturing = true;
  try {
    console.log(logMessage);
  } finally {
    capturing = false;
  }

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

// ── 全量 console 捕获 ──────────────────────────────────────
//
// 为什么不逐点改：仓库有 270+ 处 console.*（sync/tts/rag/repositories 各占几十处），
// 把它们逐个换成 logger 只是把同样的信息换个函数名，且丢掉了 devtools 的原生分级。
// 真正的缺口是"手机/局域网用户打不开 devtools，出问题只能靠截图"——
// 所以在入口处包一层 console，让既有调用原样进 DebugPanel（有界 500 行）。
type CaptureLevel = "log" | "warn" | "error";
let captureInstalled = false;
let capturing = false;

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || a.message;
  try {
    return typeof a === "object" && a !== null
      ? JSON.stringify(a)
      : String(a);
  } catch {
    return Object.prototype.toString.call(a);   // 循环引用/function/Symbol 等
  }
}

/** 把 console 的三类输出转发给日志监听器；返回卸载函数（测试与热更新用） */
export function installConsoleCapture(): () => void {
  if (typeof console === "undefined") return () => { /* 无 console 的环境 */ };
  if (captureInstalled) return () => { /* 已安装：main.tsx 之外的重复调用不叠加包装 */ };
  captureInstalled = true;

  const originals: Record<CaptureLevel, (...args: unknown[]) => void> = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  for (const level of ["log", "warn", "error"] as CaptureLevel[]) {
    const original = originals[level];
    (console as unknown as Record<string, unknown>)[level] = (...args: unknown[]) => {
      original(...args);
      // ragLog/log/warn/error 自己已经通知过监听器，且内部会调 console：
      // 再转发一遍就是双份日志，用 capturing 标志挡住这层重入
      if (capturing) return;
      capturing = true;
      try {
        const ts = new Date().toLocaleTimeString("zh-CN");
        const text = args.map(formatArg).join(" ");
        const line = `[${ts} ${level.toUpperCase()}] ${text}`;
        for (const listener of listeners) {
          try {
            listener(line);
          } catch { /* 单个监听器异常不影响 console 与其余监听器 */ }
        }
      } catch { /* 日志绝不能弄坏业务 */ }
      finally {
        capturing = false;
      }
    };
  }

  return () => {
    for (const level of ["log", "warn", "error"] as CaptureLevel[]) {
      (console as unknown as Record<string, unknown>)[level] = originals[level];
    }
    captureInstalled = false;
  };
}
