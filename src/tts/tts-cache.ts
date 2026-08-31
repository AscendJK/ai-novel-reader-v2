/**
 * TTS 资源 IndexedDB 缓存
 * 浏览器端持久化存储 WASM 引擎和模型文件，避免重复下载
 */

import { apiFetch } from "@/lib/api-client";
import { withQuotaRetry } from "@/lib/quota-guard";

const DB_NAME = "tts-cache";
const DB_VERSION = 1;
const STORE_NAME = "files";

// 缓存文件列表（key: 文件名, value: ArrayBuffer）
// 引擎升级到 Kokoro v1.0 后，key 加 kokoro-v2/ 前缀强制刷新浏览器旧缓存。
// v2：v1 前缀缓存可能已存入被 HTTP 强缓存污染的旧 ESM 文件，再升级一次。
// v3：int8 模型在 wasm 生成全 NaN（无声），模型换回 fp32 v1.0，必须强制刷新。
const CACHE_PREFIX = "kokoro-v3/";
// 下载 URL 的版本参数：与 CACHE_PREFIX 同步，绕开浏览器 HTTP 强缓存
//（服务器 serveFile 已改 no-cache，此为双保险）
const CACHE_URL_VERSION = 3;
const CACHE_FILES = [
  // WASM 引擎 + espeak-ng-data（TTS 需要的语音数据，精简 data 17MB）
  "sherpa-onnx-wasm-main-tts.js",
  "sherpa-onnx-wasm-main-tts.wasm",
  "sherpa-onnx-wasm-main-tts.data",
  "sherpa-onnx-tts.js",
  // Kokoro 模型文件（v1.0 fp32：int8 在 wasm 生成全 NaN 无声，故用 fp32 包）
  "model.onnx",
  "voices.bin",
  "tokens.txt",
  "lexicon-us-en.txt",
  "lexicon-zh.txt",
  // 中文规则 FST（数字/日期/音素）
  "date-zh.fst",
  "number-zh.fst",
  "phone-zh.fst",
  // jieba 中文分词 dict（Kokoro dictDir 需要）
  "dict/jieba.dict.utf8",
  "dict/hmm_model.utf8",
  "dict/idf.utf8",
  "dict/user.dict.utf8",
  "dict/stop_words.utf8",
  "dict/pos_dict/char_state_tab.utf8",
  "dict/pos_dict/prob_emit.utf8",
  "dict/pos_dict/prob_start.utf8",
  "dict/pos_dict/prob_trans.utf8",
].map((f) => CACHE_PREFIX + f);

/** 去掉缓存前缀，还原为文件名（传给 worker / 拼 API 路径用） */
export function stripCachePrefix(key: string): string {
  return key.startsWith(CACHE_PREFIX) ? key.slice(CACHE_PREFIX.length) : key;
}


// H6 fix: 缓存 IDBDatabase 实例，避免重复打开连接
let dbInstance: IDBDatabase | null = null;
// 历史缓存前缀（模型/引擎升级后旧 key 不再使用，需清理避免 IndexedDB 存储泄漏）
const LEGACY_PREFIXES = ["kokoro-v1/", "kokoro-v2/"];
// 幂等标记：每个页面会话只清理一次
let legacyCleanupStarted = false;

/** 清理旧前缀缓存（升级后残留的 ~400MB 旧文件），防止多次升级逼近浏览器配额 */
function cleanupLegacyCache(db: IDBDatabase): void {
  if (legacyCleanupStarted) return;
  legacyCleanupStarted = true;
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const keysReq = store.getAllKeys();
    keysReq.onsuccess = () => {
      const keys = keysReq.result as IDBValidKey[];
      for (const key of keys) {
        const k = String(key);
        if (LEGACY_PREFIXES.some(p => k.startsWith(p))) {
          try { store.delete(key); } catch { /* 忽略单条删除失败 */ }
        }
      }
      if (keys.length > 0) {
        const removed = keys.filter(k => LEGACY_PREFIXES.some(p => String(k).startsWith(p))).length;
        if (removed > 0) console.log(`[TTS] 已清理 ${removed} 个旧版本缓存文件（存储释放）`);
      }
    };
    // 事务错误静默（清理失败不影响主流程）
    tx.onerror = () => { /* 忽略 */ };
  } catch { /* IndexedDB 不可用时忽略 */ }
}

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) {
    cleanupLegacyCache(dbInstance);
    return Promise.resolve(dbInstance);
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      dbInstance = request.result;
      // 监听版本升级事件，清理旧连接
      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
      };
      cleanupLegacyCache(dbInstance);
      resolve(dbInstance);
    };
    request.onerror = () => reject(request.error);
  });
}

