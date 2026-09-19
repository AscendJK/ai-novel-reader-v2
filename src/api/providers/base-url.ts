/**
 * Provider baseUrl 归一（round 2 R-39）
 *
 * 用户在设置里粘贴自定义端点时最常见两种形态：带尾斜杠、以及直接把完整端点
 * URL 粘进来。拼接前不归一就会产出 `...//chat/completions` 或
 * `.../chat/completions/chat/completions`，表现为"配了地址却永远 404"。
 */

/** 去掉尾斜杠，并在末尾已经是该端点时把它剥掉（只剥一次） */
export function normalizeBaseUrl(raw: string | undefined, endpoint: string): string {
  let base = (raw || "").trim().replace(/\/+$/, "");
  const endpointNoSlash = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  if (base.toLowerCase().endsWith(endpointNoSlash.toLowerCase())) {
    base = base.slice(0, -endpointNoSlash.length).replace(/\/+$/, "");
  }
  return base;
}
