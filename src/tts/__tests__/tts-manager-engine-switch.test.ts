/**
 * TTSManager 跨引擎切换回归测试（P0-1 fix）
 * 覆盖场景：
 * 1. server → zipvoice：同一 manager 实例切换后，必须重建为 BrowserKokoroEngine
 *    （旧 bug：getKokoroEngine 首次创建后固定返回旧类型实例，切到 zipvoice 仍走 server 推理）
 * 2. zipvoice → server：反向切换，重建为 ServerKokoroEngine
 * 3. webspeech → server：webspeech 朗读后切 server，正确走服务端推理
 * 4. 切换后音色参数生效（重建实例拿到最新 voiceId）
 * 5. 引擎切换时正在朗读：stop 会中断旧引擎（server 触发 cancelServerInference）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TTSManager, type TTSChunk } from "../tts-manager";

// ── 分别记录两个引擎的生成调用（区分引擎，验证切换后走了正确引擎）──
const serverCalls: { text: string; voice: string; speed: number }[] = [];
const zipvoiceCalls: { text: string; voice: string; speed: number }[] = [];

vi.mock("../zipvoice-engine", () => ({
  isModelLoaded: () => true, // 跳过 loadModel，聚焦引擎实例分发
  loadModel: vi.fn(async () => {}),
  generateAudio: vi.fn(async (text: string, opts: { voice: string; speed: number }, onChunk: (data: Float32Array) => void) => {
    zipvoiceCalls.push({ text, voice: opts.voice, speed: opts.speed });
    await new Promise(r => setTimeout(r, 10)); // 模拟 worker 推理耗时
    onChunk(new Float32Array(24000)); // 1 秒音频
  }),
  resetWorker: vi.fn(),
}));

vi.mock("../server-engine", () => ({
  synthesizeServer: vi.fn(async (text: string, opts: { voice?: string; speed?: number }) => {
    serverCalls.push({ text, voice: opts.voice ?? "45", speed: opts.speed ?? 1 });
    await new Promise(r => setTimeout(r, 10)); // 模拟网络 + Python 推理耗时
    return { samples: new Float32Array(24000), sampleRate: 24000 }; // 1 秒音频
  }),
  cancelServerInference: vi.fn(async () => {}),
}));

import { cancelServerInference } from "../server-engine";
const mockCancelServerInference = vi.mocked(cancelServerInference);

const globalAny = globalThis as Record<string, unknown>;

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
  duration = 1;
  sampleRate = 24000;
  getChannelData() { return new Float32Array(24000); }
  copyToChannel() { /* noop */ }
}

// ── Mock Web Speech API（webspeech 用例需要）──
class MockUtterance {
  text: string;
  rate = 1; volume = 1; pitch = 1; lang = ""; voice = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onboundary: ((e: { charIndex?: number }) => void) | null = null;
  constructor(text: string) { this.text = text; }
}
globalAny.SpeechSynthesisUtterance = MockUtterance;
globalAny.speechSynthesis = {
  getVoices: () => [{ voiceURI: "v1", lang: "zh-CN", name: "Mock", default: true, localService: true }],
  get speaking() { return false; },
  get pending() { return false; },
  speak: (u: MockUtterance) => { u.onstart?.(); u.onend?.(); },
  cancel: () => {},
  pause: () => {},
  resume: () => {},
};

globalAny.AudioContext = class {
  currentTime = 0;
  state = "running" as const;
  createBuffer() { return new MockAudioBuffer(); }
  createBufferSource() { return new MockAudioBufferSource(); }
  createGain() { return { connect: () => {}, gain: { value: 1 } }; }
  createPanner() { return { connect: () => {} }; }
  destination = {};
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
};

function makeChunks(): TTSChunk[] {
  return [
    { text: "第一段。", index: 0, paragraphIndex: 0, paragraphIndices: [0], paragraphBreaks: [0] },
    { text: "第二段。", index: 1, paragraphIndex: 1, paragraphIndices: [1], paragraphBreaks: [0] },
  ];
}

const flush = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 等待一次朗读结束（onEnd 或 onError 或 onFallback 都算结束，避免挂起超时） */
function speakToEnd(manager: TTSManager, chunks: TTSChunk[], errors: string[]): Promise<void> {
  return new Promise((resolve) => {
    manager.speak(chunks, {
      onEnd: () => resolve(),
      onError: (e) => { errors.push(e); resolve(); },
      onFallback: (_f, to) => { errors.push(`fallback→${to}`); resolve(); },
    }).catch((e) => { errors.push(`speak rejected: ${String(e)}`); resolve(); });
  });
}

