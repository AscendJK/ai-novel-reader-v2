import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { registerSW } from "virtual:pwa-register";
import { setUpdateSW } from "@/components/common/UpdateBanner";

const updateSW = registerSW({
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent("sw-need-refresh"));
  },
  onOfflineReady() {
    window.dispatchEvent(new CustomEvent("sw-offline-ready"));
  },
  onRegistered(registration) {
    // 每 30 分钟检查一次更新（阅读过程中也能检测到新版本）
    if (registration) {
      setInterval(() => registration.update(), 30 * 60 * 1000);
    }
  },
});

setUpdateSW(updateSW);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
