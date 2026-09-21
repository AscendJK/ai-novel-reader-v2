import type { Page, Request } from "@playwright/test";
import type { Backend, Reply, StubTable } from "./backend";

/**
 * 假 AI 厂商端点。
 *
 * **为什么挂在同源 `/api/` 底下**：直连那一腿发的就是 `POST {baseUrl}/chat/completions`
 * （`src/api/providers/openai.ts:77-90`）。把服务商的 baseUrl 配成
 * `本页源/api/e2e-llm/v1`，这一发就变成同源请求——既不用处理 CORS 预检（真实厂商里
 * sensenova 根本不响应 OPTIONS，这是它必须走代理的原因），又正好落进 `stubBackend`
 * 那条"只按 pathname 判定"的桩（`fixtures/backend.ts:51`）。桩的键只匹配 pathname，
 * 不看来源，所以假厂商和真后端的接口能共用同一张表。
 *
 * **SSE 是一次性 fulfill 的**（Playwright 的 `route.fulfill` 不能分帧推），所以这一层测的是
 * 产品自己的流式解析与状态机（`stream.ts` 的 `data:` 分帧、`[DONE]`、usage、空流报错），
 * 不是"逐字渲染"——产品本来也是把整段聚合完才返回给调用方（`openai.ts:104-152`）。
 * 分帧仍然照 3 帧发：一帧到位就测不出"跨帧累加"。
 */

export const VENDOR_BASE_PATH = "/api/e2e-llm/v1";
export const VENDOR_CHAT_PATH = `${VENDOR_BASE_PATH}/chat/completions`;
/** 直连失败之后的第二条腿（`openai.ts:94-108`） */
export const PROXY_CHAT_PATH = "/api/proxy/chat";

/**
 * 假厂商的 baseUrl。必须在页面已经落到 dev 源之后调用——
 * `page.url()` 在 `goto` 之前是 `about:blank`，那时取到的 origin 是 "null"。
 */
export function vendorBaseUrl(page: Page): string {
  const origin = new URL(page.url()).origin;
  if (!origin.startsWith("http")) {
    throw new Error(`vendorBaseUrl 要在 openApp 之后调用，现在页面在 ${page.url()}`);
  }
  return `${origin}${VENDOR_BASE_PATH}`;
}

export interface VendorReply {
  status?: number;
  /** 模型输出的正文。字符串按 SSE 分帧发出；给对象自动包成 ```json 围栏（extractJSON 认这个形状） */
  content?: string | object;
  /** 用非流式 JSON 回包（厂商不支持 stream 那一格） */
  nonStreaming?: boolean;
  /** 打断连接 = 厂商不可达，直连腿失败后会落到代理腿 */
  abort?: boolean;
  /** 迟多少毫秒才回。真实计时（route handler 跑在 Node 里），用于"生成中"状态与"停止" */
  delayMs?: number;
  usage?: { input: number; output: number };
  headers?: Record<string, string>;
}

/** 切成 3 帧，逼产品把 delta 累加回来（`openai.ts:126-133`） */
function splitForFrames(text: string): string[] {
  // 按码点切：按 UTF-16 下标切会把代理对劈成两半，浏览器里就成了乱码
  const chars = Array.from(text);
  if (chars.length < 3) return [text];
  const a = Math.ceil(chars.length / 3);
  return [chars.slice(0, a).join(""), chars.slice(a, a * 2).join(""), chars.slice(a * 2).join("")];
}

function sseBody(text: string, usage?: { input: number; output: number }): string {
  const frames = splitForFrames(text).map((piece) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`,
  );
  if (usage) {
    frames.push(`data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
    })}\n\n`);
  }
  frames.push("data: [DONE]\n\n");
  return frames.join("");
}

function asText(content: string | object | undefined): string {
  if (content === undefined) return "";
  return typeof content === "string" ? content : "```json\n" + JSON.stringify(content, null, 2) + "\n```";
}

function toReply(script: VendorReply): Reply {
  const text = asText(script.content);
  if (script.status && script.status >= 400) {
    // 真实厂商的错误体不是 OpenAI 形状（sensenova 就是这样），这里两种都只给一个最简的
    return { status: script.status, body: { error: { message: `e2e 厂商 ${script.status}`, type: "invalid_request_error" } }, headers: script.headers };
  }
  return {
    status: script.status ?? 200,
    abort: script.abort,
    contentType: script.nonStreaming ? "application/json" : "text/event-stream",
    body: script.nonStreaming
      ? JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: text } }],
          usage: script.usage
            ? { prompt_tokens: script.usage.input, completion_tokens: script.usage.output, total_tokens: script.usage.input + script.usage.output }
            : undefined,
        })
      : sseBody(text, script.usage),
    headers: script.headers,
  };
}

/**
 * 一条腿的剧本：可以按请求体决定回什么（同一批里"第 2 次要失败"这类剧本要用）。
 * 入参是厂商侧收到的 chat 请求体（已解析），没带 JSON 的就是 null。
 */
export type LegScript = VendorReply | ((chatBody: Record<string, unknown> | null, req: Request) => VendorReply);

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function legResponder(script: LegScript) {
  return async (req: Request): Promise<Reply> => {
    if (typeof script !== "function") {
      if (script.delayMs) await wait(script.delayMs);
      return toReply(script);
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(req.postData() || "{}") as Record<string, unknown>;
    } catch { /* 不是 JSON 就原样给 null，让剧本自己决定 */ }
    const s = await script(body, req);
    if (s.delayMs) await wait(s.delayMs);
    return toReply(s);
  };
}

/**
 * 生成厂商两腿的桩表。只给一个剧本 = 两腿同样回（多数用例只需直连成功）；
 * 分开给才能演"直连挂了、代理顶上"（C9）。
 */
export function vendorTable(script: LegScript, legs: { direct?: LegScript; proxy?: LegScript } = {}): StubTable {
  const direct = legs.direct ?? script;
  const proxy = legs.proxy ?? script;
  return {
    [`POST ${VENDOR_CHAT_PATH}`]: legResponder(direct),
    [`POST ${PROXY_CHAT_PATH}`]: legResponder(proxy),
  };
}

/** 厂商收到的请求体（按发生顺序），用于判"到底发了什么模型、哪一章的正文" */
export function chatRequests(backend: Backend, path: string = VENDOR_CHAT_PATH): Record<string, unknown>[] {
  return backend
    .seen()
    .filter((s) => s.method === "POST" && s.path === path)
    .map((s) => {
      try {
        return JSON.parse(s.body || "{}") as Record<string, unknown>;
      } catch {
        return { __unparsable: s.body };
      }
    });
}

/** 代理腿的请求体是 `{url, headers, body}` 的包壳，这里把内层取出来 */
export function proxiedChats(backend: Backend): Record<string, unknown>[] {
  return chatRequests(backend, PROXY_CHAT_PATH).map((wrap) => (wrap.body as Record<string, unknown>) ?? wrap);
}
