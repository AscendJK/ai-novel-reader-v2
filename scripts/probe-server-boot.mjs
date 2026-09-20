/**
 * 后端启动冒烟探针（批次 2 的 DoD 之一）
 *
 * 用临时目录里的空库把真实服务器拉起来，发几个 HTTP 请求确认路由与中间件
 * 没被改坏，再 SIGTERM 要求干净退出。纯 lint/单测覆盖不到"服务能不能起"。
 * 用法：node scripts/probe-server-boot.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./lib/probe-ports.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PROBE_PORT || 5199);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "anr-boot-probe-"));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function get(pathname, token, origin) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    headers: Object.keys(headers).length ? headers : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

const adminTokenFile = path.join(workDir, ".admin_token");
const child = spawn(process.execPath, [path.join(repoRoot, "server", "index.js")], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(PORT),
    // 后端总会起 HTTPS；不给空闲端口，探针在"应用正在跑"时必然启动失败
    HTTPS_PORT: String(await freePort()),
    NOVEL_READER_DB_PATH: path.join(workDir, "novels.db"),
    NOVEL_READER_BACKUP_DIR: path.join(workDir, "backups"),
    // 探针绝不触碰真实的 server/data/.admin_token
    NOVEL_READER_ADMIN_TOKEN_FILE: adminTokenFile,
    // 用户自定义前端来源（第二条故意带前导空格——正是过去会被静默丢掉的那种写法）
    CORS_ORIGINS: "https://probe-allowed.example, https://probe-spaced.example",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let logs = "";
child.stdout.on("data", (c) => { logs += c.toString(); });
child.stderr.on("data", (c) => { logs += c.toString(); });
const exited = new Promise((resolve) => { child.on("exit", (code, signal) => resolve({ code, signal })); });

try {
  // 等端口起来（最多 20s）
  let up = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await get("/api/version");
      if (r.status === 200) { up = true; break; }
    } catch { /* 还没监听 */ }
    await new Promise((r) => { setTimeout(r, 200); });
  }
  check("服务器启动并响应 /api/version", up);
  if (!up) throw new Error("启动失败，日志：\n" + logs.slice(-2000));

  const nov = await get("/api/novels?username=probe");
  check("GET /api/novels 返回 200", nov.status === 200, `status=${nov.status} ${nov.text.slice(0, 80)}`);

  const tts = await get("/api/rag/tts/status");
  check("GET /api/rag/tts/status 返回 200（TTS 路由顺序未被破坏）", tts.status === 200, `status=${tts.status}`);

  const adminNoToken = await get("/api/admin/stats");
  check("管理后台无 token 时被拒", adminNoToken.status === 401 || adminNoToken.status === 403, `status=${adminNoToken.status}`);

  const token = fs.existsSync(adminTokenFile) ? fs.readFileSync(adminTokenFile, "utf8").trim() : "";
  const admin = await get("/api/admin/stats", token);
  check("管理后台带 token 可读", admin.status === 200, `status=${admin.status}`);

  const badJson = await fetch(`http://127.0.0.1:${PORT}/api/sync/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{ not json",
  });
  check("畸形 JSON 不会打穿进程", badJson.status >= 400 && badJson.status < 600, `status=${badJson.status}`);

  // ── CORS：判据本身有单测，这里查的是"中间件真的按判据接线" ──
  const lan = await get("/api/version", undefined, "http://192.168.1.100:8443");
  check("局域网来源被放过（回显具体 Origin，不是 *）",
    lan.headers.get("access-control-allow-origin") === "http://192.168.1.100:8443",
    `ACAO=${lan.headers.get("access-control-allow-origin")}`);
  check("X-Proxy-Auth 在 expose 名单里（否则前端分不清后端 401 与厂商 401）",
    String(lan.headers.get("access-control-expose-headers") || "").includes("X-Proxy-Auth"),
    `AEH=${lan.headers.get("access-control-expose-headers")}`);

  const publicOrigin = await get("/api/version", undefined, "https://evil.example.com");
  check("公网来源拿不到 CORS 放行头",
    publicOrigin.headers.get("access-control-allow-origin") === null,
    `ACAO=${publicOrigin.headers.get("access-control-allow-origin")}`);

  const suffix = await get("/api/version", undefined, "http://192.168.1.1.evil.com");
  check("拿局域网字样做后缀混淆的来源也被拒",
    suffix.headers.get("access-control-allow-origin") === null,
    `ACAO=${suffix.headers.get("access-control-allow-origin")}`);

  // 用户在 CORS_ORIGINS 里配的来源必须真的生效——包括逗号后带空格这种写法
  for (const o of ["https://probe-allowed.example", "https://probe-spaced.example"]) {
    const custom = await get("/api/version", undefined, o);
    check(`CORS_ORIGINS 配置生效：${o}`,
      custom.headers.get("access-control-allow-origin") === o,
      `ACAO=${custom.headers.get("access-control-allow-origin")}`);
  }

  check("响应带 nosniff", publicOrigin.headers.get("x-content-type-options") === "nosniff",
    `XCTO=${publicOrigin.headers.get("x-content-type-options")}`);

  child.kill("SIGTERM");
  const exitInfo = await Promise.race([
    exited,
    new Promise((r) => { setTimeout(() => r({ code: "TIMEOUT", signal: null }), 8000); }),
  ]);
  check("SIGTERM 干净退出", exitInfo.code === 0 || exitInfo.signal === "SIGTERM", JSON.stringify(exitInfo));
  check("进程日志无 unhandledRejection/uncaughtException", !/unhandledRejection|uncaughtException/.test(logs));
} finally {
  if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n探针结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
