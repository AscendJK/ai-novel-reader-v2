/*!
 * COI (Cross-Origin-Isolated) 注入代码 — 由 scripts/inject-coi.cjs 在 build 后合并进 workbox sw.js。
 * 为 GitHub Pages 页面添加 COOP/COEP 响应头，启用 SharedArrayBuffer
 * （sherpa-onnx WASM 是 SHARED_MEMORY 构建，必须有 SAB 才能初始化）。
 * 默认 credentialless 模式（对跨源子资源更宽松，兼容性最好）。
 * 只处理导航请求；非导航请求交给 workbox，避免破坏资源加载。
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
    // 只处理导航请求：为其添加 COOP/COEP 响应头使页面 crossOriginIsolated。
    // 注意：不要给非导航请求补 CORP 请求头——CORP 是响应头，加到请求头会
    // 导致跨源 no-cors 资源（图片/字体/WASM 等）直接 TypeError、跨源 CORS
    // 请求触发 preflight 失败（GitHub Pages/后端不响应 OPTIONS）。
    // 非导航请求交给 workbox precacheAndRoute（匹配缓存，否则走网络）。
    if (event.request.mode !== "navigate") return;

    const withCoi = (response) => {
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
    };

    event.respondWith(
      fetch(event.request)
        .then(withCoi)
        .catch(async () => {
          // 离线冷启动兜底：navigateFallback 被显式禁用（否则 NavigationRoute 会抢在
          // 这里之前返回不带 COOP/COEP 的缓存响应，页面永远无法 crossOriginIsolated），
          // 所以导航请求全归本代码处理——旧实现在这里"重发同一条网络请求"，
          // 等于离线首屏必然失败。改为回退到 workbox precache 里的 index.html，
          // 并且必须重新补 COI 头（缓存副本里没有）。
          const cached =
            (await caches.match(event.request)) ||
            (await caches.match("index.html")) ||
            (await caches.match("./index.html"));
          if (cached) return withCoi(cached);
          throw new Error("导航请求失败且无可用离线缓存");
        })
    );
  });
})();
