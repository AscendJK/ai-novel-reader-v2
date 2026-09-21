import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { registerSW } from "virtual:pwa-register";
import { setUpdateSW, COI_RELOAD_KEY, MAX_COI_RELOADS } from "@/lib/sw-update";
import { installConsoleCapture } from "@/lib/logger";
import { APP_VERSION } from "@/config/version";

// 手机/局域网用户打不开 devtools：把既有 console 输出接进应用内 DebugPanel
const uninstallConsoleCapture = installConsoleCapture();
if (import.meta.hot) import.meta.hot.dispose(() => uninstallConsoleCapture());

// 前端版本号（构建时从 package.json 注入）
console.log(`%c AI 小说精读助手 %c v${APP_VERSION} `, "background:#4f46e5;color:white;border-radius:3px 0 0 3px;padding:2px 6px", "background:#e0e7ff;color:#4f46e5;border-radius:0 3px 3px 0;padding:2px 6px");

/**
 * 确保页面成为 crossOriginIsolated（COOP/COEP 头由 SW 注入），
 * SharedArrayBuffer 才可用（sherpa-onnx WASM 是 SHARED_MEMORY 构建）。
 *
 * COI 只在「SW 控制页面后的导航」生效：SW 首次安装/更新后，当前页面
 * 的导航发生在 SW 接管之前，COI 头不会加上。所以这一只挂在
 * `navigator.serviceWorker.ready` 之后调用（见文件下面）——接管之后再刷一次
 * 就到位，实测把 sw.js 拖慢 6 秒也只刷 1 次。计数上限只兜另一种形状：
 * 已经接管却还拿不到隔离（浏览器不认 COEP credentialless 之类），
 * 那种刷多少次都没用，刷到上限就停，别把页面变成反复闪。
 */
function ensureCrossOriginIsolated(): void {
  try {
    if (window.crossOriginIsolated) return;
    const count = parseInt(sessionStorage.getItem(COI_RELOAD_KEY) || "0", 10);
    if (count >= MAX_COI_RELOADS) return;
    sessionStorage.setItem(COI_RELOAD_KEY, String(count + 1));
    setTimeout(() => window.location.reload(), 1200);
  } catch { /* ignore */ }
}

const updateSW = registerSW({
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent("sw-need-refresh"));
  },
  onOfflineReady() {
    window.dispatchEvent(new CustomEvent("sw-offline-ready"));
  },
});

// 每 30 分钟检查一次 Service Worker 更新（阅读过程中也能检测到新版本）
// SW ready 后同时执行 COI 检查（原 onRegisteredSW 回调：该回调不在 registerSW
// 类型定义中，改为在 SW 激活接管后手动调用 ensureCrossOriginIsolated）
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.ready.then((registration) => {
    ensureCrossOriginIsolated();
    setInterval(() => registration.update(), 30 * 60 * 1000);
  });
}

setUpdateSW(updateSW);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
