import { readFileSync, existsSync, statSync, writeFileSync, openSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 跑真后端那一档之前的硬检查 + **这一轮专用的后端进程**。
 *
 * 宁可在这里红得明白，也不要后面每条用例各自把"连不上"读成"元素不见了"。
 *
 * 为什么必须由这一档自己起一台（2026-09-22 实测之后加的）：后端有两处状态活在**进程内存**里，
 *  1. `/api/rag/model-proxy` 的 `rateLimit(10)/分钟/IP` —— 上一轮攒下的计数会把这一轮
 *     用户那次取模型掐成 429；
 *  2. TTS 资源闸门的 `ready` 记忆（`server/lib/tts-resource-gate.mjs`）—— 修好之前，
 *     上一轮下完模型、这一轮把缓存清掉，点「启用」就会空响到超时（R-D1 卡了 14 分钟）。
 * 复用手工挂着的那台 = 判据静默降级成"看上一轮跑到哪了"。所以**端口上只要已经活着一只
 * 后端就红**（版本号对得上也不行——"版本正确 + 界面正常"恰恰是上一轮没收尾的那只的特征），
 * 除非显式 `ANR_REAL_REUSE_SERVER=1`。
 *
 * 三件事必须成立才让跑：
 *  1. 目标 origin 真的是**发版包**在跑（`/api/version` 与仓库 `package.json` 同版本，
 *     且 `--full` 模式在伺服前端 —— 精简包不会回 HTML，那种状态下整档用例都是假象）；
 *  2. 制作人事先声明过的那个"一次性数据目录"存在，且**不在仓库里**（这一档不许碰
 *     `server/data/`，那是他的真库、证书和口令）；
 *  3. 仓库 `server/data/` 的三个敏感文件被记下 size+mtime，交给 `r-account` 的最后一条
 *     用例收尾时比对（同一个判据在 `probe-server-boot` 里已经管着探针侧）。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const ORIGIN = process.env.ANR_REAL_ORIGIN ?? "http://127.0.0.1:5399";
const DATA_DIR = process.env.ANR_REAL_DATA_DIR ?? "";
/** 发版包根目录（里面有 `server/index.js` 与 `dist/`）。台架约定：数据目录的兄弟 `full/`。 */
const PACK_DIR = process.env.ANR_REAL_PACK ?? path.join(path.resolve(DATA_DIR, ".."), "full");
/** 设成 1 就跳过"自己起一台"，用手工挂着的那只（只给调试用，判据会带上上一轮的内存状态）。 */
const REUSE = process.env.ANR_REAL_REUSE_SERVER === "1";

function fail(msg: string): never {
  throw new Error(`[真后端台架] ${msg}`);
}

/** 从 PATH 里剥掉 mkcert 所在目录：`generateCert()` 会跑 `mkcert -install`，那是改系统信任根。 */
function pathWithoutMkcert(p: string): string {
  const kept = p.split(path.delimiter).filter((d) => {
    if (!d) return false;
    try {
      return !existsSync(path.join(d, "mkcert.exe")) && !existsSync(path.join(d, "mkcert"));
    } catch {
      return true;
    }
  });
  return kept.join(path.delimiter);
}

async function versionOf(): Promise<string> {
  try {
    const r = await fetch(`${ORIGIN}/api/version`, { signal: AbortSignal.timeout(4000) });
    return String((await r.json() as { version?: string }).version ?? "");
  } catch {
    return "";
  }
}

/** 只等这一档自己起的那一只进程，绝不碰别人的 PID。 */
function killOwn(child: ReturnType<typeof spawn>, log: string): void {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      // /T：后端会带 python 子进程，只杀父会留一只孤儿继续占着模型
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
    appendFileSync(log, `[bench] 收尾：已停掉本轮起的后端 pid=${child.pid}\n`);
  } catch (e) {
    appendFileSync(log, `[bench] 收尾：停 pid=${child.pid} 失败 ${(e as Error).message}（请手工停）\n`);
  }
}

