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
export async function apiFetch(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
  skipAuth?: boolean,
): Promise<Response> {
  const base = getEffectiveServerUrl();
  if (!base) {
    throw new Error("未配置服务器地址，请在登录页面配置后端地址");
  }

  const url = `${base}${path}`;

  // 合并认证头（skipAuth 时跳过）
  const { timeoutMs, ...fetchInit } = init ?? {};
  const headers = skipAuth
    ? { ...(init?.headers || {}) }
    : { ...authHeaders(), ...(init?.headers || {}) };
  // 总超时只在调用方明确要求时加：SSE 进度流（prepareTTS）、模型分片下载这类
  // 长请求会被总超时掐断，它们自己带 signal 或不带
  const signal = timeoutMs && !fetchInit.signal ? AbortSignal.timeout(timeoutMs) : fetchInit.signal;

  return fetch(url, {
    ...fetchInit,
    headers,
    signal,
  });
}

/** 登录页那枚「连接方式」的两种取值（制作人 09-29 拍：选了哪条就只连哪条，默认 HTTP） */
export type ServerScheme = "http" | "https";

/** 地址里写了协议就返回那个协议；没写返回 null（这一格只说"他到底写了什么"，不替它编默认值） */
export function explicitSchemeOf(input: string): ServerScheme | null {
  const trimmed = (input ?? "").trim();
  if (/^https:\/\//i.test(trimmed)) return "https";
  if (/^http:\/\//i.test(trimmed)) return "http";
  return null;
}

/**
 * 这一格该显示哪个协议：**输入框里写了协议就以它为准**，否则跟已生效的那个地址，
 * 两个都没有就是默认的 http。选择器的状态只从这里算，不另存一份，免得两处各说各话。
 */
export function serverSchemeOf(input: string, effective: string = getServerUrl()): ServerScheme {
  return explicitSchemeOf(input) ?? explicitSchemeOf(effective) ?? "http";
}

/**
 * 把用户填的东西与所选协议拼成最终地址（纯函数，不保存也不探测）。
 * 界面上"切换协议时立刻重探一次"与"保存"两条路共用它，免得一个拼出来另一个拼出来不一样。
 */
export function composeServerUrl(input: string, scheme: ServerScheme): string {
  const trimmed = input.trim().replace(/[/:]+$/, "");
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `${scheme}://${trimmed}`;
  return normalizeServerUrl(withScheme);
}

/**
 * 把地址里的协议换成所选那一条（界面点按钮时用它，所以按钮对"已经存过地址"的人也真的管用）。
 * 端口跟着换的条件是它**正好是另一条的默认端口**；用户自己写过的端口原样保留。
 */
export function withScheme(input: string, scheme: ServerScheme): string {
  const body = (input ?? "").trim().replace(/^https?:\/\//i, "").replace(/[/:]+$/, "");
  if (!body) return "";
  const otherDefault = scheme === "http" ? ":8443" : ":5173";
  const mine = scheme === "http" ? ":5173" : ":8443";
  const ported = body.endsWith(otherDefault) ? body.slice(0, -otherDefault.length) + mine : body;
  return normalizeServerUrl(`${scheme}://${ported}`);
}

/**
 * 按所选的连接方式解析并保存服务器地址。
 * - 输入含显式协议 → 以输入为准（绝不被选择器改写），无端口时按该协议补默认端口；
 * - 裸 IP/域名 → 拼成所选协议，无端口补 `:5173`／`:8443`；
 * - **只探所选那一条**，不再自动改试另一条（旧口径"双端口在线时优先 HTTPS"作废：
 *   局域网机器没开 8443 是常态，白撞一发实测要吃 2 秒，而"哪条通"用户自己最清楚）；
 * - 探不通也照样保存所选那条，并把原因带回给界面——存不存与通不通是两件事。
 */
export async function detectAndSetServerUrl(
  input: string,
  scheme: ServerScheme = "http",
): Promise<{ url: string; ok: boolean; reason: ProbeFailure | null }> {
  const url = composeServerUrl(input, scheme);
  if (!url) {
    throw new Error("服务器地址不能为空");
  }
  setServerUrl(url);
  const probe = await probeServer(url);
  return { url, ok: probe.ok, reason: probe.reason };
}

/**
 * 检查服务器是否可达
 * @param url 服务器地址
 * @returns Promise<boolean>
 */
export async function checkServerReachable(url: string): Promise<boolean> {
  return (await probeServer(url)).ok;
}

/** 探测失败分成哪几类（每一类都是浏览器里真能确定的信号，见 `probeServer` 上面那段） */
export type ProbeFailure = "http-status" | "mixed-content" | "local-network-blocked" | "timeout" | "unreachable";

/**
 * 每一类各自的话：badge 走状态行那枚徽标，note 走「配置」对话框下面那行长话。
 * 放在这儿而不是抄在组件里，是为了让「类别 → 话」只有这一处出处（判据 PR5 钉的就是这个）。
 */
export const PROBE_FAILURE_TEXT: Record<ProbeFailure, { badge: string; note: string }> = {
  "http-status": {
    badge: "后端有回应",
    note: "后端答了话，只是那一句没答对（状态码不是 200 也不是 404）。这不是地址错了，去看后端的日志。",
  },
  "mixed-content": {
    badge: "需 HTTPS",
    note: "这个页面是 HTTPS，而你填的是公网上明文的 http:// 地址——浏览器在出门前就不许连。请把地址改成 https:// 开头。"
      + "（本机与局域网地址不受这一条限制，那一类失败另有原因。）",
  },
  "local-network-blocked": {
    badge: "被拦住",
    note: "浏览器把这个地址按「本地网络访问」拦下了（这一站的权限是被拒状态）。点地址栏那枚权限图标，把「本地网络访问」改成允许——"
      + "这份授权记在这个网站身上，点一次以后就不再问。如果本来就是允许的，那就是端口不对或后端没起。",
  },
  timeout: {
    badge: "无响应",
    note: "等了 5 秒没有回应：端口对不上，或者后端没在跑。",
  },
  unreachable: {
    badge: "无法连接",
    note: "连不上这个地址：端口不对、后端没起，或它的证书浏览器不认。",
  },
};

const PROBE_TIMEOUT_MS = 5000;
const REACHABILITY_PATH = "/api/sync/check-user/test";

function probeHostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** 回环：浏览器把它们当 potentially trustworthy，所以 https 页面连 http://127.0.0.1 不算混合内容（09-29 实测过这一格） */
function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || /^127\./.test(h) || h === "::1";
}

/** 本机/局域网地址：只有对这些地址，「本地网络访问」权限才有解释力 */
function isLocalAddressHost(host: string): boolean {
  if (!host) return false;
  if (isLoopbackHost(host)) return true;
  if (/^(10\.|192\.168\.|169\.254\.)/.test(host)) return true;
  const second = /^172\.(\d+)\./.exec(host);
  if (second) return Number(second[1]) >= 16 && Number(second[1]) <= 31;
  return host.endsWith(".local");
}

/** 只有"被拒"算证据；granted 与 prompt 说明不了任何事，查询失败（老浏览器）也不算 */
async function localNetworkPermissionDenied(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: "local-network-access" as PermissionName });
    return status.state === "denied";
  } catch {
    return false;
  }
}

