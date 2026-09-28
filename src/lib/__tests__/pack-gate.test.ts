/**
 * 发版包闸门（`scripts/lib/pack-gate.mjs`）的判据。
 *
 * 为什么放 `src/` 下面：vitest 的 include 只收 `src` 里的 `*.test.ts` 与 `*.spec.tsx`
 * （见 `vite.config.ts` 那段 test 配置），这是唯一能被 `npm test` 跑到的位置；
 * 被测代码本身在 `scripts/`，走 `node:fs` 读磁盘——jsdom 环境下这些 API 照样可用，
 * 所以不必标 node 环境（真标了会撞 `src/test/setup.ts` 里那句 `window`，整个文件收不起来）。
 *
 * 这一层为什么必须有判据：`pack-backend.ps1` 漏复制一只文件，在开发机上完全看不出来
 * （源目录里文件都在），六只探针与 141 条浏览器也全绿——只有用户解压后启动才炸。
 * 所以"包是不是完整的"这件事必须由出包前的一次静态核对着手，而核对着自己也得有牙。
 *
 * 刀账（每刀改 `scripts/lib/pack-gate.mjs`，改完立刻还原并核 sha256）：
 * - PK1 把 `.html` 从资产扩展名里摘掉（退回只认 js/mjs/py）→ PG1 红。
 * - PK2 把相对路径解析改成"永远算存在"→ PG2 红。
 * - PK3 删掉 `RUNTIME_PATH` 那一格豁免 → PG3 红。
 * - PK4 `missingLocalDeps` 的缺文件上报改成不报 → PG4 红。
 * - PK5 `missingSourceFiles` 直接返回空 → PG5 红。
 * - PK6 取消 `data/` 与 `*.log` 的排除 → PG6 红（同时 PG7 也红）。
 * - PK7 `REQUIRED_PACK_FILES` 缺一只却照样通过 → PG6 红。
 * - PK8 `SHIP_EXT` 退回只有 js/mjs（不收 py 与 html）→ PG7 红。
 */
import { describe, expect, it } from "vitest";

// @ts-expect-error - 出包脚本是纯 JS，没有类型声明（与 server/lib 那些同一待遇）
const gate = await import("../../../scripts/lib/pack-gate.mjs");
const {
  REQUIRED_PACK_FILES,
  listShippable,
  missingLocalDeps,
  missingRequiredFiles,
  missingSourceFiles,
} = gate as {
  REQUIRED_PACK_FILES: string[];
  listShippable: (root: string) => string[];
  missingLocalDeps: (files: Array<{ path: string; source: string }>, exists: (p: string) => boolean) => string[];
  missingRequiredFiles: (required: string[], pack: string[]) => string[];
  missingSourceFiles: (source: string[], pack: string[]) => string[];
};

/** 假包：给一组包内路径，`exists` 就只认这些 */
const packOf = (...paths: string[]) => {
  const set = new Set(paths);
  return { paths, exists: (p: string) => set.has(p) };
}

describe("PG 本地依赖：包内文件必须真的在包内", () => {
  it("PG1 引用了 `./admin.html` 而包里没这只 → 必须报（资源文件不是 js，以前正是这一格瞎）", () => {
    const files = [{
      path: "server/index.js",
      source: `const p = path.join(__dirname, "admin.html");\nres.sendFile(p);`,
    }];
    const pack = packOf("server/index.js");   // 没有 server/admin.html
    expect(missingLocalDeps(files, pack.exists)).toEqual(["server/index.js 需要 ./admin.html"]);
  });

  it("PG2 相对 import 的 `.mjs` 没复制 → 必须报（这是这只闸门最早的那一格，不许被后面的改动弄丢）", () => {
    const files = [{ path: "server/routes/rag.js", source: `import dp from "../lib/data-paths.mjs";` }];
    const pack = packOf("server/routes/rag.js");   // 没有 server/lib/data-paths.mjs
    expect(missingLocalDeps(files, pack.exists)).toEqual(["server/routes/rag.js 需要 ../lib/data-paths.mjs"]);
  });

  it("PG3 运行时才产生的 `data/` 与 `dist/` 路径不许报（否则真缺文件被假话淹掉）", () => {
    const files = [{
      path: "server/rag-worker.mjs",
      source: `const cfg = "./data/rag-config.json"; const shell = "./dist/index.html";`,
    }];
    const pack = packOf("server/rag-worker.mjs");
    expect(missingLocalDeps(files, pack.exists)).toEqual([]);
  });

  it("PG4 同一条源码里两处缺文件要各报一条，且指得出是谁需要谁", () => {
    const files = [{
      path: "server/index.js",
      source: `import cors from "./lib/cors-policy.mjs";\nimport "./admin.js";\nconst h = path.join(__dirname, "admin.html");`,
    }];
    const pack = packOf("server/index.js");
    const report = missingLocalDeps(files, pack.exists);
    expect(report).toHaveLength(3);
    expect(report.filter((r) => r.includes("./admin.html"))).toHaveLength(1);
    expect(report.filter((r) => r.includes("./lib/cors-policy.mjs"))).toHaveLength(1);
    expect(report.every((r) => r.startsWith("server/index.js 需要 "))).toBe(true);
  });
});

describe("PG 名字集合：仓库里的源码必须全进包", () => {
  it("PG5 源码树有、包里没有的 → 逐只点名（含 `routes/*.mjs` 这种通配接不住的扩展名）", () => {
    // 两头都给"相对 server/ 根"的路径：调用方负责把包内的 `server/…` 前缀摘掉
    const source = ["index.js", "lib/new-core.mjs", "routes/new-route.mjs", "admin.html"];
    const pack = ["index.js", "admin.html"];
    expect(missingSourceFiles(source, pack)).toEqual(["lib/new-core.mjs", "routes/new-route.mjs"]);
    // 两头都有时不许报
    expect(missingSourceFiles(source, source)).toEqual([]);
  });

  it("PG6 包根那几个支撑文件（改名后的 start/stop/admin、README、进程清理脚本）缺一只就要响", () => {
    expect(REQUIRED_PACK_FILES).toContain("start.bat");
    const pack = REQUIRED_PACK_FILES.filter((f) => f !== "scripts/cleanup-processes.sh");
    expect(missingRequiredFiles(REQUIRED_PACK_FILES, pack)).toEqual(["scripts/cleanup-processes.sh"]);
    // 两头都要取：全齐时不许报
    expect(missingRequiredFiles(REQUIRED_PACK_FILES, REQUIRED_PACK_FILES)).toEqual([]);
  });

  it("PG7 真仓库的 `server/` 摊出来：该带进包的都在名单里，运行时目录与日志不算源码", () => {
    const list = listShippable("server");
    // 这一格的基线就是 2026-09-29 核查量到的那 30 只里最承重的几只
    for (const must of ["index.js", "database.js", "admin.html", "tts-worker.py", "lib/tts-download.mjs", "routes/version.js"]) {
      expect(list, `源码清单里应当有 ${must}`).toContain(must);
    }
    expect(list.filter((f) => f.startsWith("data/"))).toEqual([]);
    expect(list.filter((f) => f.endsWith(".log"))).toEqual([]);
    expect(list.filter((f) => f.includes("__tests__"))).toEqual([]);
  });
});
