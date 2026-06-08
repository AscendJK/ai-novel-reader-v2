/**
 * Shared fetch interceptor for proxying HuggingFace model requests through backend.
 * Used by both model-loader.ts and client-encoder.ts.
 */

import { getServerUrl } from "@/lib/api-client";

// Module-level reference to original fetch (before any interception)
const _originalFetch = globalThis.fetch;

/**
 * Intercept fetch to route HuggingFace model requests through backend proxy.
 * Matches URLs like: https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/...
 */
function proxiedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  const hfPattern = /https?:\/\/huggingface\.co\/([^/]+(?:\/[^/]+)?)\/resolve\/main\/.+/;
  const match = url.match(hfPattern);
  if (match) {
    const serverUrl = getServerUrl();
    if (serverUrl) {
      const pathAfterHost = url.split("huggingface.co/")[1];
      const proxyUrl = `${serverUrl}/api/rag/model-proxy/${pathAfterHost}`;
      console.log(`[fetch-proxy] 代理: ${url} → ${proxyUrl}`);
      return _originalFetch(proxyUrl, init);
    }
  }

  return _originalFetch(input, init);
}

/** Install the fetch interceptor */
export function installFetchInterceptor() {
  globalThis.fetch = proxiedFetch;
}

/** Restore the original fetch */
export function restoreFetch() {
  globalThis.fetch = _originalFetch;
}
