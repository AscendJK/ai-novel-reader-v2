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
 * 生效的服务器地址：显式配置优先；未配置且页面本身由后端伺服（非 GitHub Pages 托管）时，
 * 回退到当前页面源（同源模式）。GitHub Pages 前端未配置服务器时返回空串（离线模式，与既有行为一致）。
 */
export function getEffectiveServerUrl(): string {
  const configured = localStorage.getItem(SERVER_URL_KEY) || "";
  if (configured) return configured;
  if (typeof window !== "undefined" &&
      !window.location.hostname.endsWith(".github.io") &&
      !window.location.hostname.endsWith(".github.com")) {
    return window.location.origin;
  }
  return "";
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
  const base = getEffectiveServerUrl();
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
 * 智能解析并保存服务器地址：
 * - 输入含显式协议（http:// 或 https://）→ 直接按现有规则规范化保存（不探测）；
 *   其中无端口的 https 显式补 :8443、无端口 http 显式补 :5173
 * - 裸 IP/域名（无协议无端口）→ 依次探测 https://<host>:8443 与 http://<host>:5173，
 *   第一个连通者胜出并保存（双端口在线时优先 HTTPS）；全部不通时保存 http://…:5173
 *   （让后续连接失败的错误提示有明确指向）。
 *
 * @param input 用户输入的地址
 * @returns 最终保存的地址（已规范化）
 */
export async function detectAndSetServerUrl(input: string): Promise<string> {
  const trimmed = input.trim().replace(/[/:]+$/, "");
  if (!trimmed) {
    throw new Error("服务器地址不能为空");
  }

  const hasProtocol = /^https?:\/\//i.test(trimmed);
  const hasPort = /:\d+$/.test(trimmed);
  if (hasProtocol || hasPort) {
    // 显式协议或端口：尊重用户选择，直接规范化保存
    const normalized = normalizeServerUrl(trimmed);
    setServerUrl(normalized);
    return normalized;
  }

  // 裸 IP/域名：双端口探测，HTTPS 优先
  const candidates = ["https://" + trimmed + ":8443", "http://" + trimmed + ":5173"];
  for (const candidate of candidates) {
    const ok = await checkServerReachable(candidate);
    if (ok) {
      setServerUrl(candidate);
      return candidate;
    }
  }

  // 全部不可达：保存 HTTP 默认值，交由后续连接流程给出明确错误
  const fallback = "http://" + trimmed + ":5173";
  setServerUrl(fallback);
  return fallback;
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
