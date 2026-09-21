/*!
 * COI (Cross-Origin-Isolated) 注入代码 — 由 scripts/inject-coi.cjs 在 build 后合并进 workbox sw.js。
 * 为 GitHub Pages 页面添加 COOP/COEP 响应头，启用 SharedArrayBuffer
 * （sherpa-onnx WASM 是 SHARED_MEMORY 构建，必须有 SAB 才能初始化）。
 * 默认 credentialless 模式（对跨源子资源更宽松，兼容性最好）。
 * 只处理导航请求；非导航请求交给 workbox，避免破坏资源加载。
 */
(() => {
  let coepCredentialless = true;
  // 不在 install 里 skipWaiting()。
  // 首装那一次没有旧 SW 挡着，installed 之后自己就 activate 了，加不加都一样；
  // 而有旧 SW 的时候抢先 activate 会把「等待中」这一状态整个吃掉——
  // `registerType: "prompt"` 的更新横幅等的就是 `registration.waiting`，
  // 实测：update() 之后 waiting 始终为空、`sw-need-refresh` 一次都不发，
  // 于是 UpdateBanner 是死的，用户永远停在旧版而不自知（新 hashed 资源已经换人，
  // 典型症状是"改版之后偶发 chunk 加载失败"）。改成用户点「更新」才换。
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("message", (ev) => {
    if (!ev.data) return;
    if (ev.data.type === "coepCredentialless") coepCredentialless = !!ev.data.value;
  });

  /**
   * 从 workbox 的 precache 里取一份响应：先按路径找导航请求要的那一条（直接访问
   * `/index.html` 时就是它），找不到就退回应用外壳 `index.html`（导航通常是 `/`）。
   *
   * 为什么不能用 `caches.match("index.html")`（旧实现）：workbox 给带 revision 的条目
   * 把缓存键写成了 `…/index.html?__WB_REVISION__=<hash>`（实测：20 条键里 7 条带这个
   * 参数，外壳 index.html 正是其一；文件名自带 hash 的那 13 条 assets 不带），
   * 而 Cache 的匹配比的是**完整 URL**（含 query）——那条 fallback 对外壳永远 MISS，
   * 离线首屏直接 ERR_FAILED，也就是"能装 PWA、却断网打不开"。
   * 键本身就在 cache 里，拿命中那条键去 match 才取得回来，所以这里遍历 keys()。
   */
  async function fromPrecache(pathname) {
    for (const name of await caches.keys()) {
      if (!name.startsWith("workbox-precache")) continue;
      const cache = await caches.open(name);
      const keys = await cache.keys();
      const hit =
        keys.find((req) => new URL(req.url).pathname === pathname) ||
        keys.find((req) => /\/index\.html$/.test(new URL(req.url).pathname));
      if (!hit) continue;
      const response = await cache.match(hit);
      if (response) return response;
    }
    return null;
  }

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
          // 所以导航请求全归本代码处理。缓存副本不带 COI 头，取回来必须重包一层。
          const cached = await fromPrecache(new URL(event.request.url).pathname);
          if (cached) return withCoi(cached);
          throw new Error("导航请求失败且无可用离线缓存");
        })
    );
  });
})();
