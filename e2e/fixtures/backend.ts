import type { Page, Request } from "@playwright/test";

/**
 * 浏览器侧看到的"后端"——全部用 page.route 桩掉，绝不起真 server。
 *
 * 为什么不起真的：`server/index.js:110-114` 的证书路径硬编码在 `server/data/`，
 * 而 `143-168` + `197-205` 每次启动都会拿当前局域网 IP 去比对 SAN，缺一个就
 * 就地 `mkcert` 重签。测试不该有改写用户真证书和真库的能力。
 */
export type Reply = {
  status?: number;
  /** JSON 用例给对象；二进制下载（RAG 索引）给 Buffer——原样送出，不再 JSON.stringify */
  body?: unknown;
  headers?: Record<string, string>;
  /** 响应的 content-type。默认 `application/json`；SSE 那类要靠它分流（openai.ts:161） */
  contentType?: string;
  /** 断掉连接 = "服务器不可达"，走 fetch 的网络错误分支（不是 500 分支） */
  abort?: boolean;
};

export type Responder = Reply | ((req: Request) => Reply | Promise<Reply>);

/** 键形如 "POST /api/sync/register"；结尾 `/*` 是按前缀匹配。 */
export type StubTable = Record<string, Responder>;

export interface Backend {
  /** 命中过的请求（方法 + 路径 + 请求体原文），按发生顺序 */
  seen(): { method: string; path: string; body: string | null }[];
  /** 没有任何桩接住的请求——静默放过就是假绿的温床，所以只记录、不假装成功 */
  unmatched(): string[];
  count(method: string, path: string): number;
}

/**
 * 页面中途取消（点了"停止"）之后，桩的回包发不出去是正常现象。
 * 不吞掉它就会在 route handler 里抛一个未处理拒绝，把一条本该绿在用例上失败的工具砸红。
 */
async function settle(action: Promise<void>): Promise<void> {
  try {
    await action;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/already handled|closed|abort/i.test(msg)) throw e;
  }
}

function resolveKey(table: StubTable, method: string, pathname: string): string | undefined {
  const exact = `${method} ${pathname}`;
  if (exact in table) return exact;
  const anyMethod = `* ${pathname}`;
  if (anyMethod in table) return anyMethod;
  for (const key of Object.keys(table)) {
    // 只支持 `"/api/xxx/**"` 或 `"POST /api/xxx/**"` 这一种前缀写法，别再造第二种匹配语法。
    // 带方法的那一版是给"同一个前缀下不同动词要走不同剧本"用的（F 组：POST 建库 /
    // GET 查状态与下载索引都挂在 `/api/rag/**` 下面）。
    const space = key.indexOf(" ");
    const methodPart = space < 0 ? "*" : key.slice(0, space);
    const pathPart = space < 0 ? key : key.slice(space + 1);
    if (!pathPart.startsWith("/") || !pathPart.endsWith("/**")) continue;
    if (methodPart !== "*" && methodPart !== method) continue;
    if (pathname.startsWith(pathPart.slice(0, -3))) return key;
  }
  return undefined;
}

export async function stubBackend(page: Page, table: StubTable): Promise<Backend> {
  const seen: { method: string; path: string; body: string | null }[] = [];
  const unmatched = new Set<string>();

  // 只按 pathname 前缀判定，**不能用 "**/api/**"**：dev 下 Vite 用
  // `/ai-novel-reader-v2/src/api/...` 伺服源码模块，那条 glob 会把应用自己的 JS
  // 也桩成 500，症状是整页空白（实测踩过）。
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const key = `${req.method()} ${url.pathname}`;
    // body 只给 POST/PUT/PATCH 留：E4 那类"客户端到底推了什么上去"的判据要用它，
    // 而 GET 的 query 已经在 path 里了
    const body = req.method() === "GET" || req.method() === "HEAD" ? null : req.postData();
    seen.push({ method: req.method(), path: url.pathname, body });

    const name = resolveKey(table, req.method(), url.pathname);
    if (!name) {
      unmatched.add(key);
      // 没桩住就明确失败：返回 200 空对象会让前端"看起来正常"，用例照绿，
      // 而真实后端在这个位置是给不出响应的。
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: `e2e 未桩住的请求: ${key}` }),
      });
      return;
    }

    const reply = await (typeof table[name] === "function"
      ? (table[name] as (r: Request) => Reply | Promise<Reply>)(req)
      : (table[name] as Reply));

    if (reply.abort) {
      await settle(route.abort("connectionrefused"));
      return;
    }
    await settle(route.fulfill({
      status: reply.status ?? 200,
      contentType: reply.contentType ?? "application/json",
      body: typeof reply.body === "string" || Buffer.isBuffer(reply.body)
        ? reply.body
        : JSON.stringify(reply.body ?? {}),
      headers: {
        // dev server 带 `Cross-Origin-Embedder-Policy: require-corp`（vite.config.ts:133-139），
        // 任何跨源的桩响应不给 CORP 就会被浏览器拦下，症状是"桩没生效"。
        "Cross-Origin-Resource-Policy": "cross-origin",
        ...reply.headers,
      },
    }));
  });

  return {
    seen: () => seen.slice(),
    unmatched: () => [...unmatched],
    count: (method, path) => seen.filter((s) => s.method === method && s.path === path).length,
  };
}

/**
 * 开机就会轮询 TTS 状态（`src/tts/server-engine.ts:21`）。不桩住它，请求会打到 Vite
 * 代理、后端不在 → 502，而 Chrome 把非 2xx 资源记成 console.error，于是"开机路径无
 * console 错误"那类用例变成随机红。字段形状照 server-engine.ts:24-29。
 */
export const idleTtsStatus: StubTable = {
  "GET /api/rag/tts/status": {
    body: {
      serverInference: { supported: false, ready: false, reason: "" },
      wasmReady: false,
      modelReady: false,
      vocoderReady: false,
    },
  },
};
