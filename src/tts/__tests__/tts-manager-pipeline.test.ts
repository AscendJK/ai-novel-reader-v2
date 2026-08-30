/**
 * TTSManager 流水线预生成测试
 * 验证「播放当前段的同时并行推理下一段」：
 * 1. 播放 chunk N 时已启动 chunk N+1 的预生成（而非等 N 播完才开始）
 * 2. chunk N 播放结束后直接使用预生成音频（不重复生成）
 * 3. 停止/seek 时预生成结果被丢弃
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TTSManager, type TTSChunk } from "../tts-manager";

// ── Mock 音频生成引擎（记录调用，模拟异步推理）──
const generateCalls: { text: string; voice: string; speed: number }[] = [];
vi.mock("../zipvoice-engine", () => ({
  isModelLoaded: () => true,
  loadModel: vi.fn(async () => {}),
  generateAudio: vi.fn(async (text: string, opts: { voice: string; speed: number }, onChunk: (data: Float32Array) => void) => {
    generateCalls.push({ text, voice: opts.voice, speed: opts.speed });
    await new Promise(r => setTimeout(r, 10)); // 模拟 worker 推理耗时
    onChunk(new Float32Array(24000)); // 1 秒音频
  }),
  resetWorker: vi.fn(),
}));

vi.mock("../server-engine", () => ({
  synthesizeServer: vi.fn(async (text: string, opts: { voice?: string; speed?: number }) => {
    generateCalls.push({ text, voice: opts.voice ?? "45", speed: opts.speed ?? 1 });
    await new Promise(r => setTimeout(r, 10)); // 模拟网络 + Python 推理耗时
    return { samples: new Float32Array(24000), sampleRate: 24000 }; // 1 秒音频
  }),
  cancelServerInference: vi.fn(async () => {}),
}));

import { cancelServerInference as mockCancelServerInference } from "../server-engine";

// ── Mock Web Audio API（jsdom 无 AudioContext）──
class MockAudioBufferSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  playbackRate = { value: 1 };
  connect() { /* noop */ }
  start() {
    // 模拟播放 120ms 后自然结束
    setTimeout(() => this.onended?.(), 120);
  }
  stop() { this.onended = null; }
}
class MockAudioBuffer {
  duration: number;
  length: number;
  sampleRate: number;
  constructor(length: number, sampleRate: number) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
  }
  copyToChannel() { /* noop */ }
}
class MockAudioContext {
  state = "running";
  currentTime = 0;
  destination = {};
  createBuffer(_ch: number, len: number, rate: number) { return new MockAudioBuffer(len, rate) as unknown as AudioBuffer; }
  createBufferSource() { return new MockAudioBufferSource() as unknown as AudioBufferSourceNode; }
  resume() { this.state = "running"; return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

function makeChunks(): TTSChunk[] {
  return [
    { text: "第一段。", index: 0, paragraphIndex: 0, paragraphIndices: [0], paragraphBreaks: [0] },
    { text: "第二段。", index: 1, paragraphIndex: 1, paragraphIndices: [1], paragraphBreaks: [0] },
    { text: "第三段。", index: 2, paragraphIndex: 2, paragraphIndices: [2], paragraphBreaks: [0] },
  ];
}

const flush = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeEach(() => {
  (globalThis as Record<string, unknown>).AudioContext = MockAudioContext;
  generateCalls.length = 0;
  vi.clearAllMocks();
});

describe("TTSManager 流水线预生成", () => {
  it("播放当前 chunk 时并行预生成下一段（不等播放结束才开始推理）", async () => {
    const manager = new TTSManager();
    manager.setEngine("server");
    manager.setVoice("49");

    const chunks = makeChunks();
    const chunkEnds: number[] = [];
    const done = new Promise<void>((resolve) => {
      manager.speak(chunks, {
        onChunkEnd: (i) => { chunkEnds.push(i); },
        onEnd: () => resolve(),
      }).catch(() => {});
    });

    // chunk 0 生成（10ms）+ 开始播放后：此时 chunk 1 的预生成应已在后台进行
    await flush(60);
    expect(generateCalls.length).toBeGreaterThanOrEqual(2); // chunk0 + chunk1 预生成
    expect(generateCalls[0].text).toBe("第一段。");
    expect(generateCalls[1].text).toBe("第二段。"); // 播放 chunk0 时已在推理 chunk1

    await done;
    // 三段音频总共应生成 3 次（无重复生成）：chunk0 现场生成，chunk1/2 预生成
    expect(generateCalls.length).toBe(3);
    expect(chunkEnds).toEqual([0, 1, 2]);
    manager.destroy();
  }, 10000);

  it("服务端引擎与浏览器引擎都走流水线", async () => {
    const manager = new TTSManager();
    manager.setEngine("zipvoice");
    manager.setVoice("45");
    const chunks = makeChunks().slice(0, 2);
    const done = new Promise<void>((resolve) => {
      manager.speak(chunks, { onEnd: () => resolve() }).catch(() => {});
    });
    await flush(60);
    // 浏览器推理（zipvoice-engine.generateAudio）同样在播放 chunk0 时预生成 chunk1
    expect(generateCalls.length).toBe(2);
    await done;
    manager.destroy();
  }, 10000);

  it("停止朗读时丢弃预生成结果", async () => {
    const manager = new TTSManager();
    manager.setEngine("server");
    const chunks = makeChunks();
    const speakPromise = manager.speak(chunks, {
      onChunkEnd: () => {},
      onEnd: () => {},
    }).catch(() => {});

    // chunk0 播放中（预生成 chunk1 已开始）时停止
    await flush(60);
    expect(generateCalls.length).toBeGreaterThanOrEqual(2);
    manager.stop();

    // 停止后不再继续生成/播放后续 chunk
    await flush(200);
    expect(generateCalls.length).toBeLessThanOrEqual(2); // chunk1 预生成可能已完成，但不会继续生成 chunk2
    await speakPromise;
    manager.destroy();
  }, 10000);

  it("seek 到新 chunk 后重新生成（不使用旧预生成）", async () => {
    const manager = new TTSManager();
    manager.setEngine("server");
    const chunks = makeChunks();
    const done = new Promise<void>((resolve) => {
      manager.speak(chunks, { onEnd: () => resolve() }).catch(() => {});
    });

    await flush(60); // chunk0 播放中，chunk1 预生成进行中
    const callsBeforeSeek = generateCalls.length;
    manager.seekToChunk(2); // 跳到 chunk2

    await done;
    // seek 后从 chunk2 重新生成（旧预生成 chunk1 被丢弃）
    const seekCalls = generateCalls.slice(callsBeforeSeek);
    expect(seekCalls.some(c => c.text === "第三段。")).toBe(true);
    manager.destroy();
  }, 10000);

  it("停止/seek/新朗读时通知服务器取消排队请求（仅 server 引擎）", async () => {
    const manager = new TTSManager();
    manager.setEngine("server");
    const chunks = makeChunks();
    mockCancelServerInference.mockClear();

    const speakPromise = manager.speak(chunks, { onChunkEnd: () => {}, onEnd: () => {} }).catch(() => {});
    await flush(20); // chunk0 生成中（或预生成已启动）
    expect(mockCancelServerInference).toHaveBeenCalledTimes(1); // speak 启动时清理旧队列

    manager.stop();
    await flush(20);
    expect(mockCancelServerInference).toHaveBeenCalledTimes(2); // 停止时取消排队请求

    // seek 也会触发取消（旧请求作废释放队列）
    manager.speak(chunks, { onChunkEnd: () => {}, onEnd: () => {} }).catch(() => {});
    await flush(20);
    const beforeSeek = mockCancelServerInference.mock.calls.length;
    manager.seekToChunk(1);
    expect(mockCancelServerInference.mock.calls.length).toBe(beforeSeek + 1);

    await speakPromise;
    manager.destroy();
  }, 10000);
});
