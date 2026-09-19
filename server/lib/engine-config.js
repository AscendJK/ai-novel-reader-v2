/**
 * Shared engine configuration for server-side code.
 * Maps engine IDs to Transformers.js model keys.
 */

export const ENGINE_MODEL_MAP = {
  "Xenova/bge-small-zh-v1.5": "Xenova/bge-small-zh-v1.5",
  "Xenova/gte-small": "Xenova/gte-small",
  "Xenova/multilingual-e5-small": "Xenova/multilingual-e5-small",
  "Xenova/all-MiniLM-L6-v2": "Xenova/all-MiniLM-L6-v2",
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2": "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
};

export const DEFAULT_ENGINE = "Xenova/bge-small-zh-v1.5";

/** Set of valid engine IDs for whitelist validation */
export const VALID_ENGINES = new Set(Object.keys(ENGINE_MODEL_MAP));

/**
 * Resolve engine ID to Transformers.js model key.
 * Only accepts engines in the whitelist; unknown engines fall back to default.
 *
 * 必须走 Set 而不是 `ENGINE_MODEL_MAP[engine]`：对象取值会顺着原型链找到
 * `constructor`/`toString` 这些真值，于是 modelKey 变成一个函数而不是字符串
 * （round 3 R-81，写用例时撞出来的）。
 * @param {string} engine - Engine ID (e.g. "Xenova/bge-small-zh-v1.5")
 * @returns {string} Model key for Transformers.js
 */
export function resolveModelKey(engine) {
  if (typeof engine === "string" && VALID_ENGINES.has(engine)) return ENGINE_MODEL_MAP[engine];
  return DEFAULT_ENGINE;
}

/** 白名单判定：路由层必须在入口就拒绝未知引擎 */
export function isAllowedEngine(engine) {
  return typeof engine === "string" && VALID_ENGINES.has(engine);
}

/** 给 400 响应用的可读白名单 */
export function allowedEngineList() {
  return [...VALID_ENGINES];
}
