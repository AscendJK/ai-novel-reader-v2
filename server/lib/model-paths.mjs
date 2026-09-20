/**
 * 模型文件请求的白名单与缓存路径解析（从 server/routes/rag.js 抽出）
 *
 * /model-proxy 是一台局域网里"能替客户端去取文件"的开放代理，唯一的防线是
 * "命名空间白名单 + resolve 之后仍在缓存目录内"。白名单正则放行 `resolve/main/`
 * 后面的任何字符，所以 `../../data/key.pem` 这类穿越只能靠 resolve 后的比较拦住——
 * 这道比较一旦被改窄，症状是"什么都没发生"，所以它必须有用例。
 */
import path from "node:path";

// 只放行这两个命名空间，防止后端被当成正代理用
const VALID_MODEL_PATH = /^(Xenova|onnx-community)\/[^/]+\/resolve\/main\/.+/;

export function isAllowedModelPath(subPath) {
  return !!subPath && VALID_MODEL_PATH.test(subPath);
}

// "Xenova/bge-small-zh-v1.5/resolve/main/config.json" → ".../bge-small-zh-v1.5/config.json"
// （Transformers.js 的缓存目录结构里没有 resolve/main 这一段）
export function toCachePath(subPath) {
  return subPath.replace(/\/resolve\/main\//, "/");
}

/**
 * 把请求路径解析到缓存目录内；越界返回 null。
 *
 * `pathImpl` 可注入（path / path.win32 / path.posix），这样同一份判据在两种分隔符下
 * 都被同一条用例钉住，而不是只在跑测试的那个平台上有效。
 */
export function resolveModelCachePath({ modelDir, subPath, pathImpl = path }) {
  const cachePath = pathImpl.join(modelDir, toCachePath(subPath));
  const resolvedCache = pathImpl.resolve(cachePath);
  const resolvedDir = pathImpl.resolve(modelDir);
  if (resolvedCache === resolvedDir) return resolvedCache;
  if (!resolvedCache.startsWith(resolvedDir + pathImpl.sep)) return null;
  return resolvedCache;
}
