#!/usr/bin/env node
/**
 * 后端包完整性检查（出包闸门）：把已复制好的目录（默认 `backend-pack-tmp`）核对三件事，
 * 缺任何一只文件就中止打包。纯逻辑在 `scripts/lib/pack-gate.mjs`，判据在
 * `src/lib/__tests__/pack-gate.test.ts`（PG1..PG7＋刀账 PK1..PK8）。
 *
 * 为什么是出包前跑而不是打包后：漏复制的文件在开发机上看不见（源目录里都在），
 * 六只探针与 141 条浏览器也都跑源目录，只有用户解压启动后才炸——而且 worker 线程的
 * ERR_MODULE_NOT_FOUND 会被报成一句"Worker 异常退出"，谁都猜不到是少复制了一只文件。
 *
 * 用法：`node scripts/check-server-pack.mjs [包目录] [仓库根]`
 */
import fs from "node:fs";
import path from "node:path";
import {
  REQUIRED_PACK_FILES,
  listShippable,
  missingLocalDeps,
  missingRequiredFiles,
  missingSourceFiles,
} from "./lib/pack-gate.mjs";

const packDir = path.resolve(process.argv[2] || "backend-pack-tmp");
const repoRoot = path.resolve(process.argv[3] || ".");

if (!fs.existsSync(packDir)) {
  console.error(`[pack-check] 目录不存在: ${packDir}（请先运行 pack-backend.ps1 的复制步骤）`);
  process.exit(2);
}

/** 包内摊平：相对包根的路径 + 源文件内容（只读文本类，其它扩展名不需要解析引用） */
function readPack(dir, rel = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...readPack(full, r)); continue; }
    out.push({ path: r, source: /\.(?:js|mjs|cjs)$/.test(entry.name) ? fs.readFileSync(full, "utf-8") : "" });
  }
  return out;
}

const pack = readPack(packDir);
const packPaths = pack.map((f) => f.path);
const packServer = packPaths.filter((p) => p.startsWith("server/")).map((p) => p.slice("server/".length));
const sourceServer = listShippable(path.join(repoRoot, "server"));

// 只核 `server/` 里的源文件：全包还带 dist/，那是压缩产物，里面的字符串不是复制清单，
// 拿正则去扫它只会长出一堆假"缺文件"
const deps = missingLocalDeps(pack.filter((f) => f.path.startsWith("server/")), (p) => packPaths.includes(p));
const absentSources = missingSourceFiles(sourceServer, packServer);
const absentRoot = missingRequiredFiles(REQUIRED_PACK_FILES, packPaths);

const problems = [...deps, ...absentSources, ...absentRoot];

if (problems.length) {
  console.error(`[pack-check] 后端包有问题 ${problems.length} 条：`);
  for (const p of deps) console.error(`  - 引用缺文件：${p}`);
  for (const p of absentSources) console.error(`  - 源码树里的 ${p} 没进包（加进 pack-backend.ps1 的复制清单）`);
  for (const p of absentRoot) console.error(`  - 包根缺 ${p}`);
  process.exit(1);
}

// 取证：数量本身要说话——"通过"但核对了 0 只是另一种瞎
console.log(
  `[pack-check] 通过：包内 ${packPaths.length} 条（server/ ${packServer.length} 只，源码树 ${sourceServer.length} 只逐只对得上）、`
  + `支撑文件 ${REQUIRED_PACK_FILES.length} 条齐、本地依赖引用 ${deps.length} 条缺`,
);
