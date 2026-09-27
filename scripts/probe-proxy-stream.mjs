/**
 * LLM 代理流式透传探针（round 2 批次 3 / R-06）
 *
 * 代理此前无条件 response.text() + JSON.parse，而客户端默认 stream:true →
 * 对 SSE 上游必然解析失败返回 500，"只能走代理的服务商"整条 AI 链路全灭。
 * 这类"整条功能死掉"的问题躲过了两轮人工审查，所以这里把它固定成可重跑的检查：
 *   1. SSE 上游 → 必须原样透传，客户端能逐块读到 data:
 *   2. JSON 上游 → 仍按 JSON 透传
 *   3. 客户端中途断开 → 上游要看到请求被掐断（不能挂到 3 分钟超时）
 * 全部跑在临时库 + 随机端口上。用法：node scripts/probe-proxy-stream.mjs
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort } from "./lib/probe-ports.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PROBE_PORT || 5201);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "anr-proxy-probe-"));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

let upstreamClosed;   // 由 SSE 分支的 res close 置真；未触发即保持 undefined
const upstream = http.createServer((req, res) => {
  // 必须挂 data 监听把请求体排空：只挂 end 的话流不进入 flowing 模式，
  // 带 JSON body 的 POST 永远不触发 end，探针会看到 504（值本身用不上）
  req.on("data", () => { /* 排空请求体 */ });
  req.on("end", () => {
    if (req.url === "/sse") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      let i = 0;
      const timer = setInterval(() => {
        res.write(`data: {"choices":[{"delta":{"content":"段${i}"}}]}\n\n`);
        if (++i >= 3) {
          clearInterval(timer);
          res.write("data: [DONE]\n\n");
          res.end();
        }
      }, 40);
      // ⚠️ 必须监听 res 而不是 req：Node 在"请求体读完"时就会 emit req 的 close，
      // 用它当"客户端断开"会把正常请求的连接判定成断开（本轮两处都踩过这个坑）
      res.on("close", () => {
        clearInterval(timer);
        if (!res.writableEnded) upstreamClosed = true;
      });
      return;
    }
    if (req.url === "/echo") {
      // 把代理真正转发过来的鉴权头回显出来：用来盯"头白名单是否区分大小写"这类问题。
      // 顺手带一枚 x-ratelimit-*：这是给"成功腿不许记"那一格做的**样本**，不是厂商事实——
      // 09-28 实测五家（411／longcat／deepseek／modelscope／sensenova）成功响应都不带这类头。
      // 样本仍然必要：缺了它，"把取证搬到 !ok 之外"那一刀当场 0 红（有头就记＝每发都刷一行）。
      // 所以"只在出错时才记限流取证"这一格有东西可咬——写歪成"有头就记"就会每发都刷一行。
      res.writeHead(200, {
        "Content-Type": "application/json",
        "x-ratelimit-remaining": "97",
      });
      res.end(JSON.stringify({
        choices: [{ message: { content: "echo" } }],
        gotAuthorization: req.headers.authorization ?? null,
        gotApiKey: req.headers["x-api-key"] ?? null,
      }));
      return;
    }
    if (req.url === "/unauth") {
      // 模仿 sensenova 这类网关：用 401 表达"密钥/模型无权访问"，且错误体不是 OpenAI 格式
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: 16, message: "Forbidden" } }));
      return;
    }
    if (req.url === "/limited") {
      // 厂商给了"等多久"：这两枚头是决定「值不值得按秒等」的唯一证据，先记下来
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "42",
        "x-ratelimit-reset-requests": "7",
      });
      res.end(JSON.stringify({ error: { message: "Too Many Requests" } }));
      return;
    }
    if (req.url === "/limited-bare") {
      // 厂商只回 429、什么都不肯说（deepseek 这类就常见）——空日志与"没跑到"是两回事，
      // 所以这一格必须让代理自己讲明"厂商没给任何一个"
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Too Many Requests" } }));
      return;
    }
    if (req.url === "/slow-503") {
      // Retry-After 不只出现在 429 上（503 也常见）。判据条件里"只看 429"那一半要有牙，
      // 就得给一枚 429 之外的样本
      res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "7" });
      res.end(JSON.stringify({ error: { message: "Service Unavailable" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "非流式回答" } }], usage: {} }));
  });
});
await new Promise((resolve) => { upstream.listen(0, "127.0.0.1", resolve); });
const upstreamPort = upstream.address().port;

const server = spawn(process.execPath, [path.join(repoRoot, "server", "index.js")], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PORT: String(PORT),
    // 后端总会起 HTTPS；不给空闲端口，探针在"应用正在跑"时必然启动失败
    HTTPS_PORT: String(await freePort()),
    // 一只 env 退掉全部落盘位置（DB / 备份 / 口令 / 证书 / rag-config / tts 缓存与中转）
    NOVEL_READER_DATA_DIR: workDir,
  },
});
let logs = "";
server.stdout.on("data", (c) => { logs += c; });
server.stderr.on("data", (c) => { logs += c; });