export default async function preflight(): Promise<() => void> {
  const want = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version as string;

  if (!DATA_DIR) fail("没设 ANR_REAL_DATA_DIR：这一档必须指向包外的一次性数据目录，不许落在仓库的 server/data 上");
  if (!existsSync(DATA_DIR)) fail(`ANR_REAL_DATA_DIR=${DATA_DIR} 不存在`);
  if (path.resolve(DATA_DIR).startsWith(repoRoot)) fail(`ANR_REAL_DATA_DIR 在仓库里（${DATA_DIR}）：换成仓库外的目录`);

  let version = await versionOf();
  const teardowns: Array<() => void> = [];

  // **端口上只要已经活着一只后端就红**（除非显式 REUSE）：判"版本号对不对"挡不住
  // 上一轮没收尾的那只——它版本正确、界面正常，而它的**进程内存**里带着上一轮的
  // 限流计数与闸门 `ready`，正是这段注释开头要防的那种静默降级。
  if (version && !REUSE) {
    fail(
      `${ORIGIN} 上已经有一只后端在跑（version=${version}），而它不是本轮起的：` +
        `限流计数与 TTS 闸门状态都在进程内存里，复用会把判据静默换成"看上一轮跑到哪"。` +
        `先停掉它（只停自己记账里那一只，别用 start.bat/stop.bat 那种全局杀），或确定要复用就显式 ANR_REAL_REUSE_SERVER=1`,
    );
  }

  if (!version && !REUSE) {
    if (!existsSync(path.join(PACK_DIR, "server", "index.js"))) {
      fail(`包里找不到 ${PACK_DIR}/server/index.js：先出包解压（或显式设 ANR_REAL_PACK）`);
    }
    const log = path.join(path.resolve(DATA_DIR, ".."), "server.log");
    const fd = openSync(log, "a");
    appendFileSync(fd, `\n===== [bench] 由 e2e/specs-real/preflight.ts 起的一轮 =====\n`);
    const child = spawn(process.execPath, ["server/index.js", "--full"], {
      cwd: PACK_DIR,
      env: {
        ...process.env,
        // 只发 HTTP：证书目录不存在时会触发 `mkcert -install`（动系统信任根），
        // 把 mkcert 从 PATH 剥掉，`generateCert` 就报"没找到"并退回 HTTP-only
        PATH: pathWithoutMkcert(process.env.PATH ?? ""),
        NOVEL_READER_DATA_DIR: DATA_DIR,
        PORT: String(new URL(ORIGIN).port || "5399"),
      },
      stdio: ["ignore", fd, fd],
    });
    teardowns.push(() => killOwn(child, log));
    for (let i = 0; i < 60 && !version; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      version = await versionOf();
    }
  }

  if (!version) {
    fail(`${ORIGIN}/api/version 连不上：全包起不起来见 server.log 与 docs/e2e-real-deploy-plan-2026-09.md §1`);
  }
  if (version !== want) {
    fail(`${ORIGIN} 报的版本是 "${version}"，仓库是 "${want}"：这不是本次代码的包，别跑`);
  }

  const page = await fetch(`${ORIGIN}/ai-novel-reader-v2/`, { signal: AbortSignal.timeout(8000) });
  const html = await page.text();
  if (!html.includes("<div id=\"root\">")) fail("`--full` 的前端伺服没起来（拿到的 HTML 里没有 #root）");
  if (!/\/ai-novel-reader-v2\/.*\.js/.test(html)) fail("index.html 里的资源路径没带 base 前缀：包内 dist 与 base 配置不一致");

  // 起跑前把开发目录的指纹存进**一次性目录**里（不往仓库根扔文件），交给 R-B5 收尾比对
  writeFileSync(path.join(DATA_DIR, "dev-data-baseline.json"), JSON.stringify(devDataFingerprint(), null, 2));

  return () => {
    for (const t of teardowns) t();
  };
}

/** 一次性目录里那份起跑前指纹的位置（R-B5 读它） */
export const DEV_DATA_BASELINE = path.join(DATA_DIR, "dev-data-baseline.json");

/** 开发目录 `server/data/` 的指纹（只 stat，不读内容），供收尾用例比对。 */
export function devDataFingerprint(): { file: string; size: number; mtimeMs: number }[] {
  return ["key.pem", "cert.pem", ".admin_token", "novels.db"].map((file) => {
    const p = path.join(repoRoot, "server", "data", file);
    try {
      const s = statSync(p);
      return { file, size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return { file, size: -1, mtimeMs: -1 };
    }
  });
}
