/*!
 * COI (Cross-Origin-Isolated) 注入代码 — 由 vite.config closeBundle 合并进 workbox sw.js。
 * 为 GitHub Pages 页面添加 COOP/COEP 响应头，启用 SharedArrayBuffer
 * （sherpa-onnx WASM 是 SHARED_MEMORY 构建，必须有 SAB 才能初始化）。
 * 默认 credentialless 模式（对 blob:/data: 子资源更宽松，兼容性最好）。
 */
(() => {
  let coepCredentialless = true;
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("message", (ev) => {
    if (!ev.data) return;
    if (ev.data.type === "coepCredentialless") coepCredentialless = !!ev.data.value;
  });

  self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (url.pathname.includes("/coi-serviceworker.js")) return;

    if (event.request.mode === "navigate") {
      // 给页面响应添加 COOP + COEP 头，使页面成为 crossOriginIsolated
      event.respondWith(
        fetch(event.request).then((response) => {
          const newHeaders = new Headers(response.headers);
          newHeaders.set(
            "Cross-Origin-Embedder-Policy",
            coepCredentialless ? "credentialless" : "require-corp"
          );
          newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
      );
    } else if (coepCredentialless) {
      // credentialless 模式下给跨源子资源请求补 CORP 头
      const newHeaders = new Headers(event.request.headers);
      newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
      event.respondWith(fetch(event.request, { headers: newHeaders }));
    }
  });
})();
