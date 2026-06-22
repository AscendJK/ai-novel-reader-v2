/**
 * TTS 资源 IndexedDB 缓存
 * 浏览器端持久化存储 WASM 引擎和模型文件，避免重复下载
 */

import { apiFetch } from "@/lib/api-client";

const DB_NAME = "tts-cache";
const DB_VERSION = 1;
const STORE_NAME = "files";

// 缓存文件列表（key: 文件名, value: ArrayBuffer）
const CACHE_FILES = [
  // WASM 引擎
  "sherpa-onnx-wasm-main-tts.js",
  "sherpa-onnx-wasm-main-tts.wasm",
  "sherpa-onnx-wasm-main-tts.data",
  "sherpa-onnx-tts.js",
  // 模型文件
  "decoder.int8.onnx",
  "encoder.int8.onnx",
  "tokens.txt",
  "lexicon.txt",
  // Vocoder 模型
  "vocos-22khz-univ.onnx",
  // 参考音频（ZipVoice 声音克隆需要）
  "test_wavs/news-female.wav",
  "test_wavs/news-female-2.wav",
  "test_wavs/leijun-1.wav",
];


// H6 fix: 缓存 IDBDatabase 实例，避免重复打开连接
let dbInstance: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
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
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbHas(key: string): Promise<boolean> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.count(key);
    req.onsuccess = () => resolve(req.result > 0);
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
 * 从服务器代理下载文件并存入 IndexedDB
 * @param onProgress - 进度回调 (文件名, 已下载字节, 总字节)
 */
export async function downloadAndCache(
  onProgress?: (filename: string, loaded: number, total: number) => void
): Promise<Map<string, ArrayBuffer>> {
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
    let apiPath: string;
    if (file.startsWith("sherpa-onnx-wasm-main-tts.") || file === "sherpa-onnx-tts.js") {
      apiPath = `/api/rag/tts/wasm/${file}`;
    } else if (file.startsWith("vocos-")) {
      apiPath = `/api/rag/tts/model/vocoder/${file}`;
    } else if (file.startsWith("test_wavs/")) {
      apiPath = `/api/rag/tts/model/${file}`;
    } else {
      apiPath = `/api/rag/tts/model/${file}`;
    }
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

  return result;
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
