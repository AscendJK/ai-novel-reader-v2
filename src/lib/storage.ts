/**
 * 安全的 localStorage 访问工具
 * localStorage 在隐私模式下可能抛出异常，统一用 try/catch 包裹
 */

/** 安全读取 localStorage */
export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 安全写入 localStorage */
export function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

/** 安全删除 localStorage */
export function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** 安全读取并解析为 boolean */
export function safeGetBool(key: string, defaultVal = false): boolean {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return defaultVal;
  }
}

/** 安全读取并解析为 number */
export function safeGetNum(key: string, defaultVal: number, validator?: (v: number) => boolean): number {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = parseFloat(stored);
      if (!isNaN(parsed) && (!validator || validator(parsed))) return parsed;
    }
  } catch {
    // ignore
  }
  return defaultVal;
}