beforeEach(() => {
  serverCalls.length = 0;
  zipvoiceCalls.length = 0;
  vi.clearAllMocks();
});

afterEach(async () => {
  await flush(50);
});

describe("TTSManager 跨引擎切换", () => {
  it("server → zipvoice：同一实例切换后重建为浏览器引擎（不再走服务端推理）", async () => {
    const manager = new TTSManager();
    manager.setPrefetchCount(0); // 关闭预生成，聚焦现场生成路径
    manager.setEngine("server");
    manager.setVoice("49");

    const chunks = makeChunks();
    const errors: string[] = [];
    // 第一次朗读：server
    await speakToEnd(manager, chunks, errors);
    expect(errors).toEqual([]);
    expect(serverCalls.length).toBeGreaterThan(0);
    expect(zipvoiceCalls.length).toBe(0);

    // 切换到 zipvoice，同一实例再次朗读
    manager.setEngine("zipvoice");
    manager.setVoice("45");
    await speakToEnd(manager, chunks, errors);
    expect(errors).toEqual([]);
    // P0-1 断言：切换后走浏览器推理；旧 bug 下这里仍是 serverCalls 增长
    expect(zipvoiceCalls.length).toBeGreaterThan(0);
    const serverCallsAfter = serverCalls.length;
    await flush(50);
    expect(serverCalls.length).toBe(serverCallsAfter); // server 引擎不再被调用

    manager.destroy();
  }, 15000);

  it("zipvoice → server：同一实例切换后重建为服务端引擎", async () => {
    const manager = new TTSManager();
    manager.setPrefetchCount(0);
    manager.setEngine("zipvoice");
    manager.setVoice("45");

    const chunks = makeChunks();
    const errors: string[] = [];
    await speakToEnd(manager, chunks, errors);
    expect(errors).toEqual([]);
    expect(zipvoiceCalls.length).toBeGreaterThan(0);
    expect(serverCalls.length).toBe(0);

    // 切换到 server
    manager.setEngine("server");
    manager.setVoice("50");
    await speakToEnd(manager, chunks, errors);
    expect(errors).toEqual([]);
    expect(serverCalls.length).toBeGreaterThan(0);
    const zipvoiceCallsAfter = zipvoiceCalls.length;
    await flush(50);
    expect(zipvoiceCalls.length).toBe(zipvoiceCallsAfter); // 浏览器引擎不再被调用

    manager.destroy();
  }, 15000);

  it("webspeech → server：切换后正确走服务端推理", async () => {
    const manager = new TTSManager();
    manager.setPrefetchCount(0);
    manager.setEngine("webspeech");
    // webspeech 朗读不触发任何 Kokoro 生成
    const chunks = makeChunks();
    const errors: string[] = [];
    await speakToEnd(manager, chunks, errors);
    expect(errors).toEqual([]);
    expect(serverCalls.length).toBe(0);
    expect(zipvoiceCalls.length).toBe(0);

    manager.setEngine("server");
    await speakToEnd(manager, chunks, errors);
    expect(errors).toEqual([]);
    expect(serverCalls.length).toBeGreaterThan(0);

    manager.destroy();
  }, 15000);

  it("切换后音色参数生效（重建实例使用最新 voiceId）", async () => {
    const manager = new TTSManager();
    manager.setPrefetchCount(0);
    manager.setEngine("server");
    manager.setVoice("49");
    const chunks = makeChunks();
    const errors: string[] = [];
    await speakToEnd(manager, chunks, errors);
    expect(errors).toEqual([]);
    expect(serverCalls[0].voice).toBe("49");

    // 切 zipvoice 并换音色
    manager.setEngine("zipvoice");
    manager.setVoice("52");
    await speakToEnd(manager, chunks, errors);
    expect(errors).toEqual([]);
    expect(zipvoiceCalls[0].voice).toBe("52");

    manager.destroy();
  }, 15000);

  it("引擎切换时正在朗读：切换前 stop 中断 server 并通知取消排队", async () => {
    const manager = new TTSManager();
    manager.setPrefetchCount(3);
    manager.setEngine("server");
    const chunks = makeChunks();
    const speakPromise = manager.speak(chunks, { onEnd: () => {} }).catch(() => {});
    await flush(60); // 预生成阶段
    expect(serverCalls.length).toBeGreaterThan(0);

    // 切换引擎：应停止当前朗读（触发 server 取消）
    manager.stop();
    expect(mockCancelServerInference).toHaveBeenCalled();
    manager.setEngine("zipvoice");
    await speakPromise;
    manager.destroy();
  }, 10000);
});
