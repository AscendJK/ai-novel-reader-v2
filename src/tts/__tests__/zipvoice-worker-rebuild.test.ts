/**
 * 浏览器推理 worker 池的加载与崩溃自愈回归测试（批次 5b：R-67 / R-43）
 *
 * R-67（P0，perf 提交引入）：transferFilesToWorker 只读 ttsWorkers[index]，
 *   从不 createWorker → 槽位恒为 undefined → 首次 loadModel 抛 "Worker #0 不存在"
 *   → TTSManager 静默降级到 Web Speech，浏览器离线推理整条路径死掉。
 * R-43：全池崩溃时若无排队任务（最后一个在飞任务崩完的瞬间），旧自愈条件
 *   taskQueue.length > 0 不成立 → 永不重建；30s 节流又直接 return 不留重试，
 *   结果是"报错 3 次后只能刷新页面"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../tts-cache", () => ({
  isCacheReady: vi.fn(async () => true),
  takeFilesForTransfer: vi.fn(async () => ({
    files: { "model.onnx": new ArrayBuffer(64), "tokens.txt": new ArrayBuffer(32) },
    transferables: [new ArrayBuffer(64), new ArrayBuffer(32)],
  })),
  downloadAndCache: vi.fn(async () => {}),
  TTSCacheIntegrityError: class TTSCacheIntegrityError extends Error {
    keys: string[];
    constructor(message: string, keys: string[]) { super(message); this.keys = keys; }
  },
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(async () => { throw new Error("测试不应走网络"); }),
}));

// ── Worker mock：init→ready，generate→result（可按实例关闭自动应答模拟在飞）──
class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  autoRespond = true;
  terminated = false;
  initCount = 0;
  generateCount = 0;
  private listeners = new Set<(e: MessageEvent) => void>();
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    if (type === "message") this.listeners.add(fn);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    if (type === "message") this.listeners.delete(fn);
  }
  private emit(data: unknown) {
    const e = { data } as MessageEvent;
    this.onmessage?.(e);
    for (const fn of [...this.listeners]) fn(e);
  }
  postMessage(msg: { type: string; id?: number }) {
    if (this.terminated) return;
    if (msg.type === "init") {
      this.initCount++;
      setTimeout(() => this.emit({ type: "sherpa-onnx-tts-ready" }), 0);
    } else if (msg.type === "generate") {
      this.generateCount++;
      if (!this.autoRespond) return; // 模拟 wasm 同步推理仍在跑
      setTimeout(() => this.emit({ type: "sherpa-onnx-tts-result", id: msg.id, samples: new Float32Array(24000) }), 5);
    }
  }
  terminate() { this.terminated = true; }
  fireError(message: string) {
    this.onerror?.({ message, filename: "sherpa.worker.js", lineno: 1, colno: 1, error: null });
  }
}

const mockWorkers: MockWorker[] = [];
const globalAny = globalThis as Record<string, unknown>;

import { loadModel, generateAudio, isModelLoaded, resetWorker, setWorkerPoolSize } from "../zipvoice-engine";

beforeEach(() => {
  mockWorkers.length = 0;
  globalAny.Worker = class extends MockWorker {
    constructor() { super(); mockWorkers.push(this); }
  };
  globalAny.fetch = vi.fn(async () => ({ ok: true, text: async () => "// worker code" }));
  if (typeof URL.createObjectURL !== "function") {
    const urlAny = URL as unknown as Record<string, unknown>;
    urlAny.createObjectURL = () => "blob:mock";
    urlAny.revokeObjectURL = () => {};
  }
  setWorkerPoolSize(1);
  resetWorker(); // 回到干净池状态（模块级状态跨用例残留）
});

afterEach(() => {
  resetWorker();
  vi.useRealTimers();
});

describe("浏览器推理 worker 池", () => {
  it("R-67: loadModel 必须真正创建 worker 并就绪，generateAudio 能拿到音频", async () => {
    await loadModel();
    expect(mockWorkers).toHaveLength(1);
    expect(mockWorkers[0].initCount).toBe(1);
    expect(isModelLoaded()).toBe(true);

    const received: Float32Array[] = [];
    await generateAudio("从前有座山", { voice: "45" }, (a) => { received.push(a); });
    expect(received[0]?.length).toBe(24000);
  }, 20000);

  it("R-43: 最后一个在飞任务崩溃 → 立即重建；冷却内再崩 → 重试定时器到点重建；期间用户停止则撤表", async () => {
    vi.useFakeTimers();
    const loading = loadModel();
    await vi.advanceTimersByTimeAsync(20); // 放行 init→ready 的 0ms 定时器
    await loading;
    expect(isModelLoaded()).toBe(true);

    // ── 崩溃 #1：任务在飞、队列为空（旧代码此刻永不重建）──
    mockWorkers[0].autoRespond = false;
    const first = generateAudio("第一段").catch((e) => e);
    await vi.advanceTimersByTimeAsync(5);
    mockWorkers[0].fireError("jetsam killed");
    expect(await first).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(50);
    expect(mockWorkers).toHaveLength(2);
    expect(isModelLoaded()).toBe(true);

    // ── 崩溃 #2：仍在 30s 冷却内 → 不立即重建，但必须挂起重试定时器 ──
    mockWorkers[1].autoRespond = false;
    const second = generateAudio("第二段").catch((e) => e);
    await vi.advanceTimersByTimeAsync(5);
    mockWorkers[1].fireError("jetsam again");
    expect(await second).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockWorkers).toHaveLength(2);   // 节流生效：没有加载风暴
    expect(isModelLoaded()).toBe(false);

    await vi.advanceTimersByTimeAsync(30000);
    expect(mockWorkers).toHaveLength(3);   // 到点自愈，无需刷新页面
    expect(isModelLoaded()).toBe(true);

    // ── 崩溃 #3：又落进冷却窗口 → 挂起重试；此刻用户停止朗读，重试必须取消 ──
    mockWorkers[2].autoRespond = false;
    const third = generateAudio("第三段").catch((e) => e);
    await vi.advanceTimersByTimeAsync(5);
    mockWorkers[2].fireError("jetsam third");
    expect(await third).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(100);
    expect(mockWorkers).toHaveLength(3);   // 重试已挂起，尚未到点

    resetWorker();                         // 用户按停止
    await vi.advanceTimersByTimeAsync(60000);
    expect(mockWorkers).toHaveLength(3);   // 不得在后台拉起数百 MB 的整池
    expect(isModelLoaded()).toBe(false);
    vi.useRealTimers();
  }, 20000);
});
