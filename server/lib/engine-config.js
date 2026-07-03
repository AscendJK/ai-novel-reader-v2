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
 * @param {string} engine - Engine ID (e.g. "Xenova/bge-small-zh-v1.5")
 * @returns {string} Model key for Transformers.js
 */
export function resolveModelKey(engine) {
  if (ENGINE_MODEL_MAP[engine]) return ENGINE_MODEL_MAP[engine];
  return DEFAULT_ENGINE;
}
