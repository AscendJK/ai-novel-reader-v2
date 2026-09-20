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
  body?: unknown;
  headers?: Record<string, string>;
  /** 断掉连接 = "服务器不可达"，走 fetch 的网络错误分支（不是 500 分支） */
  abort?: boolean;
};

export type Responder = Reply | ((req: Request) => Reply | Promise<Reply>);

/** 键形如 "POST /api/sync/register"；结尾 `/*` 是按前缀匹配。 */
export type StubTable = Record<string, Responder>;

export interface Backend {
  /** 命中过的请求（方法 + 路径），按发生顺序 */
  seen(): { method: string; path: string }[];
  /** 没有任何桩接住的请求——静默放过就是假绿的温床，所以只记录、不假装成功 */
  unmatched(): string[];
  count(method: string, path: string): number;
}

function resolveKey(table: StubTable, method: string, pathname: string): string | undefined {
  const exact = `${method} ${pathname}`;
  if (exact in table) return exact;
  const anyMethod = `* ${pathname}`;
  if (anyMethod in table) return anyMethod;
  for (const key of Object.keys(table)) {
    // 只支持 `"/api/xxx/**"` 这一种前缀写法，别再造第二种匹配语法
    if (!key.startsWith("/") || !key.endsWith("/**")) continue;
    if (pathname.startsWith(key.slice(0, -3))) return key;
  }
  return undefined;
}

export async function stubBackend(page: Page, table: StubTable): Promise<Backend> {
  const seen: { method: string; path: string }[] = [];
  const unmatched = new Set<string>();

  // 只按 pathname 前缀判定，**不能用 "**/api/**"**：dev 下 Vite 用
  // `/ai-novel-reader-v2/src/api/...` 伺服源码模块，那条 glob 会把应用自己的 JS
  // 也桩成 500，症状是整页空白（实测踩过）。
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const key = `${req.method()} ${url.pathname}`;
    seen.push({ method: req.method(), path: url.pathname });

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
      await route.abort("connectionrefused");
      return;
    }
    await route.fulfill({
      status: reply.status ?? 200,
      contentType: "application/json",
      body: typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {}),
      headers: {
        // dev server 带 `Cross-Origin-Embedder-Policy: require-corp`（vite.config.ts:133-139），
        // 任何跨源的桩响应不给 CORP 就会被浏览器拦下，症状是"桩没生效"。
        "Cross-Origin-Resource-Policy": "cross-origin",
        ...reply.headers,
      },
    });
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