/**
 * 顺序就是把握度：后端答过话 → 别谈拦截；然后是混合内容，但**只有公网明文目标**才算它——
 * 09-29 深夜在 `https://ascendjk.github.io` 里真浏览器量过：`http://example.com` 0～1 毫秒就被拦，
 * 而 `http://192.168.1.10:5173` 4 毫秒拿到 HTTP 200、`http://192.168.1.99:5173` 走了 21 秒才
 * `ERR_CONNECTION_TIMED_OUT`。本机/局域网那一路上管它的是「本地网络访问」这道授权，不是混合内容，
 * 把局域网失败说成"浏览器不许连 HTTP"会把人指去配一个根本不需要配的 8443。
 */
function classifyProbeFailure(o: {
  pageIsSecure: boolean;
  targetUrl: string;
  timedOut: boolean;
  localNetworkDenied: boolean;
  httpStatus: number | null;
}): ProbeFailure {
  if (o.httpStatus !== null) return "http-status";
  const host = probeHostOf(o.targetUrl);
  const scheme = /^https:\/\//i.test(o.targetUrl) ? "https" : "http";
  if (o.pageIsSecure && scheme === "http" && !isLocalAddressHost(host)) return "mixed-content";
  if (o.localNetworkDenied) return "local-network-blocked";
  if (o.timedOut) return "timeout";
  return "unreachable";
}

/**
 * 探测后端并把"为什么不行"分清楚。
 *
 * 分成能确定的那几格，剩下的一律归到 `unreachable` 那句总括：JS 里只看得到一个
 * `TypeError: Failed to fetch`，它**分不出**"端口没人听"与"证书浏览器不认"，所以那句话必须把两种可能一起报出来，
 * 不许再像以前那样只指"请检查地址是否正确"这一条错因。
 */
export async function probeServer(url: string): Promise<{ ok: boolean; reason: ProbeFailure | null }> {
  const target = normalizeServerUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let httpStatus: number | null = null;
  let failed = false;
  try {
    const response = await fetch(`${target}${REACHABILITY_PATH}`, { signal: controller.signal });
    if (response.ok || response.status === 404) return { ok: true, reason: null };
    httpStatus = response.status;
  } catch {
    failed = true;
  } finally {
    clearTimeout(timer);
  }

  const pageIsSecure = typeof window !== "undefined" && window.isSecureContext === true;
  const host = probeHostOf(target);
  const localNetworkDenied =
    failed && pageIsSecure && isLocalAddressHost(host) ? await localNetworkPermissionDenied() : false;

  return {
    ok: false,
    reason: classifyProbeFailure({
      pageIsSecure,
      targetUrl: target,
      timedOut: failed && controller.signal.aborted,
      localNetworkDenied,
      httpStatus,
    }),
  };
}
