/**
 * 认证中间件
 * 从 index.js 中提取
 */

import { validateSession } from "../sync-handler.js";

/**
 * 从请求中获取当前用户的用户名
 * @param {import("express").Request} req
 * @returns {string|null} 用户名或 null
 */
export function getSessionUsername(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return validateSession(auth.slice(7));
  }
  return null;
}

/**
 * 认证中间件 - 验证用户是否已登录
 * 如果认证失败，返回 401 错误
 * 如果认证成功，将用户名添加到 req.username
 *
 * @example
 * ```js
 * app.get("/api/protected", requireAuth, (req, res) => {
 *   const username = req.username;
 *   // ...
 * });
 * ```
 */
export function requireAuth(req, res, next) {
  const username = getSessionUsername(req);
  if (!username) {
    return res.status(401).json({ error: "需要登录" });
  }
  req.username = username;
  next();
}

/**
 * 可选认证中间件 - 尝试获取用户名，但不强制要求登录
 * 如果有有效的认证信息，将用户名添加到 req.username
 * 如果没有认证信息，继续处理请求（req.username 为 undefined）
 *
 * @example
 * ```js
 * app.get("/api/public", optionalAuth, (req, res) => {
 *   const username = req.username; // 可能为 undefined
 *   // ...
 * });
 * ```
 */
export function optionalAuth(req, res, next) {
  const username = getSessionUsername(req);
  req.username = username || undefined;
  next();
}

/**
 * 兼容旧代码的认证函数
 * @deprecated 请使用 requireAuth 中间件
 */
export function authNovel(req, res) {
  const username = getSessionUsername(req);
  if (!username) {
    res.status(401).json({ error: "需要登录" });
    return false;
  }
  req._username = username;
  return true;
}
