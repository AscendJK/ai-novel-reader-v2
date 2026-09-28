/**
 * 发版包完整性核对的纯逻辑（`scripts/check-server-pack.mjs` 的底层，抽出来是为了能单测）
 *
 * 为什么要有这一只文件：`pack-backend.ps1` 逐条枚举要复制的文件，新增一只
 * `server/**` 很容易被忘记——这在开发机上完全看不出来（源目录文件都在），只有用户
 * 解压后启动才炸，而 worker 线程的 ERR_MODULE_NOT_FOUND 会被 rag-builder 报成
 * 一句"Worker 异常退出"。
 *
 * 三格各自守一件事（判据在 `src/lib/__tests__/pack-gate.test.ts`，PG1..PG7）：
 * ① 包内源文件引用的本地文件必须也在包内——**包括非 js 的资源**（`server/index.js:72`
 *    那句 `path.join(__dirname, "admin.html")` 以前正好落在扩展名过滤的盲区里）；
 * ② 源码树里该带进包的每一只都必须进包（不靠"有没有人 import 它"，所以新增一只
 *    没人 import 的文件、或 `routes/*.mjs` 这种通配接不住的扩展名，也会当场点名）；
 * ③ 包根那几个改名后的支撑文件必须齐。
 *
 * 这一层只认"包里的字节"：不跑 npm、不连网络、不碰 `server/data/`。
 */
import fs from "node:fs";
import path from "node:path";

/** 指向另一只必须自带的文件：`from "…"`／`require("…")`／`import("…")` */
const LOCAL_SPEC = /(?:^|\s)(?:from|require\(|import\()\s*["'](\.[^"']+)["']/g;
/** `path.join(__dirname, "a", "b")` 这种运行时拼出来的资源路径 */
const PATH_JOIN = /path\.(?:join|resolve)\(\s*__dirname\s*(?:,\s*["']([^"']+)["']\s*)+/g;
/** 字面量里直接写出的相对路径（`import "./x.js"` 的无括号形式也走这一条） */
const DOT_STRING = /["'](\.[^"']+\.[A-Za-z0-9]{1,6})["']/g;

/** 该进包的源码文件扩展名（`.log`、`.json`、模型缓存都不在这条路上） */
const SHIP_EXT = new Set([".js", ".mjs", ".cjs", ".py", ".html"]);
/** 只扫这些扩展名的源码去解析引用 */
const SCAN_EXT = new Set([".js", ".mjs", ".cjs"]);
/** 引用里算"包内文件"的后缀——与 SHIP_EXT 同一套，两边走神必然漏一边 */
const ASSET_EXT = /\.(?:mjs|js|cjs|py|html)$/i;
/** 运行时才创建、或由前端构建产出：报出来只会淹掉真正的缺文件 */
const RUNTIME_PATH = /(^|[\\/])(?:data|dist)([\\/]|$)/;
/** 摊源码树时整棵跳过的目录 */
const SKIP_DIRS = new Set(["data", "dist", "node_modules", "__tests__"]);

/** 包根必须存在的支撑文件（`pack-backend.ps1` 的改名与复制清单，写死在这里好过散在脚本里） */
export const REQUIRED_PACK_FILES = [
  "package.json",
  "README.txt",
  "start.bat",
  "start.sh",
  "stop.bat",
  "stop.sh",
  "admin.bat",
  "admin.sh",
  "scripts/cleanup-processes.ps1",
  "scripts/cleanup-processes.sh",
];

/** 源码里"指向一个包内文件"的相对路径清单 */
export function localDepSpecs(source) {
  const specs = [];
  for (const m of source.matchAll(LOCAL_SPEC)) specs.push(m[1]);
  for (const m of source.matchAll(DOT_STRING)) specs.push(m[1]);
  for (const m of source.matchAll(PATH_JOIN)) {
    const parts = m.slice(1).filter(Boolean);
    if (parts.length) specs.push("./" + path.posix.join(...parts));
  }
  return specs;
}

/**
 * ① 包内每个源文件引用的本地文件是否都在包内。
 * @param files 已复制好的包内条目：`path` 为相对包根的路径（正斜杠）
 * @param exists 判断"这条相对路径在包内是否存在"
 */
export function missingLocalDeps(files, exists) {
  const missing = [];
  for (const file of files) {
    if (!SCAN_EXT.has(path.posix.extname(file.path))) continue;
    for (const spec of new Set(localDepSpecs(file.source))) {
      if (!ASSET_EXT.test(spec) || RUNTIME_PATH.test(spec)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), spec));
      if (!exists(target)) missing.push(`${file.path} 需要 ${spec}`);
    }
  }
  return missing;
}

/** ② 源码树里应当进包的清单：跳过运行时目录与日志 */
export function listShippable(root) {
  const out = [];
  const rec = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) rec(path.join(dir, entry.name), r);
        continue;
      }
      if (entry.name.endsWith(".log")) continue;
      if (SHIP_EXT.has(path.extname(entry.name))) out.push(r);
    }
  };
  rec(root, "");
  return out.sort();
}

/** ② 源码里有、包里没有的（两头都是相对 `server/` 根的路径） */
export function missingSourceFiles(source, pack) {
  const have = new Set(pack);
  return source.filter((f) => !have.has(f));
}

/** ③ 包根白名单里缺的 */
export function missingRequiredFiles(required, pack) {
  const have = new Set(pack);
  return required.filter((f) => !have.has(f));
}
