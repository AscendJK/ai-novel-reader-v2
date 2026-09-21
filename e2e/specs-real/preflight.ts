import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 跑真后端那一档之前的硬检查：宁可在这里红得明白，也不要后面每条用例各自
 * 把"连不上"读成"元素不见了"。
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

function fail(msg: string): never {
  throw new Error(`[真后端台架] ${msg}`);
}

export default async function preflight(): Promise<void> {
  const want = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version as string;

  let version = "";
  try {
    const r = await fetch(`${ORIGIN}/api/version`, { signal: AbortSignal.timeout(8000) });
    version = String((await r.json() as { version?: string }).version ?? "");
  } catch (e) {
    fail(`${ORIGIN}/api/version 连不上（${(e as Error).message}）：先把仓库外的全包起起来，见 docs/e2e-real-deploy-plan-2026-09.md §1`);
  }
  if (version !== want) fail(`${ORIGIN} 报的版本是 "${version}"，仓库是 "${want}"：这不是本次代码的包，别跑`);

  const page = await fetch(`${ORIGIN}/ai-novel-reader-v2/`, { signal: AbortSignal.timeout(8000) });
  const html = await page.text();
  if (!html.includes("<div id=\"root\">")) fail("`--full` 的前端伺服没起来（拿到的 HTML 里没有 #root）");
  if (!/\/ai-novel-reader-v2\/.*\.js/.test(html)) fail("index.html 里的资源路径没带 base 前缀：包内 dist 与 base 配置不一致");

  if (!DATA_DIR) fail("没设 ANR_REAL_DATA_DIR：这一档必须指向包外的一次性数据目录，不许落在仓库的 server/data 上");
  if (!existsSync(DATA_DIR)) fail(`ANR_REAL_DATA_DIR=${DATA_DIR} 不存在`);
  if (path.resolve(DATA_DIR).startsWith(repoRoot)) fail(`ANR_REAL_DATA_DIR 在仓库里（${DATA_DIR}）：换成仓库外的目录`);

  // 起跑前把开发目录的指纹存进**一次性目录**里（不往仓库根扔文件），交给 R-B5 收尾比对
  writeFileSync(path.join(DATA_DIR, "dev-data-baseline.json"), JSON.stringify(devDataFingerprint(), null, 2));
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
