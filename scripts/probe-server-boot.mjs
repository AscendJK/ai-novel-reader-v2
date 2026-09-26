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
// 真实 server/data 里那几个探针可能碰到的文件：探针一旦把数据目录指错，这里就是证据
const REAL_DATA_DIR = path.join(repoRoot, "server", "data");
const WATCHED_IN_REAL_DIR = ["cert.pem", "key.pem", ".admin_token", "rag-config.json", "tts-cache", "tts-temp", "models-cache"];
function snapshotRealDataDir() {
  const snap = {};
  for (const name of WATCHED_IN_REAL_DIR) {
    try {
      const st = fs.statSync(path.join(REAL_DATA_DIR, name));
      snap[name] = `${st.size}:${Math.round(st.mtimeMs)}`;
    } catch { snap[name] = "<absent>"; }
  }
  return snap;
}
const realDirBefore = snapshotRealDataDir();

// 结构判据：证书与 tts 中转目录在启动期不一定有写动作（观测不到），所以用"不许再出现
// 硬编码 data 目录"来盯——任何人把某处写回硬路径，这里立刻红。
// 两种拼法都算：字符串里带 `/data/`（`"../data/x"`、`new URL("./data/x", …)`），
// 以及 `path.join(__dirname, "data", …)`。刻意不匹配 `"data"` 单独成词——
// 流事件 `on("data", …)` 到处在用，那样会把判据淹成噪音。
const DATA_HARDCODE = /["'`][^"'`\n]*\/data\/|__dirname\s*,\s*["']data["']/;
// 注释里出现 `../../data/key.pem` 这种说法是写给后人看的，不算硬编码。
// 先去块注释、再丢掉以 // 或 * 开头的行——判据要抓的是会执行的那一行。
const codeOnly = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
const hardcoded = [];
for (const sub of ["", "routes", "lib"]) {
  const dir = path.join(repoRoot, "server", sub);
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(js|mjs)$/.test(f)) continue;
    if (path.posix.join(sub, f) === "lib/data-paths.mjs") continue;
    if (DATA_HARDCODE.test(codeOnly(fs.readFileSync(path.join(dir, f), "utf8")))) {
      hardcoded.push(`server/${sub ? `${sub}/` : ""}${f}`);
    }
  }
}
check("server/ 里除 data-paths.mjs 外不再硬编码 data 目录", hardcoded.length === 0, hardcoded.join(", "));

