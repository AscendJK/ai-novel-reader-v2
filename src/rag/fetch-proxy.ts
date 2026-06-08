/**
 * Shared fetch interceptor for proxying HuggingFace model requests through backend.
 * Uses reference counting to safely handle concurrent installs from multiple callers.
 */

import { getServerUrl } from "@/lib/api-client";

// Module-level reference to original fetch (before any interception)
const _originalFetch = globalThis.fetch;

// Reference count for how many callers have installed the interceptor
let interceptorRefCount = 0;

/**
 * Intercept fetch to route HuggingFace model requests through backend proxy.
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

/** Install the fetch interceptor (reference-counted) */
export function installFetchInterceptor() {
  interceptorRefCount++;
  globalThis.fetch = proxiedFetch;
}

/** Restore the original fetch (only when no callers remain) */
export function restoreFetch() {
  interceptorRefCount = Math.max(0, interceptorRefCount - 1);
  if (interceptorRefCount === 0) {
    globalThis.fetch = _originalFetch;
  }
}
