#!/usr/bin/env node
/**
 * H 组（PWA / Service Worker / 离线）用的静态服务器：伺服 `dist/`，挂在同一个 base 路径下。
 *
 * 为什么不用 `vite preview`（计划 §3.2 原本写的是 preview）：本机实测
 * `node_modules/vite/dist/node/chunks/node.js:33852` 是
 * `headers: preview?.headers ?? server.headers`，而 `vite.config.ts:133-139` 在
 * `server.headers` 里配了 COOP/COEP —— preview 于是**白送**跨源隔离头。
 * 生产部署在 GitHub Pages，它给不出任何自定义头，隔离完全靠 `scripts/inject-coi.cjs`
 * 拼进 sw.js 的那段代码。用 preview 测出来的 H1 在真线上不成立，而且 SW 坏了也不会红。
 *
 * 所以这里自己起一台：只发文件，不发 COOP/COEP，并且 `no-store`（缓存交给 SW，
 * 别叠一层 HTTP 缓存，否则 H3 的"新版本"检测会被浏览器缓存糊过去）。
 *
 * dist 缺失或比源码旧就直接重建：宁可慢，也不要拿旧构建产物跑出一份假绿。
 * 注意这个判断只在**进程启动时**做一次——手工把这台挂着再改源码，Playwright 会
 * 复用进程（`reuseExistingServer`）也就不会重建，那种时候先 `npm run build` 或把它停掉。
 */
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const distDir = path.join(repoRoot, "dist");

const PORT = Number(process.env.E2E_BUILD_PORT ?? 5275);
/** 与 `vite.config.ts:16` 的 BASE_PATH 一致；base 不带就是 404。 */
const BASE = "/ai-novel-reader-v2/";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".txt": "text/plain",
};

/** 参与构建的输入有多新：源码、public、配置，以及会被拼进 sw.js 的 COI 片段。 */
function newestInput(dir) {
  let max = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // 模型权重和 sherpa 的 onnx 体积大、不参与构建判定，跳过省掉无谓的 stat
    if (!entry.isDirectory() && /\.(onnx|bin|tflite)$/i.test(entry.name)) continue;
    const mtime = entry.isDirectory() ? newestInput(full) : statSync(full).mtimeMs;
    if (mtime > max) max = mtime;
  }
  return max;
}

function sourcesNewerThanDist() {
  const built = path.join(distDir, "sw.js");
  if (!existsSync(built) || !existsSync(path.join(distDir, "index.html"))) return true;
  const builtAt = statSync(built).mtimeMs;
  const inputs = [
    newestInput(path.join(repoRoot, "src")),
    newestInput(path.join(repoRoot, "public")),
    ...["index.html", "vite.config.ts", "package.json", "scripts/coi-sw.js", "scripts/inject-coi.cjs"].map(
      (f) => statSync(path.join(repoRoot, f)).mtimeMs,
    ),
  ];
  return Math.max(...inputs) > builtAt;
}

function ensureBuilt() {
  if (!sourcesNewerThanDist()) {
    console.log("[serve-dist] 复用 dist/（比全部源码旧）");
    return;
  }
  console.log("[serve-dist] dist 缺失或已过期，跑 npm run build");
  const r = spawnSync("npm", ["run", "build"], { cwd: repoRoot, shell: true, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`[serve-dist] 构建失败，exit=${r.status}`);
    process.exit(r.status ?? 1);
  }
}

ensureBuilt();

/**
 * H3 的「发新版本」开关：只在需要时把一段探针拼到 sw.js 尾巴上，
 * 于是这一份 SW 与上一份**字节不同**——浏览器据此判定有更新，走的正是真线上
 * 「发了版、旧标签页还开着」那条路。默认不拼：拼了会改所有用例的 SW 字节，
 * 别的用例可能凭空冒出一个「有新版本可用」横幅。
 *
 * 为什么用服务器而不是 `page.route` 换脚本：实测 Chromium 装进注册的**不是**
 * 桩回去的那一份（`route` 命中一次、装好的 SW 里 `self.__E2E_REV` 仍是 undefined、
 * 页内 fetch 拿 404），SW 脚本的抓取不受页面级拦截管辖。
 */
let swRev = null;
const REV_PATH = `${BASE}__e2e-sw-rev`;
const revMarker = (rev) =>
  `\nself.addEventListener("fetch",(e)=>{if(e.request.url.endsWith("/__e2e_sw_rev"))e.respondWith(new Response(${JSON.stringify(rev)},{headers:{"Content-Type":"text/plain"}}))});\n`;

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname === REV_PATH) {
    // 只绑在 127.0.0.1 上，且这个路径不是应用会请求的，不存在"线上多一个后门"
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const value = body.trim();
        swRev = value === "" ? null : (/^[\w-]{1,32}$/.test(value) ? value : null);
        if (body.trim() !== "" && swRev === null) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("bad rev");
          return;
        }
        res.writeHead(204);
        res.end();
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end(swRev ?? "");
    return;
  }
  if (url.pathname === "/" || url.pathname === "") {
    res.writeHead(302, { Location: BASE });
    res.end();
    return;
  }
  if (!url.pathname.startsWith(BASE)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  const rel = url.pathname.slice(BASE.length);
  const target = path.resolve(distDir, rel === "" ? "index.html" : rel);
  // 越界防护：resolve 之后必须还在 dist 里，否则 `../` 能把仓库任何文件读出去
  if (target !== distDir && !target.startsWith(distDir + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden");
    return;
  }
  const file = existsSync(target) && statSync(target).isDirectory() ? path.join(target, "index.html") : target;
  if (!existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  // 一律用 Buffer：Content-Length 要的是字节数，字符串的 length 是字符数
  const raw = readFileSync(file);
  const body = rel === "sw.js" && swRev ? Buffer.from(raw.toString("utf8") + revMarker(swRev), "utf8") : raw;
  // 没有 COOP/COEP：这两项在真线上只能由 SW 注入，判据要测的就是注入本身
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    // 页面带 COEP 时，未被 SW 缓存的子资源需要 CORP 才允许加载
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  res.end(body);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[serve-dist] http://127.0.0.1:${PORT}${BASE}`);
});
