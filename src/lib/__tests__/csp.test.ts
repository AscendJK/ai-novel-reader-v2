/**
 * 页面 CSP 里 `script-src` 那一串的形状（2026-09-29 起）。
 *
 * 为什么这一格必须有判据：`'unsafe-eval'` 同时是 **WebAssembly 的通行证**——真浏览器实测过，
 * 把它直接删掉（不补 `'wasm-unsafe-eval'`）之后 `WebAssembly.compile` 在主线程和 Worker 里
 * 双双抛 CompileError，那会一起打断 RAG 的 onnxruntime 与浏览器端 TTS 的 sherpa-onnx。
 * 所以正确写法是"换成 `'wasm-unsafe-eval'`"，而这句话两头都得钉住：
 * 不许退回 `'unsafe-eval'`（收紧白做），也不许把 `'wasm-unsafe-eval'` 摘掉（功能被打断）。
 *
 * 为什么放 `src/` 下面：vitest 的 include 只收 `src` 里的 `*.test.ts`（见 `vite.config.ts` 的 test 段），
 * 这是唯一能被 `npm test` 跑到的位置；被测对象是仓库根的 `index.html`，走 `node:fs` 读磁盘。
 *
 * 刀账（每刀改 `index.html` 那一行，改完立刻还原并核 sha256）：
 * - C1 把 `'unsafe-eval'` 加回去 → CS1 红（CS2 同时红，因为 token 数变了？不：CS2 只查 wasm 那一枚，仍绿）。
 * - C2 把 `'wasm-unsafe-eval'` 摘掉 → CS2 红。
 * - C3 把 `'wasm-unsafe-eval'` 写成 `wasm-unsafe-eval`（漏引号，浏览器不认）→ CS2 红。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** 从 index.html 里取出 meta CSP，按指令名摊成 token 表。 */
function cspDirectives(): Map<string, string[]> {
  const html = readFileSync("index.html", "utf8");
  const metas = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/g)];
  expect(metas, `index.html 里该恰好有一张 CSP meta，实际 ${metas.length} 张`).toHaveLength(1);
  const map = new Map<string, string[]>();
  for (const part of metas[0][1].split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length) map.set(tokens[0], tokens.slice(1));
  }
  return map;
}

describe("页面 CSP：script-src 只给 WASM 通行证，不给 eval", () => {
  it("CS1 不许出现 'unsafe-eval'（整枚 token 比，'wasm-unsafe-eval' 不算命中）", () => {
    const scriptSrc = cspDirectives().get("script-src") ?? [];
    expect(
      scriptSrc.filter((t) => t === "'unsafe-eval'"),
      `script-src 里又出现了 'unsafe-eval'：${scriptSrc.join(" ")}`,
    ).toEqual([]);
  });

  it("CS2 必须保留 'wasm-unsafe-eval'（摘掉会连 WebAssembly 编译一起打死）", () => {
    const scriptSrc = cspDirectives().get("script-src") ?? [];
    expect(scriptSrc, `script-src 实际是：${scriptSrc.join(" ")}`).toContain("'wasm-unsafe-eval'");
  });
});