// ── middleware/auth.js 的本体判据（第 1 档补直接判据）──
// 上面那些 HTTP 判据只量到"401 有没有回来"这一层；中间件那 75 行——Bearer 前缀怎么认、
// 切掉几个字符、失败时 next() 绝不能被叫——在探针进程里没有任何名字直接指着它。
// 这里 import 真模块、拿假 req/res 驱动。库单独指到一次性文件，绝不碰真实 server/data。
//
// 这一段刻意放在起服务之前：判据改坏时最先炸的往往是 HTTP 那一档（请求挂住 → 整轮探针崩掉，
// 读不到"到底是哪条判据红"）。先跑单元段，红的是名字而不是超时。
//
// 变异台账（产品基线 server/middleware/auth.js 1805 字节，sha256 前缀 93e7a9fa；
// 每轮一次手改一处带 MUT- 标记 → 跑 probe:boot → 按字节还原 → 当场核 SHA。
// 19 轮 = 16 轮刀（13 把不同的刀 + A7/A10/A13 三把在判据段挪位后重打）+ 3 轮对照；
// 每轮 markers=1（对照 0）、markers_left=0、diff_lines=0、sha=93e7a9fa。跑法 %TEMP%\knife-auth.sh）
//   A1  不看 Bearer 前缀            1 红  小写 bearer 那一格
//   A2  前缀少切一个字符            7 红  slice(6)：整条认不出人，放行/拒绝两半一起塌
//   A3  摘掉 `?.`（没带头）         1 红 + 整段被 TypeError 打断（没带头就抛）
//   A4  拒绝之前先 next()           2 红  没登录也照样跑路由
//   A5  回了 401 但没 return        3 红  next 被叫 + req.username 被写成 null
//   A6  认出来却不挂 username       1 红  下游全拿不到身份
//   A7b 匿名请求被静默吞掉          3 红  optionalAuth 不 next()：公开端点再也回不了话
//   A8  匿名时留成 null            2 红  undefined 与 null 这一格是真的
//   A9  没登录也返回 true           1 红  authNovel 说"过了"
//   A10b 登录了返回 false           1 红  15 个路由全部白屏（真实症状是请求挂住）
//   A11 两道闸门文案分家            1 红  requireAuth 与 authNovel 的 401 文案不再同一句
//   A12 有字就算登录（不查会话）   14 红  撤销的会话与陌生 token 全都认
//   A13b 失败不回 401              1 红  路由 return 掉，客户端只能等超时
//   三把重打的刀第一遍读不到数（red 段没跑到就整轮崩），所以判据段挪位后各重打一遍——
//   台账上 A7/A10/A13 那三行是"崩在 HTTP 段"，A7b/A10b/A13b 才是判据读数。
// 没有一记 0 红的刀，也没有等价变异。
{
  // 一次性**内存库**：这一支只需要 sync-handler 那张会话表，不落文件既没有清理问题
  // （Windows 上 better-sqlite3 的句柄要活到进程退出才放），也从根上碰不到真实 server/data。
  process.env.NOVEL_READER_DB_PATH = ":memory:";
  const { getSessionUsername, requireAuth, optionalAuth, authNovel } = await import("../server/middleware/auth.js");
  const { createSession, removeSession } = await import("../server/sync-handler.js");

  /** 只给 authorization 头，别的都不假造 */
  const reqWith = (header) => (header === undefined ? { headers: {} } : { headers: { authorization: header } });
  function resFake() {
    const res = {
      calls: [],
      status(code) { res.calls.push(["status", code]); return res; },
      json(body) { res.calls.push(["json", body]); return res; },
    };
    return res;
  }
  const nextWith = () => {
    const box = { calls: 0 };
    box.fn = () => { box.calls += 1; };
    return box;
  };
  const bodyOf = (res) => (res.calls.find((c) => c[0] === "json")?.[1] ?? null);
  const codeOf = (res) => (res.calls.find((c) => c[0] === "status")?.[1] ?? null);

  const alice = createSession("probe-alice");
  const bob = createSession("probe bob 甲");

  check("真模块能被探针进程 import（中间件与 sync-handler 接线没断）",
    [getSessionUsername, requireAuth, optionalAuth, authNovel].every((f) => typeof f === "function"));

  // ── getSessionUsername：认不认这一发 ──
  check("有效 Bearer token 认得出用户名", getSessionUsername(reqWith(`Bearer ${alice}`)) === "probe-alice");
  check("没有 authorization 头：null 而不是抛",
    (() => { try { return getSessionUsername(reqWith()) === null; } catch { return false; } })());
  check("空头（空字符串）：null", getSessionUsername(reqWith("")) === null);
  check("非 Bearer 方案（Basic）不许被当成已登录",
    getSessionUsername(reqWith("Basic YWxpY2U6")) === null);
  check("只认逐字 'Bearer ' 前缀：小写 bearer 现在不认（改这一格要连带改这条判据）",
    getSessionUsername(reqWith(`bearer ${alice}`)) === null);
  check("'Bearer' 少了那个空格不算认证头", getSessionUsername(reqWith(`Bearer${alice}`)) === null);
  check("'Bearer ' 后面空 token：null（不许拿 undefined 去查会话）",
    getSessionUsername(reqWith("Bearer ")) === null);
  check("未知 token：null", getSessionUsername(reqWith("Bearer not-a-session")) === null);
  check("切的就是前 7 个字符：token 里带空格也原样认",
    getSessionUsername(reqWith(`Bearer ${bob}`)) === "probe bob 甲");
  check("多切/少切都会当场暴露：前缀后两个空格的那一发认不出",
    getSessionUsername(reqWith(`Bearer  ${alice}`)) === null);
  const revoked = createSession("probe-carol");
  removeSession(revoked);
  check("会话撤销之后立刻认不出（退出登录不是一张空头支票）",
    getSessionUsername(reqWith(`Bearer ${revoked}`)) === null);

  // ── requireAuth：这道闸门的两半 ──
  const okReq = reqWith(`Bearer ${alice}`);
  const okRes = resFake();
  const okNext = nextWith();
  requireAuth(okReq, okRes, okNext.fn);
  check("requireAuth 放行时：next 叫一次", okNext.calls === 1, `next=${okNext.calls}`);
  check("requireAuth 放行时：req.username 挂上用户名", okReq.username === "probe-alice", `username=${okReq.username}`);
  check("requireAuth 放行时：一个字都不许回给客户端", okRes.calls.length === 0, JSON.stringify(okRes.calls));

  const badReq = reqWith("Bearer nope");
  const badRes = resFake();
  const badNext = nextWith();
  requireAuth(badReq, badRes, badNext.fn);
  check("requireAuth 拒绝时：next 一次都不许叫（叫了就是没登录也往下走）",
    badNext.calls === 0, `next=${badNext.calls}`);
  check("requireAuth 拒绝时：401 + 可识别的文案",
    codeOf(badRes) === 401 && bodyOf(badRes)?.error === "需要登录",
    `${codeOf(badRes)} ${JSON.stringify(bodyOf(badRes))}`);
  check("requireAuth 拒绝时：不许顺手给 req.username 赋任何值",
    "username" in badReq === false, `username=${JSON.stringify(badReq.username)}`);
  const noHdrRes = resFake();
  const noHdrNext = nextWith();
  requireAuth(reqWith(), noHdrRes, noHdrNext.fn);
  check("没带头也一样被拒（同一道闸门的另一个入口）",
    noHdrNext.calls === 0 && codeOf(noHdrRes) === 401, `next=${noHdrNext.calls} status=${codeOf(noHdrRes)}`);

  // ── optionalAuth：不拦路，但要把身份挂上 ──
  const optReq = reqWith(`Bearer ${alice}`);
  const optNext1 = nextWith();
  optionalAuth(optReq, resFake(), optNext1.fn);
  check("optionalAuth 带有效 token：挂上用户名并放行",
    optReq.username === "probe-alice" && optNext1.calls === 1, `username=${optReq.username} next=${optNext1.calls}`);
  const anonReq = reqWith();
  const optNext2 = nextWith();
  optionalAuth(anonReq, resFake(), optNext2.fn);
  check("optionalAuth 匿名：照样放行（公开端点不许被这道闸门挡住）", optNext2.calls === 1, `next=${optNext2.calls}`);
  check("optionalAuth 匿名：req.username 是 undefined 而不是 null",
    anonReq.username === undefined && "username" in anonReq,
    `username=${JSON.stringify(anonReq.username)}`);
  const badOptReq = reqWith("Bearer nope");
  const badOptRes = resFake();
  const badOptNext = nextWith();
  optionalAuth(badOptReq, badOptRes, badOptNext.fn);
  check("optionalAuth 拿坏 token：不回应答也不拦路，只是没有身份",
    badOptNext.calls === 1 && badOptRes.calls.length === 0 && badOptReq.username === undefined,
    `next=${badOptNext.calls} res=${JSON.stringify(badOptRes.calls)} username=${JSON.stringify(badOptReq.username)}`);

  // ── authNovel：novels/rag 那 15 个路由实际走的还是这一支 ──
  const legacyReq = reqWith(`Bearer ${alice}`);
  const legacyRes = resFake();
  check("authNovel 成功：返回 true、挂 req._username、不回应答",
    authNovel(legacyReq, legacyRes) === true && legacyReq._username === "probe-alice" && legacyRes.calls.length === 0,
    `_username=${legacyReq._username} res=${JSON.stringify(legacyRes.calls)}`);
  const legacyBadReq = reqWith("Bearer nope");
  const legacyBadRes = resFake();
  check("authNovel 失败：返回 false，且 401 文案与 requireAuth 同一句",
    authNovel(legacyBadReq, legacyBadRes) === false
      && codeOf(legacyBadRes) === 401 && bodyOf(legacyBadRes)?.error === "需要登录",
    `${codeOf(legacyBadRes)} ${JSON.stringify(bodyOf(legacyBadRes))}`);
  check("authNovel 失败：不许把 req._username 留成任何值",
    "_username" in legacyBadReq === false, `_username=${JSON.stringify(legacyBadReq._username)}`);

  const afterAuth = snapshotRealDataDir();
  const authChanged = WATCHED_IN_REAL_DIR.filter((n) => afterAuth[n] !== realDirBefore[n]);
  check("auth 判据这一段没碰真实 server/data",
    authChanged.length === 0,
    authChanged.length ? `被改动：${authChanged.join(", ")}` : `观测 ${WATCHED_IN_REAL_DIR.length} 项`);
}
  // 子进程 env 是 {...process.env} 摊开的：不清掉这一只，
  // 服务器会跑在内存库上，'库文件带进临时目录'那条判据就成了假红。
  delete process.env.NOVEL_READER_DB_PATH;


