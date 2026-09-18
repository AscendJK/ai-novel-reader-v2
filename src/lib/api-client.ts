/**
 * 统一的 API 客户端
 * 支持配置后端服务器地址，用于前后端分离部署（GitHub Pages + 本地后端）
 */

import { authHeaders } from "./auth-headers";

const SERVER_URL_KEY = "server-url";

/**
 * 获取后端服务器地址
 * @returns 服务器地址（如 "http://192.168.1.100:8443"），未配置时返回空字符串
 */
export function getServerUrl(): string {
  return localStorage.getItem(SERVER_URL_KEY) || "";
}

/**
 * 规范化服务器地址：补协议头、移除末尾斜杠/冒号、无端口时按协议补默认端口。
 * https 默认 8443（mkcert HTTPS），其余默认 5173（HTTP）。
 */
export function normalizeServerUrl(input: string): string {
  let url = input;
  // 确保 URL 有协议头
  if (!/^https?:\/\//i.test(url)) {
    url = "http://" + url;
  }
  // 移除末尾斜杠和多余的冒号
  url = url.replace(/[/:]+$/, "");
  // 无端口时按协议补默认端口：https → 8443，http → 5173
  if (!/:\d+$/.test(url)) {
    url += /^https:\/\//i.test(url) ? ":8443" : ":5173";
  }
  return url;
}

/**
 * 设置后端服务器地址
 * @param url 服务器地址（如 "https://192.168.1.100:8443"）
 */
export function setServerUrl(url: string): void {
  localStorage.setItem(SERVER_URL_KEY, normalizeServerUrl(url));
}

/**
 * 清除后端服务器地址
 */
export function clearServerUrl(): void {
  localStorage.removeItem(SERVER_URL_KEY);
}

/**
 * 检查是否已配置服务器地址
 */
export function hasServerUrl(): boolean {
  return !!localStorage.getItem(SERVER_URL_KEY);
}

/**
 * 统一的 API fetch 封装
 * 自动拼接服务器地址和认证头
 *
 * @param path API 路径（如 "/api/sync/register"）
 * @param init fetch 选项
 * @returns Promise<Response>
 * @throws Error 未配置服务器地址时抛出
 */
export async function apiFetch(path: string, init?: RequestInit, skipAuth?: boolean): Promise<Response> {
  const base = getServerUrl();
  if (!base) {
    throw new Error("未配置服务器地址，请在登录页面配置后端地址");
  }

  const url = `${base}${path}`;

  // 合并认证头（skipAuth 时跳过）
  const headers = skipAuth
    ? { ...(init?.headers || {}) }
    : { ...authHeaders(), ...(init?.headers || {}) };

  return fetch(url, {
    ...init,
    headers,
  });
}

/**
 * 检查服务器是否可达
 * @param url 服务器地址
 * @returns Promise<boolean>
 */
export async function checkServerReachable(url: string): Promise<boolean> {
  try {
    // 规范化：补协议头 + 按协议补默认端口（https → 8443，http → 5173）
    url = normalizeServerUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5秒超时

    const response = await fetch(`${url}/api/sync/check-user/test`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);
    return response.ok || response.status === 404; // 404 也算可达
  } catch (e) {
    console.debug("[api-client] 服务器不可达:", url, e instanceof Error ? e.message : e);
    return false;
  }
}