async function dbGet(key: string): Promise<ArrayBuffer | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(key: string, value: ArrayBuffer): Promise<void> {
  const db = await openDB();
  // 配额不足时自动降级清理（RAG 淘汰 → TTS 孤儿 → 非激活嵌入模型）并重试
  await withQuotaRetry(() => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
}

async function dbHas(key: string): Promise<boolean> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    // 用 get 而非 count：校验数据非空（0 字节的损坏缓存不应算作已就绪）
    const req = store.get(key);
    req.onsuccess = () => {
      const data = req.result as ArrayBuffer | undefined;
      resolve(!!data && data.byteLength > 0);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * 检查所有必需文件是否已缓存
 */
export async function isCacheReady(): Promise<boolean> {
  for (const file of CACHE_FILES) {
    if (!(await dbHas(file))) return false;
  }
  return true;
}

/**
 * 从 IndexedDB 读取缓存的文件
 * @returns 文件名 → ArrayBuffer 的映射
 */
export async function getCachedFiles(): Promise<Map<string, ArrayBuffer>> {
  const result = new Map<string, ArrayBuffer>();
  for (const file of CACHE_FILES) {
    const data = await dbGet(file);
    if (data) result.set(file, data);
  }
  return result;
}

/**
 * 下载并发锁：loadModel（手动使用）与 preloadZipVoice（登录后预加载）
 * 可能同时触发下载，共享同一 Promise 避免重复拉取 380MB / IndexedDB 并发写。
 */
let downloadPromise: Promise<Map<string, ArrayBuffer>> | null = null;

/**
 * 从服务器代理下载文件并存入 IndexedDB
 * @param onProgress - 进度回调 (文件名, 已下载字节, 总字节)
 */
export function downloadAndCache(
  onProgress?: (filename: string, loaded: number, total: number) => void
): Promise<Map<string, ArrayBuffer>> {
  // 并发保护：同一时刻只执行一次真实下载，后续调用共享同一 Promise
  if (downloadPromise) return downloadPromise;

  downloadPromise = (async (): Promise<Map<string, ArrayBuffer>> => {
    const result = new Map<string, ArrayBuffer>();

    for (const file of CACHE_FILES) {
      // 检查是否已缓存
      const cached = await dbGet(file);
    if (cached) {
      result.set(file, cached);
      onProgress?.(file, cached.byteLength, cached.byteLength);
      continue;
    }

    // 下载（使用 apiFetch 带上认证头）
    onProgress?.(file, 0, 0);
    const name = stripCachePrefix(file);
    let apiPath: string;
    if (name.startsWith("sherpa-onnx-wasm-main-tts.") || name === "sherpa-onnx-tts.js") {
      apiPath = `/api/rag/tts/wasm/${name}`;
    } else if (name.startsWith("dict/")) {
      // dict 子目录：走专用路由（/tts/model/dict/...）
      apiPath = `/api/rag/tts/model/${name}`;
    } else {
      apiPath = `/api/rag/tts/model/${name}`;
    }
    // 版本参数：URL 变化绕开浏览器 HTTP 强缓存（引擎/模型升级时同步递增 CACHE_URL_VERSION）
    apiPath += `?v=${CACHE_URL_VERSION}`;
    const response = await apiFetch(apiPath);
    if (!response.ok) throw new Error(`下载 ${file} 失败: HTTP ${response.status}`);

    // M12 fix: 防御 body 为 null 的情况
    if (!response.body) {
      throw new Error(`下载 ${file} 失败: 响应 body 为空`);
    }

    const contentLength = parseInt(response.headers.get("content-length") || "0");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.(file, received, contentLength);
    }

    // 合并为 ArrayBuffer
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const buffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    const arrayBuffer = buffer.buffer;

    // 存入 IndexedDB
    try {
      await dbPut(file, arrayBuffer);
    } catch (e) {
      // M12 fix: 私有浏览模式下 QuotaExceededError 降级处理
      console.warn(`[TTS] 缓存 ${file} 失败（可能处于私有浏览模式）:`, e);
    }
    result.set(file, arrayBuffer);
  }

  // 下载/校验完成后广播，让其他已打开的标签页同步刷新缓存状态
  broadcastTTSCacheReady();

  return result;
  })().finally(() => {
    // 下载完成（成功或失败）后释放锁，允许下次重新触发
    downloadPromise = null;
  });

  return downloadPromise;
}

/**
 * 广播 TTS 缓存状态变化（跨标签页同步）
 * 其他标签页收到后重新执行 isCacheReady()，刷新"已就绪/需下载"显示
 */
export function broadcastTTSCacheReady(): void {
  try {
    const bc = new BroadcastChannel("novel-reader-tts-sync");
    bc.postMessage("tts-cache-ready");
    bc.close();
  } catch { /* 不支持 BroadcastChannel 时忽略（单标签页场景无影响） */ }
}

/**
 * 清除缓存
 */
export async function clearCache(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * 计算 TTS 缓存总大小（字节）
 * 游标流式累加 ArrayBuffer 的 byteLength，避免一次性加载全部文件
 */
export async function computeTTSCacheSize(): Promise<number> {
  const db = await openDB();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.openCursor();
      let total = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const val = cursor.value as ArrayBuffer | undefined;
          if (val && typeof val.byteLength === "number") total += val.byteLength;
          cursor.continue();
        } else {
          resolve(total);
        }
      };
      req.onerror = () => resolve(0);
    } catch { resolve(0); }
  });
}

/**
 * 清理孤儿文件（下载中断残留 / 已废弃版本前缀）
 * 保留当前必需清单（CACHE_FILES）内的文件，其余一律删除
 * @returns 删除的文件数
 */
export async function cleanupOrphanFiles(): Promise<number> {
  const db = await openDB();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const keysReq = store.getAllKeys();
      keysReq.onsuccess = () => {
        const keys = keysReq.result as IDBValidKey[];
        let removed = 0;
        for (const key of keys) {
          const k = String(key);
          // 不在当前必需清单内的一律视为孤儿（含 kokoro-v1/v2 旧前缀、下载一半的残缺文件）
          if (!CACHE_FILES.includes(k)) {
            try { store.delete(key); removed++; } catch { /* 忽略单条删除失败 */ }
          }
        }
        resolve(removed);
      };
      keysReq.onerror = () => resolve(0);
    } catch { resolve(0); }
  });
}
