/**
 * 用户相关的工具函数
 * 消除 novel-store.ts 和 sync-bridge.ts 中的重复定义
 */

/**
 * 生成按用户名隔离的 localStorage key
 * @param base 基础 key 名称
 * @returns 带用户名前缀的 key（如果已登录）或原始 key
 */
export function userKey(base: string): string {
  const user = localStorage.getItem("sync-username");
  return user ? `${base}:${user}` : base;
}

/**
 * 获取当前登录用户名
 * @returns 用户名或 null
 */
export function getCurrentUsername(): string | null {
  return localStorage.getItem("sync-username");
}

/**
 * 检查是否已登录
 */
export function isLoggedIn(): boolean {
  return !!localStorage.getItem("sync-username");
}
