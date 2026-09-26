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

// ── middleware/rateLimit.js 的本体判据（第 1 档补直接判据）──
// 路由上挂了 8 处 rateLimit，但过去只有一条 HTTP 判据间接碰到它。这一节 import 真模块、
// 拿假 req/res 驱动，判：额度边界、按 ip 分桶、固定窗而不是滑动窗、清扫定时器与 unref。
//
// 时间是从外面给的：把 `Date.now` 临时换成一只可控钟，`setInterval` 换成一只
// 只记账不真跑的假把式——60 秒的窗与 120 秒的清扫都等不起，而"进程不退"这一格恰恰要靠
// unref 的记账看得见。整节没有 await，补丁关在自己的 try/finally 里，外面看到的是真钟。
//
// 变异台账（产品基线 server/middleware/rateLimit.js 1287 字节，sha256 前缀 83ae548c；
// 一次手改一处带 MUT- 标记 → 跑 probe:boot → 按字节还原 → 当场核 SHA。
// 13 刀 + 3 轮对照；每轮 markers=1（对照 0）、markers_left=0、diff_lines=0、sha=83ae548c。
// 跑法 %TEMP%\knife-rl.sh。括号里是被打红的判据条数）
//   R1  边界写成 >=            3 红  额度内那三发 / 边界那一格 / 新窗从 1 开始
//   R2  不分桶（全站一桶）      1 红  换一个 ip 就是新的一桶
//   R3  窗永不过（去掉过窗判断） 3 红  窗一到重新放行 / 新窗计数 / 不许顺延
//   R4  每发都顺延成滑动窗      4 红  上面三条再加"过窗之后再扫一次"
//   R5  429 换成 403            8 红  drained 谓词把状态码也算进去了，一处改全体塌
//   R6  文案换成英文            1 红  429 配一句人话
//   R7  回了 429 又 next()      8 红  同上（谓词还要求 next 一次都不叫）
//   R8  ip 优先级颠倒          2 红  换一个 ip / 以 req.ip 为准
//      （第一条也红是夹具给的：假 req 的 connection 一律默认 10.0.0.9，优先级一倒大家同桶）
//   R9c 去掉 connection 退路    2 红  ——第一遍 R9 只红 1 条：那时"退路"那条判据只断言"第一发放行"，
//      任何写法都绿。strengthen 成"两个不同的对端地址是两桶"之后重打才看得见（R9 与 R9b 是废读）
//   R10 清扫周期写成窗的一半    1 红  周期都是 2×窗
//   R11b 忘了 unref             1 红  unref 那条（第一遍 R11 红的是旧名字，改口径后重打）
//   R12 清扫条件写反            2 红  没到点的桶不许被误删 / 连叫 5 轮幂等
//   R13 扫帚掏空                0 红 ——这一记是**故意留下的判不到的格子**，见下
// 判不到的一格（诚实记下）：清扫回调"真的把过期条目从 Map 里删掉了"在进程外不可观测
//   ——`limits` 是闭包私有的，而过期条目本来就会被放行，删与不删读数一样。所以 R13 是 0 红。
//   能判到的四面是：定时器有没有被安排、周期对不对、unref 叫没叫、以及"没到点的桶不许被误删"。
//   真要盯内存增长，那是仓库外长跑那一档的活（与 rag-builder 的 [] 同一类处置）。
{
  const { rateLimit } = await import("../server/middleware/rateLimit.js");
  check("rateLimit 真模块能被探针进程 import 且是函数", typeof rateLimit === "function");

  const realNow = Date.now;
  const realSetInterval = globalThis.setInterval;
  const timers = [];
  const CLOCK0 = 1_700_000_000_000;
  let clock = CLOCK0;
  globalThis.Date.now = () => clock;
  globalThis.setInterval = (fn, ms) => {
    const handle = { ms, unrefCalls: 0, fn };
    handle.unref = () => { handle.unrefCalls += 1; return handle; };
    timers.push(handle);
    return handle;
  };

  try {
    /** 打一发：只给 ip 与 connection 两个形状，别的都不假造 */
    const hit = (mw, ip, conn = "10.0.0.9") => {
      const req = { connection: { remoteAddress: conn } };
      if (ip !== undefined) req.ip = ip;
      const res = { code: null, body: null };
      res.status = (c) => { res.code = c; return res; };
      res.json = (b) => { res.body = b; return res; };
      let nextCalls = 0;
      mw(req, res, () => { nextCalls += 1; });
      return { nextCalls, code: res.code, body: res.body };
    };
    const drained = (r) => r.code === 429 && r.nextCalls === 0;

    // ── 额度与边界 ──
    clock = CLOCK0;
    const m3 = rateLimit(3);
    const a1 = hit(m3, "1.1.1.1"), a2 = hit(m3, "1.1.1.1"), a3 = hit(m3, "1.1.1.1"), a4 = hit(m3, "1.1.1.1");
    check("额度内的每一发都放行，且放行时一个字都不回给客户端",
      [a1, a2, a3].every((r) => r.nextCalls === 1 && r.code === null && r.body === null),
      JSON.stringify([a1, a2, a3]));
    check("边界是第 N 发放行、第 N+1 发才拒（多切少切都看得见）",
      a3.nextCalls === 1 && drained(a4), `第3发 next=${a3.nextCalls}，第4发 next=${a4.nextCalls} code=${a4.code}`);
    check("被拒那一发：next 一次都不叫（叫了就是限流形同虚设）", a4.nextCalls === 0, `next=${a4.nextCalls}`);
    check("被拒那一发：429 配一句人话",
      a4.code === 429 && a4.body?.error === "请求过于频繁，请稍后再试",
      `${a4.code} ${JSON.stringify(a4.body)}`);

    // ── 按 ip 分桶、按实例分桶 ──
    const other = hit(m3, "2.2.2.2");
    check("换一个 ip 就是新的一桶：A 被打满不影响 B 的第一发",
      other.nextCalls === 1 && other.code === null, JSON.stringify(other));
    const m3b = rateLimit(3);
    const fresh = hit(m3b, "1.1.1.1");
    check("换一个限流实例就是新的一桶：m3 里 1.1.1.1 已经被打满，新实例的第一发照样放行",
      drained(fresh) === false, `新实例第1发 next=${fresh.nextCalls} code=${fresh.code}`);

    // ── ip 从哪来 ──
    const byConn = rateLimit(1);
    const c1 = hit(byConn, undefined, "7.7.7.7");
    const c2 = hit(byConn, undefined, "8.8.8.8");
    check("req.ip 缺失时按 connection.remoteAddress 分桶：两个不同的对端地址是两桶",
      c1.nextCalls === 1 && c2.nextCalls === 1 && c2.code === null,
      `${JSON.stringify(c1)} ${JSON.stringify(c2)}`);
    const sameExplicit = (() => {
      const mw = rateLimit(1);
      hit(mw, "3.3.3.3", "9.9.9.9");
      return hit(mw, undefined, "3.3.3.3");
    })();
    check("req.ip 在时以它为准：与显式写了同一个 ip 的请求共用一桶",
      drained(sameExplicit), `第二发 next=${sameExplicit.nextCalls} code=${sameExplicit.code}`);

    // ── 窗：固定窗，不是滑动窗 ──
    clock = CLOCK0 + 59_000;
    const stillShut = hit(m3, "1.1.1.1");
    check("第 59 秒仍然被拒：窗没到点不许提前放行", drained(stillShut), `code=${stillShut.code}`);
    clock = CLOCK0 + 60_001;
    const reopened = hit(m3, "1.1.1.1");
    const n2 = hit(m3, "1.1.1.1"), n3 = hit(m3, "1.1.1.1"), n4 = hit(m3, "1.1.1.1");
    check("窗一到（60_001ms）同一个 ip 重新放行",
      reopened.nextCalls === 1 && reopened.code === null, JSON.stringify(reopened));
    check("新窗的计数是从 1 开始，不是接着上一窗累加",
      n2.nextCalls === 1 && n3.nextCalls === 1 && drained(n4),
      `第2/3/4发 next=${n2.nextCalls}/${n3.nextCalls}/${n4.nextCalls}`);
    const SWIPE = rateLimit(1);
    clock = CLOCK0 + 200_000;
    hit(SWIPE, "4.4.4.4");                   // 第 1 发放行：窗从这一刻起算，到 260_000
    clock = CLOCK0 + 230_000;
    const swShut = hit(SWIPE, "4.4.4.4");    // 被拒的一发
    clock = CLOCK0 + 260_001;                // 距第 1 发正好过窗
    const afterRejectedHits = hit(SWIPE, "4.4.4.4");
    check("被拒的那些发不许把窗往后顺延（滑动窗会让人永远出不去这个坑）",
      drained(swShut) && afterRejectedHits.nextCalls === 1 && afterRejectedHits.code === null,
      `被拒那一发 code=${swShut.code}，过窗那一发 next=${afterRejectedHits.nextCalls} code=${afterRejectedHits.code}`);

    // ── 清扫 ──
    const liveBuckets = rateLimit(1);
    hit(liveBuckets, "5.5.5.5");             // 此刻 = 260_001，窗到 320_001
    hit(liveBuckets, "5.5.5.5");             // 已被拒
    clock = CLOCK0 + 300_000;
    for (const t of timers) t.fn();
    const afterSweep = hit(liveBuckets, "5.5.5.5");
    check("手工触发清扫：没到点的桶不许被误删（删了就是限流悄悄归零）",
      drained(afterSweep), `清扫后那一发 next=${afterSweep.nextCalls} code=${afterSweep.code}`);
    let sweptAgain = true;
    try { for (let i = 0; i < 5; i++) for (const t of timers) t.fn(); } catch { sweptAgain = false; }
    check("清扫连叫 5 轮：幂等且不抛（同一把扫帚不该改变读数）",
      sweptAgain && drained(hit(liveBuckets, "5.5.5.5")));
    clock = CLOCK0 + 321_000;
    for (const t of timers) t.fn();
    const reopenedAfterSweep = hit(liveBuckets, "5.5.5.5");
    check("过窗之后再扫一次：那一桶照常重来（清扫不许把正常的窗逻辑搅坏）",
      reopenedAfterSweep.nextCalls === 1 && reopenedAfterSweep.code === null,
      JSON.stringify(reopenedAfterSweep));

    // 放在最后：这一条数的是"到这儿为止一共开了几只限流"，前面每造一只都得算上
    check("每一次 rateLimit() 都安排了一只清扫定时器，周期都是 2×窗",
      timers.length === 6 && timers.every((t) => t.ms === 120_000),
      `定时器 ${timers.length} 只，周期 ${[...new Set(timers.map((t) => t.ms))].join("/")}`);
    check("定时器都 unref 过（没别的活儿时不该由它把进程钉住；SIGTERM 那条判据抓不到这个）",
      timers.every((t) => typeof t.fn === "function" && t.unrefCalls === 1),
      `unref 次数 ${timers.map((t) => t.unrefCalls).join("/")}`);
  } finally {
    Date.now = realNow;
    globalThis.setInterval = realSetInterval;
  }
}


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