const child = spawn(process.execPath, [path.join(repoRoot, "server", "index.js")], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(PORT),
    // 后端总会起 HTTPS；不给空闲端口，探针在"应用正在跑"时必然启动失败
    HTTPS_PORT: String(await freePort()),
    // 一只 env 退掉全部落盘位置：DB、备份、.admin_token、证书、rag-config、tts 缓存与中转。
    // 原先这里逐只文件设 NOVEL_READER_DB_PATH / _BACKUP_DIR / _ADMIN_TOKEN_FILE，
    // 而证书与 tts-temp 根本没有 env 可退——探针于是在制作人真目录下跑。
    NOVEL_READER_DATA_DIR: workDir,
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

  // 接线判据：一只 env 到底管不管用，看的是文件落在哪——不是"日志里提过一句"。
  // 摘掉 admin.js / database.js 任一处对 dataPath 的使用，这两条就会红。
  check("NOVEL_READER_DATA_DIR 把口令文件带进了临时目录（admin.js 接线）", fs.existsSync(adminTokenFile));
  check("NOVEL_READER_DATA_DIR 把库文件带进了临时目录（database.js 接线）",
    fs.existsSync(path.join(workDir, "novels.db")));

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

  // ── RAG 编码/建库端点的入参守卫（这些 400 都在下载模型之前，跑起来不联网）──
  async function postJson(pathname, body, token) {
    const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.clone().json(); } catch { /* 非 JSON */ }
    return { status: res.status, json };
  }

  const encNoAuth = await postJson("/api/rag/encode", { texts: ["甲"] });
  check("未登录时不开放编码端点（局域网里能白嫖嵌入算力的口子）", encNoAuth.status === 401, `status=${encNoAuth.status}`);

  const reg = await postJson("/api/sync/register", { username: "probe-rag", clientId: "probe-rag-c1", mode: "create" });
  const sessionToken = reg.json?.token;
  check("探针取得会话 token 以继续（前置条件）", !!sessionToken, `status=${reg.status}`);

  const encEmpty = await postJson("/api/rag/encode", { texts: [] }, sessionToken);
  check("encode 空 texts 时 400", encEmpty.status === 400, `status=${encEmpty.status}`);

  const encTooMany = await postJson("/api/rag/encode", { texts: Array.from({ length: 21 }, (_, i) => `文本${i}`) }, sessionToken);
  check("encode 超过 20 条时 400（这条上限守着服务端内存）", encTooMany.status === 400,
    `status=${encTooMany.status} ${String(encTooMany.json?.error || "").slice(0, 40)}`);

  const encTooLong = await postJson("/api/rag/encode", { texts: ["甲".repeat(10001)] }, sessionToken);
  check("encode 单条超 10000 字时 400", encTooLong.status === 400, `status=${encTooLong.status}`);

  const encNotString = await postJson("/api/rag/encode", { texts: [{ nope: 1 }] }, sessionToken);
  check("encode 收到非字符串条目时 400 而不是拿去编码", encNotString.status === 400, `status=${encNotString.status}`);

  const badEngine = await postJson("/api/rag/encode", { texts: ["甲"], engine: "evil/model" }, sessionToken);
  check("白名单外引擎在编码侧被拒并回可选项（不许静默换成默认模型）",
    badEngine.status === 400 && Array.isArray(badEngine.json?.allowed) && badEngine.json.allowed.length > 0,
    `status=${badEngine.status} allowed=${JSON.stringify(badEngine.json?.allowed)?.slice(0, 60)}`);

  const badBuild = await postJson("/api/rag/book-1/build", { engine: "evil/model" }, sessionToken);
  check("白名单外引擎在建库侧同样被拒（两侧同判据，否则库与查询向量不同空间）",
    badBuild.status === 400, `status=${badBuild.status}`);

  child.kill("SIGTERM");
  const exitInfo = await Promise.race([
    exited,
    new Promise((r) => { setTimeout(() => r({ code: "TIMEOUT", signal: null }), 8000); }),
  ]);
  check("SIGTERM 干净退出", exitInfo.code === 0 || exitInfo.signal === "SIGTERM", JSON.stringify(exitInfo));
  check("进程日志无 unhandledRejection/uncaughtException", !/unhandledRejection|uncaughtException/.test(logs));
} finally {
  if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  // 等它真退出再比对，否则会漏掉一笔在途写
  await Promise.race([exited.catch(() => {}), new Promise((r) => { setTimeout(r, 5000); })]);
  const realDirAfter = snapshotRealDataDir();
  const changed = WATCHED_IN_REAL_DIR.filter((n) => realDirAfter[n] !== realDirBefore[n]);
  check("整轮探针没碰真实 server/data（证书/口令/缓存的 size+mtime 全不变）",
    changed.length === 0,
    changed.length ? `被改动：${changed.join(", ")}——数据目录没退干净，或有别的进程在写` : `观测 ${WATCHED_IN_REAL_DIR.length} 项`);
  fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n探针结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
