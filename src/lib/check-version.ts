/**
 * 版本检测工具
 * 登录时调用后端 /api/version 接口，对比前后端版本号
 */

import { APP_VERSION } from "@/config/version";
import { getServerUrl, apiFetch } from "./api-client";

export interface VersionCheckResult {
  /** 版本是否一致（后端不可达时视为一致） */
  match: boolean;
  /** 前端版本号 */
  frontend: string;
  /** 后端版本号（后端不可达时为 null） */
  backend: string | null;
  /** 错误信息 */
  error?: string;
}

/**
 * 向后端请求版本号并与前端对比
 * 后端不可达时不报错，视为版本一致（离线模式不阻塞使用）
 */
export async function checkVersion(): Promise<VersionCheckResult> {
  const base = getServerUrl();
  if (!base) {
    return { match: true, frontend: APP_VERSION, backend: null };
  }

  try {
    const res = await apiFetch("/api/version", {
      signal: AbortSignal.timeout(5000),
    }, true);
    if (!res.ok) {
      return {
        match: false,
        frontend: APP_VERSION,
        backend: null,
        error: `服务器返回状态码 ${res.status}`,
      };
    }
    const data = await res.json();
    return {
      match: data.version === APP_VERSION,
      frontend: APP_VERSION,
      backend: data.version,
    };
  } catch (e) {
    // 区分超时和其他错误，方便调试
    if (e instanceof DOMException && e.name === "AbortError") {
      console.debug("[checkVersion] 请求超时");
    } else if (e instanceof TypeError) {
      console.debug("[checkVersion] 网络错误:", e.message);
    }
    // 后端不可达，不阻塞使用
    return { match: true, frontend: APP_VERSION, backend: null };
  }
}