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

// COI 注入是浏览器推理（SharedArrayBuffer）的硬前提：静默跳过会让构建"成功"
// 却产出一个拿不到 crossOriginIsolated 的站点，故障要到 TTS 起模型时才暴露
if (!fs.existsSync(swPath)) {
  console.error("[coi] 构建失败：dist/sw.js 不存在（PWA 未生成 SW），COI 头无处注入");
  process.exit(1);
}
if (!fs.existsSync(coiPath)) {
  console.error("[coi] 构建失败：scripts/coi-sw.js 缺失，无法注入 COOP/COEP 处理");
  process.exit(1);
}

const sw = fs.readFileSync(swPath, "utf8");
if (sw.includes("Cross-Origin-Embedder-Policy")) {
  console.log("[coi] sw.js 已包含 COI 处理，跳过");
  process.exit(0);
}

const coi = fs.readFileSync(coiPath, "utf8").trim();
fs.writeFileSync(swPath, sw + "\n\n" + coi + "\n");
console.log("[coi] 已注入 COOP/COEP 处理到 sw.js");
