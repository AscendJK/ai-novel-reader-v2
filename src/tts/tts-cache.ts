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

// ── 缓存清单（R-45：识别截断/半截写入）──────────────────────
// 每个文件下载并成功写库后记一条 {size, sha}。没有清单时"缓存存在"就等于
// "缓存可用"，而一次被 HTTP 强缓存污染的响应、或写坏的文件，会永远通过就绪
// 判定——之后每次朗读都卡 3~5 秒再报"模型缓存缺失"。
const MANIFEST_KEY = CACHE_PREFIX + "__manifest__";

interface CacheEntry { size: number; sha: string | null }
type CacheManifest = Record<string, CacheEntry>;

/**
 * 只有小文件（≤8MB：JS 壳、词典、FST、tokens）在就绪检查时校 SHA-256。
 * model.onnx 310MB 哈希一次要 1~2 秒，每次朗读前重算不值——它只校尺寸，
 * 真正常见的损坏形态（截断、错误页替换）尺寸必然变化。
 */
const SHA_VERIFY_MAX_BYTES = 8 * 1024 * 1024;

/** 缓存缺失或校验不过：keys 为需要重新下载的缓存键（坏记录已就地删除） */
export class TTSCacheIntegrityError extends Error {
  readonly keys: string[];
  constructor(message: string, keys: string[]) {
    super(message);
    this.name = "TTSCacheIntegrityError";
    this.keys = keys;
  }
}

/** SHA-256；大文件与非安全上下文（http://局域网 IP 无 crypto.subtle）返回 null=不校 */
async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  if (buf.byteLength > SHA_VERIFY_MAX_BYTES) return null;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const digest = await subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
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