const base = `http://127.0.0.1:${PORT}`;
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/version`);
      if (r.ok) return true;
    } catch { /* 还没起 */ }
    await new Promise((r) => { setTimeout(r, 200); });
  }
  return false;
}

try {
  check("后端已启动", await waitForServer(), logs.slice(-200));

  const reg = await fetch(`${base}/api/sync/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "probe-user", mode: "create", clientId: "probe-client" }),
  });
  const regJson = await reg.json().catch(() => ({}));
  const token = regJson.token;
  check("注册取得 session token", !!token, `status=${reg.status}`);

  const authHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  // ── 1. SSE 透传 ─────────────────────────────────────────
  // 前置条件：假上游自己必须能用（把"上游没响应"与"代理不透传"区分开）
  let directOk = false;
  try {
    const direct = await fetch(`http://127.0.0.1:${upstreamPort}/sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true }),
      signal: AbortSignal.timeout(5000),
    });
    const directText = await direct.text();
    directOk = direct.status === 200 && directText.includes("[DONE]");
  } catch { /* 留给下面的 check 报失败 */ }
  check("假上游可用（探针前置条件）", directOk);

  // ── 0. 两种 401 必须可区分 ─────────────────────────────
  // 客户端只在带 X-Proxy-Auth 标记时才去做"会话续期 + 重注册"。若标记丢了，厂商的
  // 401（密钥/模型无权访问）会被误判成本地会话失效：白重注册一次，还把正确建议盖掉。
  const noSession = await fetch(`${base}/api/proxy/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: `http://127.0.0.1:${upstreamPort}/unauth`, headers: {}, body: {} }),
  });
  check(
    "后端自己拒的 401 带 X-Proxy-Auth 标记",
    noSession.status === 401 && noSession.headers.get("x-proxy-auth") === "required",
    `status=${noSession.status} marker=${noSession.headers.get("x-proxy-auth")}`
  );
  const upstream401 = await fetch(`${base}/api/proxy/chat`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      url: `http://127.0.0.1:${upstreamPort}/unauth`,
      headers: {},
      body: { model: "m", messages: [{ role: "user", content: "hi" }] },
    }),
  });
  check(
    "厂商原样转达的 401 不带该标记",
    upstream401.status === 401 && upstream401.headers.get("x-proxy-auth") === null,
    `status=${upstream401.status} marker=${upstream401.headers.get("x-proxy-auth")}`
  );

  // ── 0b. 鉴权头必须真的被转发（大小写不敏感）─────────────
  // 客户端 openai.ts 发的是 `Authorization`（大写 A），白名单按小写键取值就会静默丢头，
  // 症状是"这家厂商永远 401，换一家就好"——只有不支持 CORS、必须走代理的厂商才会暴露。
  const echo = await fetch(`${base}/api/proxy/chat`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      url: `http://127.0.0.1:${upstreamPort}/echo`,
      headers: { Authorization: "Bearer CAPITALIZED-KEY" },
      body: { model: "m", messages: [{ role: "user", content: "hi" }] },
    }),
  });
  const echoJson = await echo.json().catch(() => null);
  check(
    "大写 Authorization 也照样转发给上游",
    echoJson?.gotAuthorization === "Bearer CAPITALIZED-KEY",
    `got=${JSON.stringify(echoJson?.gotAuthorization)}`
  );

  // ── 0c. 以 fd/fc/fe80 开头的公网域名不得冒充内网 ────────
  // 冒充成功的后果：明文 http:// 被放行，而且解析到内网时会跳过重绑定复核（R-74）。
  const lookalike = await fetch(`${base}/api/proxy/chat`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      url: `http://fdn.example.com/v1/chat/completions`,
      headers: {},
      body: { model: "m", messages: [{ role: "user", content: "hi" }] },
    }),
  });
  const lookalikeJson = await lookalike.json().catch(() => null);
  check(
    "http://fdn.example.com 被当作外部地址要求 HTTPS",
    lookalike.status === 400 && String(lookalikeJson?.error || "").includes("HTTPS"),
    `status=${lookalike.status} error=${JSON.stringify(lookalikeJson?.error)}`
  );

  // ── 0d. 限流取证：厂商给的"等多久"必须落到后端日志里 ─────────
  // 现状（09-28 查明）：全仓从没读过 Retry-After，代理在 !ok 时只转 status+body，
  // 上游头当场丢掉 → 用户撞上 429 只能瞎等。要不要改成"按秒等"得先看厂商到底给不给，
  // 所以这一步只负责把证据记下来。断言一律按"这一发之前的日志长度"切窗口：
  // 四发都往同一份日志里写，不切窗口就归不了因（哪一发说了话看不出来）。
  const hitUpstream = async (path) => {
    const from = logs.length;
    const r = await fetch(`${base}/api/proxy/chat`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        url: `http://127.0.0.1:${upstreamPort}${path}`,
        headers: {},
        body: { model: "m", messages: [{ role: "user", content: "hi" }] },
      }),
    });
    await r.text();
    return logs.slice(from);
  };

  const limitedLog = await hitUpstream("/limited");
  check("限流取证 429：Retry-After 的秒数进了日志", /retry-after=42\b/.test(limitedLog),
    `日志=${JSON.stringify(limitedLog.trim().slice(-160))}`);
  const bareLog = await hitUpstream("/limited-bare");
  check("限流取证 429：厂商一个头都没给时，日志要说明是「没给」而不是「没记」",
    /限流取证 status=429/.test(bareLog) && /没给任何一个/.test(bareLog) && !/retry-after=/.test(bareLog),
    `日志=${JSON.stringify(bareLog.trim().slice(-160))}`);
  const slowLog = await hitUpstream("/slow-503");
  check("限流取证 503：带 Retry-After 的非 429 也记（判据不只盯 429 那一格）",
    /status=503/.test(slowLog) && /retry-after=7\b/.test(slowLog),
    `日志=${JSON.stringify(slowLog.trim().slice(-160))}`);
  const okLog = await hitUpstream("/echo");
  check("限流取证：成功透传那一腿不许写这行（挪到 !ok 之外要能看见）",
    !/限流取证/.test(okLog), `日志=${JSON.stringify(okLog.trim().slice(-160))}`);

  let sse = null;
  const sseStartedAt = Date.now();
  try {
    sse = await fetch(`${base}/api/proxy/chat`, {
      method: "POST",
      headers: authHeaders,
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        url: `http://127.0.0.1:${upstreamPort}/sse`,
        headers: {},
        body: { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] },
      }),
    });
  } catch (e) {
    console.log(`  DEBUG SSE 请求失败 (${Date.now() - sseStartedAt}ms): ${e.name} ${e.message} cause=${e.cause?.message ?? ""}`);
    console.log("  DEBUG 后端日志:\n" + logs.split("\n").slice(-14).join("\n"));
  }
  const gotType = sse?.headers.get("content-type") || "";
  check("SSE 响应未被降级成 500 JSON", sse && sse.status === 200 && gotType.includes("text/event-stream"),
    `status=${sse?.status} ct=${gotType}`);
  // 透传出去的是模型写的中文正文。不带 charset 时，消费方按自己的默认字节编码解就是乱码——
  // 真厂商那一档实测踩到：Chromium 把无 charset 的 text/* 先按 windows-1252 解一遍，
  // Playwright 侧 `res.text()` 与 `res.body()` 拿到的都是 `å°±æ‰€ç»™`（产品自己用 TextDecoder 才没坏）。
  check("SSE 透传声明 charset=utf-8（不把单字节默认解码留给消费方）", /charset=utf-8/i.test(gotType),
    `ct=${gotType}`);

  const reader = sse?.body?.getReader();
  const dec = new TextDecoder();
  let streamText = "";
  for (; reader;) {
    const { done, value } = await reader.read();
    if (done) break;
    streamText += dec.decode(value, { stream: true });
    if (streamText.includes("[DONE]")) break;
  }
  check("客户端能逐块读到上游 data:", streamText.includes("data:") && streamText.includes("段0"), streamText.slice(0, 60));
  check("流正常收尾（含 [DONE]）", streamText.includes("[DONE]"));

  // ── 2. 非流式 JSON 仍按原样透传 ─────────────────────────
  const js = await fetch(`${base}/api/proxy/chat`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      url: `http://127.0.0.1:${upstreamPort}/json`,
      headers: {},
      body: { model: "m", stream: false, messages: [] },
    }),
  });
  const jsJson = await js.json().catch(() => null);
  check("非流式 JSON 透传保持可用", js.status === 200 && jsJson?.choices?.[0]?.message?.content === "非流式回答",
    `status=${js.status}`);

  // ── 3. 客户端断开要掐断上游 ─────────────────────────────
  upstreamClosed = false;
  const abort = new AbortController();
  const slow = await fetch(`${base}/api/proxy/chat`, {
    method: "POST",
    headers: authHeaders,
    signal: abort.signal,
    body: JSON.stringify({
      url: `http://127.0.0.1:${upstreamPort}/sse`,
      headers: {},
      body: { model: "m", stream: true, messages: [] },
    }),
  });
  const r2 = slow.body.getReader();
  await r2.read();          // 只读一块就走
  await r2.cancel("client-gone");
  abort.abort();
  await new Promise((r) => { setTimeout(r, 600); });
  check("客户端断开后代理不再挂着上游", upstreamClosed === true, `closed=${upstreamClosed}`);

  check("后端全程未崩溃", server.exitCode === null, `exit=${server.exitCode}`);
  check("日志无 unhandledRejection", !/unhandledRejection|uncaughtException/.test(logs));
} finally {
  server.kill("SIGKILL");
  upstream.close();
  await new Promise((r) => { setTimeout(r, 100); });
  fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n探针结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
