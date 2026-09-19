/**
 * 代理请求的会话续期包装（openai / anthropic 两个 provider 共用）
 *
 * 后端会话存在内存 Map 里（server/sync-handler.js 的 sessions），重启即全部失效，
 * 而 localStorage 里还留着旧 token：于是"看着登录着，但每个要登录的请求都 401"。
 * 同步链路本来就会自动重注册续期，AI 链路过去不会，而且代理的 401 会被
 * classifyError 翻译成"API Key 错误"——把用户支去检查一个根本没坏的密钥。
 */
import { APIError } from "../error-handler";
import { syncClient } from "@/sync/sync-client";

function sessionLost(status: number): APIError {
  return new APIError(
    "与后端的登录会话已失效（后端重启、或另一设备登录后最常见），自动续期未成功。" +
      "请先点一次同步或重新登录，再生成；这不是 API Key 的问题。",
    "auth",
    status,
  );
}

/** 401 的响应体不消费会挂着连接 */
function discard(resp: Response): void {
  resp.body?.cancel().catch(() => {});
}

/**
 * 发一次代理请求；若拿到 401，就借同步那套重注册换新 token 再试一次。
 * 只重试一次：续期失败或续期后仍 401，一律如实报"会话失效"。
 */
export async function proxyWithSessionRetry(send: () => Promise<Response>): Promise<Response> {
  const first = await send();
  if (first.status !== 401) return first;

  discard(first);
  const renewed = await syncClient.refreshSession();
  if (!renewed) throw sessionLost(first.status);

  const second = await send();
  if (second.status === 401) {
    discard(second);
    throw sessionLost(second.status);
  }
  return second;
}
