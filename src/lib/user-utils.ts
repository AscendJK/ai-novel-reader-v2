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

/**
 * 会决定"AI 请求发去哪、用谁的额度"的设置键。
 *
 * 导出口（不带出去）、备份导入口与服务器下行口（不收进来）三处共用这一条判断——
 * 只在一头设防等于承认"key 仅存浏览器"是单向的规则。后端有同名镜像
 * （`server/sync-handler.js` 与 `server/database.js` 的 `SENSITIVE_PREFIXES`：
 * 客户端就算误传上来也不入库、不下发）。
 */
export function isSensitiveSettingKey(key: string): boolean {
  return key.startsWith("api-providers") || key.startsWith("api-active-provider");
}
