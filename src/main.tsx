import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { registerSW } from "virtual:pwa-register";
import { setUpdateSW } from "@/components/common/UpdateBanner";

// 前端开发版本号（每次发布时手动更新）
const DEV_VERSION = "2025.06.20.7";
console.log(`%c AI 小说精读助手 %c v${DEV_VERSION} `, "background:#4f46e5;color:white;border-radius:3px 0 0 3px;padding:2px 6px", "background:#e0e7ff;color:#4f46e5;border-radius:0 3px 3px 0;padding:2px 6px");

const updateSW = registerSW({
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent("sw-need-refresh"));
  },
  onOfflineReady() {
    window.dispatchEvent(new CustomEvent("sw-offline-ready"));
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
