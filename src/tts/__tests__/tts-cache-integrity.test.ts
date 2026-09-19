/**
 * TTS 资源缓存的清单校验与自愈回归测试（批次 5c：R-45）
 *
 * 旧行为：dbPut 失败只 warn、下载截断无人查、isCacheReady 只看"记录存在"。
 * 一次被 HTTP 强缓存污染或写坏的文件会永久通过就绪判定，之后每次朗读都卡在
 * "模型缓存缺失"上（且没有自愈路径）。现在：下载校 content-length、写库失败即
 * 整体失败、清单记 {size, sha}，读侧按清单就地剔除坏记录并定点重下。
 */
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";

const BYTES_SMALL = 64;
const BYTES_BIG = 9 * 1024 * 1024;   // > SHA_VERIFY_MAX_BYTES(8MB)：只校尺寸不哈希

const apiCalls: string[] = [];
let truncateOnce = false;

const fakeApiFetch = vi.fn(async (path: string) => {
  apiCalls.push(path);
  const name = decodeURIComponent(path.replace(/^.*\/(wasm|model)\//, "").split("?")[0]);
  const isBig = name.endsWith("model.onnx");
  const total = isBig ? BYTES_BIG : BYTES_SMALL;
  const willTruncate = truncateOnce && isBig;
  if (willTruncate) truncateOnce = false;   // 只在真的用上时消耗一次性开关
  const sent = willTruncate ? total - 1024 : total;
  const bytes = new Uint8Array(sent).fill(isBig ? 7 : 3);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
  return {
    ok: true,
    headers: { get: (h: string) => (h.toLowerCase() === "content-length" ? String(total) : null) },
    body: stream,
  };
});

vi.mock("@/lib/api-client", () => ({
  apiFetch: (path: string) => fakeApiFetch(path),
}));

// 配额门控：关掉它等于模拟私有浏览模式下写库必然失败
const quotaGate = { allowWrite: true };
vi.mock("@/lib/quota-guard", () => ({
  withQuotaRetry: async (op: () => Promise<void>) => {
    if (!quotaGate.allowWrite) throw new DOMException("quota exceeded", "QuotaExceededError");
    return op();
  },
}));

import { isCacheReady, downloadAndCache, takeFilesForTransfer, clearCache, TTSCacheIntegrityError } from "../tts-cache";

const PREFIX = "kokoro-v3/";

/** 直接改 IndexedDB 里的记录，模拟"缓存被写坏/被截断"后的磁盘状态 */
function rawPut(key: string, data: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open("tts-cache", 1);
    openReq.onsuccess = () => {
      const db = openReq.result;
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").put(data, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    openReq.onerror = () => reject(openReq.error);
  });
}

// fake-indexeddb 在同一测试文件内共享一个库：每个用例先清干净，
// 否则上一用例留下的完整缓存会让本用例走"命中即跳过"分支，测不到写入路径
beforeEach(async () => {
  apiCalls.length = 0;
  truncateOnce = false;
  quotaGate.allowWrite = true;
  await clearCache();
});

describe("TTS 缓存清单", () => {
  it("完整下载后清单就绪，transfer 拿到短文件名与全部 transferable", async () => {
    expect(await isCacheReady()).toBe(false);   // 空缓存
    await downloadAndCache();
    expect(await isCacheReady()).toBe(true);

    const batch = await takeFilesForTransfer();
    const names = Object.keys(batch.files);
    expect(names.length).toBeGreaterThan(10);
    expect(names).toContain("model.onnx");
    expect(names).toContain("dict/jieba.dict.utf8");   // 缓存 key 前缀已剥掉
    expect(names.some(n => n.startsWith(PREFIX))).toBe(false);
    expect(batch.transferables).toHaveLength(names.length);
    expect(batch.files["model.onnx"].byteLength).toBe(BYTES_BIG);
  }, 30000);

  it("响应被截断（实收 < content-length）→ 整体失败且不记清单", async () => {
    truncateOnce = true;
    await expect(downloadAndCache()).rejects.toThrow(/不完整/);
    expect(await isCacheReady()).toBe(false);
  }, 30000);

  it("写库失败不再被吞掉：downloadAndCache 必须抛错", async () => {
    quotaGate.allowWrite = false;
    await expect(downloadAndCache()).rejects.toThrow(/私有浏览模式/);
    expect(await isCacheReady()).toBe(false);
  }, 30000);

  it("大文件只校尺寸：截断记录不通过 takeFilesForTransfer，并被定点重下自愈", async () => {
    await downloadAndCache();
    // model.onnx 超过哈希阈值 → 就绪检查不读 310MB，只信清单尺寸
    await rawPut(`${PREFIX}model.onnx`, new Uint8Array(BYTES_BIG - 4096).buffer);
    expect(await isCacheReady()).toBe(true);   // 刻意：为省 1~2 秒哈希不做全量读

    await expect(takeFilesForTransfer()).rejects.toBeInstanceOf(TTSCacheIntegrityError);
    // 坏记录已删除 → 下一轮 downloadAndCache 只重下它一个
    apiCalls.length = 0;
    await downloadAndCache();
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0]).toContain("model.onnx");
    const batch = await takeFilesForTransfer();
    expect(batch.files["model.onnx"].byteLength).toBe(BYTES_BIG);
  }, 60000);

  it("小文件校 SHA：同尺寸但内容被换掉的缓存判为未就绪", async () => {
    await downloadAndCache();
    // 长度一致、字节不同（典型形态：错误页/旧版本被强缓存回填）
    await rawPut(`${PREFIX}tokens.txt`, new Uint8Array(BYTES_SMALL).fill(9).buffer);
    expect(await isCacheReady()).toBe(false);
    const err = await takeFilesForTransfer().catch(e => e);
    expect(err).toBeInstanceOf(TTSCacheIntegrityError);
    expect((err as TTSCacheIntegrityError).keys).toEqual([`${PREFIX}tokens.txt`]);
  }, 60000);
});
