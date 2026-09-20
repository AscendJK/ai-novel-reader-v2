#!/usr/bin/env node
/**
 * 后端包完整性检查：把已复制好的目录（默认 backend-pack-tmp）里每个 js/mjs 文件的
 * 本地依赖解析一遍，缺文件就直接失败。
 *
 * 为什么需要它：pack-backend.ps1 逐条枚举要复制的文件，新增一个 server/lib/*.mjs
 * 很容易只改源码不改脚本。这类缺失在开发机上完全看不出来（源目录里文件在），
 * 只有用户解压发布包启动后才炸——而 worker 线程的 ERR_MODULE_NOT_FOUND 会被
 * rag-builder 报成一句"Worker 异常退出"，谁都猜不到是少复制了一个文件。
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || "backend-pack-tmp");
if (!fs.existsSync(root)) {
  console.error(`[pack-check] 目录不存在: ${root}（请先运行 pack-backend.ps1 的复制步骤）`);
  process.exit(2);
}

const LOCAL_SPEC = /(?:^|\s)(?:from|require\(|import\()\s*["'](\.[^"']+)["']/g;
const PATH_JOIN = /path\.(?:join|resolve)\(\s*__dirname\s*(?:,\s*["']([^"']+)["']\s*)+/g;
const ASSET_REF = /["'](\.[^"']+\.(?:mjs|js|py))["']/g;
const SOURCE_EXT = new Set([".js", ".mjs"]);

// 只查"包内应当带着的代码文件"。data/ 与 dist/ 下的路径是运行时创建或由前端构建
// 产出，不在复制清单里，报出来只会把真正的缺文件淹掉。
const RUNTIME_PATH = /(^|[\\/])(?:data|dist)([\\/]|$)/;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SOURCE_EXT.has(path.extname(entry.name))) yield full;
  }
}

/** 被引用的目标文件：worker 子进程与 Python 脚本按同一条规则查 */
function assetRefs(src) {
  const refs = [];
  for (const m of src.matchAll(ASSET_REF)) refs.push(m[1]);
  for (const m of src.matchAll(PATH_JOIN)) {
    const parts = m.slice(1).filter(Boolean);
    if (parts.length) refs.push("./" + path.join(...parts));
  }
  return refs;
}

const missing = [];
const checked = [];
for (const file of walk(root)) {
  const src = fs.readFileSync(file, "utf-8");
  const specs = [];
  for (const m of src.matchAll(LOCAL_SPEC)) specs.push(m[1]);
  for (const spec of assetRefs(src)) specs.push(spec);
  for (const spec of new Set(specs)) {
    if (!/\.(mjs|js|py)$/.test(spec) || RUNTIME_PATH.test(spec)) continue;
    const target = path.resolve(path.dirname(file), spec);
    checked.push(`${path.relative(root, file)} -> ${spec}`);
    if (!fs.existsSync(target)) missing.push(`${path.relative(root, file)} 需要 ${spec}`);
  }
}

if (missing.length) {
  console.error(`[pack-check] 后端包缺 ${missing.length} 个被引用的文件：`);
  for (const m of missing) console.error(`  - ${m}`);
  console.error("修法：把这些文件加进 pack-backend.ps1 的复制清单。");
  process.exit(1);
}
console.log(`[pack-check] 通过：${checked.length} 条本地依赖全部在包内`);
