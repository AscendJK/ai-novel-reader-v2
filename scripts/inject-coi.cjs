#!/usr/bin/env node
/**
 * 构建后注入 COI（Cross-Origin-Isolated）处理到 workbox 生成的 sw.js。
 * GitHub Pages 无法设置自定义响应头，只能由 Service Worker 添加
 * COOP/COEP 头，页面因此获得 crossOriginIsolated（SharedArrayBuffer 可用，
 * sherpa-onnx WASM 是 SHARED_MEMORY 构建，必须有 SAB 才能初始化）。
 *
 * 与 PWA 的 sw.js 合并为同一个 SW，避免同 scope 双 SW 冲突。
 * 幂等：已注入则跳过。
 */
const fs = require("fs");
const path = require("path");

const swPath = path.join(__dirname, "..", "dist", "sw.js");
const coiPath = path.join(__dirname, "coi-sw.js");

if (!fs.existsSync(swPath)) {
  console.warn("[coi] dist/sw.js 不存在，跳过注入");
  process.exit(0);
}
if (!fs.existsSync(coiPath)) {
  console.warn("[coi] scripts/coi-sw.js 不存在，跳过注入");
  process.exit(0);
}

const sw = fs.readFileSync(swPath, "utf8");
if (sw.includes("Cross-Origin-Embedder-Policy")) {
  console.log("[coi] sw.js 已包含 COI 处理，跳过");
  process.exit(0);
}

const coi = fs.readFileSync(coiPath, "utf8").trim();
fs.writeFileSync(swPath, sw + "\n\n" + coi + "\n");
console.log("[coi] 已注入 COOP/COEP 处理到 sw.js");
