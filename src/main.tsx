import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { registerSW } from "virtual:pwa-register";
import { setUpdateSW } from "@/lib/sw-update";
import { APP_VERSION } from "@/config/version";

// 前端版本号（构建时从 package.json 注入）
console.log(`%c AI 小说精读助手 %c v${APP_VERSION} `, "background:#4f46e5;color:white;border-radius:3px 0 0 3px;padding:2px 6px", "background:#e0e7ff;color:#4f46e5;border-radius:0 3px 3px 0;padding:2px 6px");

const updateSW = registerSW({
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent("sw-need-refresh"));
  },
  onOfflineReady() {
    window.dispatchEvent(new CustomEvent("sw-offline-ready"));
  },
  onRegisteredSW(_swUrl, registration) {
    // COI：页面必须成为 crossOriginIsolated（COOP/COEP 头由 SW 注入），
    // SharedArrayBuffer 才可用（sherpa-onnx WASM 是 SHARED_MEMORY 构建）。
    // SW 首次安装时未控制页面、或更新后导航未被拦截时，COI 不会生效，
    // 此时 reload 一次让 SW 接管（sessionStorage 防循环）。
    try {
      if (!sessionStorage.getItem("coi-reloaded") && registration && !window.crossOriginIsolated) {
        sessionStorage.setItem("coi-reloaded", "1");
        window.location.reload();
      }
    } catch { /* ignore */ }
  },
});

// 每 30 分钟检查一次 Service Worker 更新（阅读过程中也能检测到新版本）
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.ready.then((registration) => {
    setInterval(() => registration.update(), 30 * 60 * 1000);
  });
}

setUpdateSW(updateSW);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