async function dbGet(key: string): Promise<unknown> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(key: string, value: unknown): Promise<void> {
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

async function dbDelete(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** 坏记录就地删除；删除失败不阻断（下一次读仍会判为不合格） */
async function dropBadEntry(key: string): Promise<void> {
  try { await dbDelete(key); } catch { /* 忽略：读侧每次都会重新判定 */ }
}

async function readManifest(): Promise<CacheManifest | null> {
  const raw = await dbGet(MANIFEST_KEY);
  return raw && typeof raw === "object" ? raw as CacheManifest : null;
}

/** 记下（或补记）一个文件的清单并落盘，返回更新后的清单 */
async function rememberFile(key: string, data: ArrayBuffer, manifest: CacheManifest): Promise<CacheManifest> {
  const next: CacheManifest = { ...manifest, [key]: { size: data.byteLength, sha: await sha256Hex(data) } };
  await dbPut(MANIFEST_KEY, next);
  return next;
}

/**
 * 把 IDB 读出的值认成 ArrayBuffer。
 * 刻意不用 `instanceof ArrayBuffer`：跨 realm（jsdom/Node 混用、部分 WebView）
 * IDB 回读的 ArrayBuffer 不是同一个构造器，instanceof 会把好数据判成坏数据。
 */
function asArrayBuffer(raw: unknown): ArrayBuffer | null {
  if (raw === null || raw === undefined) return null;
  const candidate = raw as { byteLength?: unknown; slice?: unknown };
  if (typeof candidate.byteLength !== "number" || typeof candidate.slice !== "function") return null;
  return raw as ArrayBuffer;
}

/**
 * 读单个缓存文件并按清单校验。
 * 不合格（缺失/0 字节/尺寸与清单不符/小文件哈希不符）→ 删除坏记录后返回 null，
 * 让上层按"缺失"处理（downloadAndCache 会定点重下这几条）。
 */
async function readVerifiedFile(key: string, entry: CacheEntry | undefined): Promise<ArrayBuffer | null> {
  const raw = await dbGet(key);
  const data = asArrayBuffer(raw);
  if (!data) {
    if (raw !== undefined) await dropBadEntry(key);   // 0 字节或根本不是二进制（错误页/HTML）
    return null;
  }
  if (entry && data.byteLength !== entry.size) {
    console.warn(`[TTS] 缓存 ${stripCachePrefix(key)} 尺寸不符（${data.byteLength} ≠ 清单 ${entry.size}），按损坏重下`);
    await dropBadEntry(key);
    return null;
  }
  if (entry?.sha) {
    const actual = await sha256Hex(data);
    if (actual && actual !== entry.sha) {
      console.warn(`[TTS] 缓存 ${stripCachePrefix(key)} 校验和不符，按损坏重下`);
      await dropBadEntry(key);
      return null;
    }
  }
  return data;
}

/**
 * 检查所有必需文件是否已缓存（清单驱动，不再为"判存在"把 310MB 读进内存）。
 * 无清单 = 旧版本缓存或从未完整下载：判未就绪，由 downloadAndCache 走一轮
 * "已存在的只补清单、缺失的才下载"。
 */
export async function isCacheReady(): Promise<boolean> {
  const manifest = await readManifest();
  if (!manifest) return false;
  for (const key of CACHE_FILES) {
    const entry = manifest[key];
    if (!entry || entry.size <= 0) return false;
    if (entry.sha) {
      const data = await readVerifiedFile(key, entry);
      if (!data) return false;
    }
  }
  return true;
}

/**
 * 读出整套模型文件，直接组装成 worker init 消息的 files + transfer 列表。
 * 逐文件读并立刻挂到待传对象上：主线程不再有"整包 380MB Map + 第二份 slice 拷贝"
 * 的峰值（旧路径 initWorker 会 slice 全量二次拷贝，实测峰值约 690MB）。
 * @throws TTSCacheIntegrityError 任一文件缺失或校验不过（坏记录已删除，重下即可补齐）
 */
export async function takeFilesForTransfer(): Promise<{ files: Record<string, ArrayBuffer>; transferables: ArrayBuffer[] }> {
  const manifest = await readManifest();
  const files: Record<string, ArrayBuffer> = {};
  const transferables: ArrayBuffer[] = [];
  const missing: string[] = [];
  for (const key of CACHE_FILES) {
    const data = await readVerifiedFile(key, manifest?.[key]);
    if (!data) { missing.push(key); continue; }
    files[stripCachePrefix(key)] = data;
    transferables.push(data);
  }
  if (missing.length > 0 || !manifest) {
    const keys = missing.length > 0 ? missing : CACHE_FILES.slice();
    throw new TTSCacheIntegrityError(
      `模型缓存缺失或损坏（${keys.map(stripCachePrefix).join("、")}）`,
      keys,
    );
  }
  return { files, transferables };
}

/**
 * 下载并发锁：loadModel（手动使用）与 preloadZipVoice（登录后预加载）
 * 可能同时触发下载，共享同一 Promise 避免重复拉取 380MB / IndexedDB 并发写。
 */
let downloadPromise: Promise<void> | null = null;

/**
 * 从服务器代理下载文件并存入 IndexedDB（内存优化版）
 * 逐文件"下载即入库、入库即释放"，合并时逐块释放 chunks 引用，
 * 主线程不持有全量文件副本（iOS 内存优化）。
 *
 * 完整性（R-45）：命中缓存必须过清单校验（尺寸 + 小文件 SHA），
 * 长度必须等于 content-length，写库失败即整体失败——不再"warn 一下继续"
 * 并把残缺缓存宣告为就绪。
 */
export function downloadAndCache(
  onProgress?: (filename: string, loaded: number, total: number) => void
): Promise<void> {
  // 并发保护：同一时刻只执行一次真实下载，后续调用共享同一 Promise
  if (downloadPromise) return downloadPromise;

  downloadPromise = (async (): Promise<void> => {
    let cachedCount = 0;
    let downloadedCount = 0;
    let manifest = (await readManifest()) ?? {};

    for (const file of CACHE_FILES) {
      // 命中即跳过（只留当前这一个文件的引用，出本轮即回收）；
      // 校验不过的记录已在读侧删除，这里当作缺失走下载
      const cached = await readVerifiedFile(file, manifest[file]);
      if (cached) {
        cachedCount++;
        onProgress?.(file, cached.byteLength, cached.byteLength);
        // 旧版本缓存首次 adoption：数据在、清单没有 → 只补清单，不重下
        if (!manifest[file]) manifest = await rememberFile(file, cached, manifest);
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

      // 截断检测：连接被中途掐断时 reader 只会安静地 done，不报错。
      // 不卡这一道就会把半截 model.onnx 当成功缓存收下（之后每次朗读都失败）
      if (contentLength > 0 && received !== contentLength) {
        throw new Error(`下载 ${name} 不完整：收到 ${received}/${contentLength} 字节`);
      }

      // 内存优化：合并时逐块释放 chunks 引用。大文件（model.onnx 310MB）合并时
      // chunks 与 buffer 同时存在会产生约 2 倍文件体积的瞬时峰值，是 iOS jetsam
      // 崩溃的主因；每块 set 完立即置空，让 GC 在合并过程中持续回收。
      const totalLength = chunks.reduce((sum, c) => sum + (c?.length ?? 0), 0);
      const buffer = new Uint8Array(totalLength);
      let offset = 0;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk) continue;
        buffer.set(chunk, offset);
        offset += chunk.length;
        chunks[i] = undefined as unknown as Uint8Array; // 已合并的 chunk 交还 GC
      }
      const arrayBuffer = buffer.buffer;

      // 立即存入 IndexedDB（下载即入库，不在内存中长期持有）。
      // 写失败必须整体失败：私有浏览模式下每次都写不进，若继续宣告就绪，
      // 后面每一轮朗读都要重新拉 380MB。清单在 put 成功后才记，
      // 所以失败的文件下一轮仍按缺失重下。
      try {
        await dbPut(file, arrayBuffer);
      } catch (e) {
        throw new Error(`缓存 ${name} 失败（可能处于私有浏览模式）: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      manifest = await rememberFile(file, arrayBuffer, manifest);
      downloadedCount++;
      onProgress?.(file, arrayBuffer.byteLength, arrayBuffer.byteLength);
    }

    console.log(`[TTS] 资源就绪：${cachedCount} 个已缓存 + ${downloadedCount} 个新下载`);

    // 下载/校验完成后广播，让其他已打开的标签页同步刷新缓存状态
    broadcastTTSCacheReady();
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
          // 清单不是资源文件，永远保留（删了就等于全体缓存重新走一轮 adoption）
          if (k === MANIFEST_KEY) continue;
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
