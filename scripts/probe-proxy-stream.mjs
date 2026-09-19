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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PROBE_PORT || 5201);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "anr-proxy-probe-"));
const adminTokenFile = path.join(workDir, ".admin_token");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

let upstreamClosed = false;
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "非流式回答" } }], usage: {} }));
  });
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;

const server = spawn(process.execPath, [path.join(repoRoot, "server", "index.js")], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PORT: String(PORT),
    NOVEL_READER_DB_PATH: path.join(workDir, "novels.db"),
    NOVEL_READER_BACKUP_DIR: path.join(workDir, "backups"),
    NOVEL_READER_ADMIN_TOKEN_FILE: adminTokenFile,
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
    await new Promise((r) => setTimeout(r, 200));
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
  await new Promise((r) => setTimeout(r, 600));
  check("客户端断开后代理不再挂着上游", upstreamClosed === true, `closed=${upstreamClosed}`);

  check("后端全程未崩溃", server.exitCode === null, `exit=${server.exitCode}`);
  check("日志无 unhandledRejection", !/unhandledRejection|uncaughtException/.test(logs));
} finally {
  server.kill("SIGKILL");
  upstream.close();
  await new Promise((r) => setTimeout(r, 100));
  fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n探针结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
