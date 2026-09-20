/**
 * 同步路由的会话与鉴权语义探针（批次 G / B 组）
 *
 * server/routes/sync.js 只有 172 行，但它管着三类严重后果的判定：
 *   1. 跨用户写入——token 属于 A 却声称自己是 B，必须 403，不能落库；
 *   2. "被顶替"与"会话过期"的区分——判成 kicked 前端会强制登出（书架直接消失），
 *      判成 session_expired 前端才会无感重注册；两者不能混；
 *   3. 坏载荷过半要整次失败（422），否则客户端照样提交水位，被跳过的那一半就永久丢了。
 * 这三条此前都没有任何东西看着：sync-handler 的单元测试不经过路由，probe:boot 只碰
 * /api/version 那一层。routes/sync.js 依赖 database.js（会开真库），也没法在 jsdom
 * 测试里 import，所以这里用真 HTTP 打真后端跑。
 *
 * 全程临时库 + 空闲端口，不触碰 server/data。用法：node scripts/probe-sync-session.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort } from "./lib/probe-ports.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "anr-sync-probe-"));
const HTTP_PORT = Number(process.env.PROBE_PORT || 0) || await freePort();
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const server = spawn(process.execPath, [path.join(repoRoot, "server", "index.js")], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PORT: String(HTTP_PORT),
    HTTPS_PORT: String(await freePort()),
    NOVEL_READER_DB_PATH: path.join(workDir, "novels.db"),
    NOVEL_READER_BACKUP_DIR: path.join(workDir, "backups"),
    NOVEL_READER_ADMIN_TOKEN_FILE: path.join(workDir, ".admin_token"),
  },
});
let logs = "";
server.stdout.on("data", (c) => { logs += c; });
server.stderr.on("data", (c) => { logs += c; });

const base = `http://127.0.0.1:${HTTP_PORT}`;
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/version`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function api(method, url, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.clone().json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json };
}

const register = (username, clientId, mode) => api("POST", "/api/sync/register", { username, clientId, mode });
const heartbeat = (username, clientId, token) => api("POST", "/api/sync/heartbeat", { username, clientId, token });
const push = (username, clientId, token, changes, lastSyncTime) =>
  api("POST", "/api/sync/push", { username, clientId, token, changes, lastSyncTime });

let exitInfo = null;
try {
  check("后端已启动", await waitForServer(), logs.slice(-240));

  // ── 用户名判据 ──
  const tooShort = await api("GET", "/api/sync/check-user/a");
  check("用户名过短时 check-user 直接 400（不给枚举留口子）", tooShort.status === 400, `status=${tooShort.status}`);

  const ctrl = await register("ab\u0007cd", "c-ctrl", "create");
  check("用户名含控制字符时注册被拒", ctrl.status === 400, `status=${ctrl.status} body=${JSON.stringify(ctrl.json)}`);

  const pad = await register("  alice  ", "c-alice-1", "create");
  check("注册会 trim 用户名（带空格的同名必须是同一账号）", pad.status === 200 && pad.json?.isNew === true,
    `status=${pad.status} isNew=${pad.json?.isNew}`);
  const re = await register("alice", "c-alice-1", "create");
  check("trim 后再注册同名账号应报 409（不是新建第二个同名账号）", re.status === 409, `status=${re.status}`);

  const joinMissing = await register("nobody-here", "c-x", "join");
  check("mode=join 而用户不存在时 404（不许静默建号）", joinMissing.status === 404, `status=${joinMissing.status}`);

  // alice 现在处于"已注册两次"的状态：重新拿一个有效 token 继续
  const alice = await register("alice", "c-alice-1");
  const aliceToken = alice.json?.token;
  const bob = await register("bob", "c-bob-1", "create");
  const bobToken = bob.json?.token;
  check("两个账号各自拿到 session token", !!aliceToken && !!bobToken, `alice=${!!aliceToken} bob=${!!bobToken}`);

  // ── 跨用户写入 ──
  const noToken = await push("alice", "c-alice-1", undefined, null);
  check("push 缺 token 时 401", noToken.status === 401, `status=${noToken.status}`);

  const cross = await push("bob", "c-bob-1", aliceToken, { summaries: [] });
  check("拿 alice 的 token 冒充 bob 推送必须 403（跨用户写入防线）", cross.status === 403,
    `status=${cross.status} body=${JSON.stringify(cross.json)}`);

  const crossHb = await heartbeat("bob", "c-bob-1", aliceToken);
  check("同样不能拿别人的 token 替 bob 续心跳", crossHb.status === 401 || crossHb.status === 403,
    `status=${crossHb.status}`);

  // ── 被顶替 vs 会话过期：两条路径必须给出不同信号 ──
  const hbOk = await heartbeat("alice", "c-alice-1", aliceToken);
  check("活跃设备心跳正常放行", hbOk.status === 200 && hbOk.json?.activeCount >= 1, `status=${hbOk.status} body=${JSON.stringify(hbOk.json)}`);

  const secondDevice = await register("alice", "c-alice-2");
  const secondToken = secondDevice.json?.token;
  check("同一账号的第二台设备注册成功", !!secondToken, `status=${secondDevice.status}`);

  const displaced = await heartbeat("alice", "c-alice-1", aliceToken);
  check("旧设备心跳被判成 kicked 并带 kicked 标记（前端据此登出）",
    displaced.status === 403 && displaced.json?.kicked === true,
    `status=${displaced.status} body=${JSON.stringify(displaced.json)}`);

  const displacedPush = await push("alice", "c-alice-1", aliceToken, { summaries: [] });
  check("旧设备再推送不能成功（401/403，绝不能 200 落库）",
    displacedPush.status === 401 || displacedPush.status === 403,
    `status=${displacedPush.status}`);

  // 会话过期：活跃设备自己 disconnect（token 从内存里删掉，active_device 仍指向它），
  // 下一次心跳必须是 session_expired 而不是 kicked——判错就是"用户什么都没做却被登出"
  const disc = await api("POST", "/api/sync/disconnect", { username: "alice", clientId: "c-alice-2", token: secondToken });
  check("活跃设备主动 disconnect 后 token 失效", disc.status === 200, `status=${disc.status}`);
  const expired = await heartbeat("alice", "c-alice-2", secondToken);
  check("会话过期的心跳返回 401 session_expired，且不得带 kicked=true",
    expired.status === 401 && expired.json?.kicked !== true,
    `status=${expired.status} body=${JSON.stringify(expired.json)}`);

  const neverSeen = await heartbeat("alice", "c-unknown-device", undefined);
  check("陌生设备无 token 心跳 401 要它带 token（不许误判成被顶替）",
    neverSeen.status === 401 && neverSeen.json?.kicked !== true, `status=${neverSeen.status}`);

  // ── 坏载荷过半：整次失败，客户端不推进水位 ──
  const halfBad = await push("bob", "c-bob-1", bobToken, {
    summaries: [{ title: "没有 id" }, { id: "s2" }, { id: "s3" }],
  });
  check("坏载荷过半时 422 整次失败（不能让客户端提交水位后丢掉那一半）",
    halfBad.status === 422 && halfBad.json?.data === undefined,
    `status=${halfBad.status} body=${JSON.stringify(halfBad.json)?.slice(0, 120)}`);

  const fewBad = await push("bob", "c-bob-1", bobToken, {
    summaries: [{ title: "坏1" }, { title: "坏2" }, { id: "s3", novelId: "ghost-book" }, { id: "s4", novelId: "ghost-book" }, { id: "s5", novelId: "ghost-book" }],
  });
  check("偶发几条坏记录时不整次失败，但要如实报出跳过数",
    fewBad.status === 200 && fewBad.json?.skippedRecords === 2,
    `status=${fewBad.status} skipped=${fewBad.json?.skippedRecords}`);
  check("引用不存在的书时回传 orphanedNovelIds（客户端据此补传母书）",
    Array.isArray(fewBad.json?.orphanedNovelIds) && fewBad.json.orphanedNovelIds.includes("ghost-book"),
    `orphaned=${JSON.stringify(fewBad.json?.orphanedNovelIds)}`);

  const stillAlive = await push("bob", "c-bob-1", bobToken, null);
  check("bob 的会话在两次推送之后仍然可用", stillAlive.status === 200, `status=${stillAlive.status}`);
} catch (e) {
  check("探针自身没有抛出", false, String(e && e.message ? e.message : e));
} finally {
  const exited = await new Promise((resolve) => {
    server.on("exit", (code, signal) => resolve({ code, signal }));
    if (server.killed || server.exitCode !== null) { resolve({ code: server.exitCode, signal: null }); return; }
    server.kill("SIGTERM");
    setTimeout(() => resolve({ code: server.exitCode, signal: "timeout" }), 5000);
  });
  exitInfo = exited;
  check("后端全程未崩溃退出", exitInfo.code === null || exitInfo.signal === "SIGTERM", JSON.stringify(exitInfo));
  check("日志里没有 unhandledRejection / uncaughtException",
    !/unhandledRejection|uncaughtException/.test(logs), logs.match(/(unhandledRejection|uncaughtException).{0,80}/)?.[0] || "");
  fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((x) => !x.ok);
console.log(`\n探针结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
