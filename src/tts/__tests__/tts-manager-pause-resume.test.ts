/**
 * 暂停/恢复状态机回归测试（批次 5a：R-41 / R-42）
 *
 * R-41：AudioContext 被浏览器挂起（iOS 来电/静音中断后 resume 被拒）时，
 *       resume() 仍创建 source → source.start() 静默失败（不出声也不触发 onended）
 *       → pendingPlayResolve 永不 resolve → 整条朗读链永久停摆。
 *       并发/连点 resume() 会叠出两个 source 混播。
 * R-42：Web Speech 暂停走 cancel()，Firefox/部分 WebView 会为 cancel 触发
 *       当前 utterance 的 onend → 被当成自然播完 → 暂停后继续朗读下一段。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TTSManager, type TTSChunk } from "../tts-manager";

// ── 可控 AudioContext mock ──
type ResumeBehavior = "running" | "stay-suspended" | "reject" | "deferred";

const ctxState = {
  state: "running" as AudioContextState,
  resumeBehavior: "running" as ResumeBehavior,
  createSourceCalls: 0,
  resolveDeferredResume: null as (() => void) | null,
};

class MockSource {
  buffer: unknown = null;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  private naturalEnd: ReturnType<typeof setTimeout> | null = null;
  private ended = false;
  connect() { /* noop */ }
  private fireEnded() {
    if (this.ended) return;    // onended 每个 source 只触发一次（spec 行为）
    this.ended = true;
    this.onended?.();
  }
  start() {
    // 真实浏览器：context 处于 suspended 时 start() 不发声，也不会在
    // resume 之前触发 onended。此处如实建模，才能复现"链永久挂起"。
    if (ctxState.state !== "running") return;
    this.naturalEnd = setTimeout(() => this.fireEnded(), 200);
  }
  stop() {
    if (this.naturalEnd) clearTimeout(this.naturalEnd);
    setTimeout(() => this.fireEnded(), 0);
  }
}

class MockAudioBuffer {
  duration = 1;
  length = 24000;
  sampleRate = 24000;
  numberOfChannels = 1;
  getChannelData() { return new Float32Array(24000); }
  copyToChannel() { /* noop */ }
}

const globalAny = globalThis as Record<string, unknown>;

globalAny.AudioContext = class {
  currentTime = 0;
  destination = {};
  get state() { return ctxState.state; }
  createBuffer() { return new MockAudioBuffer(); }
  createBufferSource() { ctxState.createSourceCalls++; return new MockSource(); }
  createGain() { return { connect: () => {}, gain: { value: 1 } }; }
  resume(): Promise<void> {
    if (ctxState.resumeBehavior === "running") { ctxState.state = "running"; return Promise.resolve(); }
    if (ctxState.resumeBehavior === "stay-suspended") return Promise.resolve(); // resolve 了但状态仍 suspended
    if (ctxState.resumeBehavior === "reject") return Promise.reject(new Error("NotAllowedError"));
    return new Promise<void>((resolve) => { ctxState.resolveDeferredResume = resolve; });
  }
  close() { ctxState.state = "closed"; return Promise.resolve(); }
};

// ── 可控 speechSynthesis mock（cancel 触发 onend = Firefox 行为）──
class MockUtterance {
  text: string;
  rate = 1; volume = 1; pitch = 1; lang = ""; voice = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onboundary: ((e: { charIndex?: number }) => void) | null = null;
  constructor(text: string) { this.text = text; }
}

const speechState = {
  spoken: [] as MockUtterance[],
  current: null as MockUtterance | null,
  cancelFiresOnEnd: true,
};

globalAny.SpeechSynthesisUtterance = MockUtterance;
globalAny.speechSynthesis = {
  getVoices: () => [{ voiceURI: "v1", lang: "zh-CN", name: "Mock", default: true, localService: true }],
  get speaking() { return speechState.current !== null; },
  get pending() { return false; },
  speak: (u: MockUtterance) => {
    speechState.spoken.push(u);
    speechState.current = u;
    setTimeout(() => { u.onstart?.(); }, 0);
  },
  cancel: () => {
    const u = speechState.current;
    speechState.current = null;
    if (u && speechState.cancelFiresOnEnd) setTimeout(() => u.onend?.(), 0);
  },
  pause: () => {},
  resume: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
};

// ── 音频生成：1 秒空音频，几乎瞬时 ──
vi.mock("../zipvoice-engine", () => ({
  isModelLoaded: () => true,
  loadModel: vi.fn(async () => {}),
  generateAudio: vi.fn(async (_t: string, _o: unknown, onChunk: (d: Float32Array) => void) => {
    await new Promise(r => setTimeout(r, 5));
    onChunk(new Float32Array(24000));
  }),
  resetWorker: vi.fn(),
}));

vi.mock("../server-engine", () => ({
  synthesizeServer: vi.fn(async () => ({ samples: new Float32Array(24000), sampleRate: 24000 })),
  cancelServerInference: vi.fn(async () => {}),
}));

const chunks: TTSChunk[] = [
  { text: "第一段内容", index: 0, paragraphIndex: 0, paragraphIndices: [0], paragraphBreaks: [0] },
  { text: "第二段内容", index: 1, paragraphIndex: 1, paragraphIndices: [1], paragraphBreaks: [0] },
];

const flush = (ms: number) => new Promise(r => setTimeout(r, ms));

function makeCallbacks() {
  return {
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onStop: vi.fn(),
    onEnd: vi.fn(),
    onError: vi.fn(),
    onChunkStart: vi.fn(),
    onChunkEnd: vi.fn(),
    onParagraphChange: vi.fn(),
  };
}

beforeEach(() => {
  ctxState.state = "running";
  ctxState.resumeBehavior = "running";
  ctxState.createSourceCalls = 0;
  ctxState.resolveDeferredResume = null;
  speechState.spoken = [];
  speechState.current = null;
  speechState.cancelFiresOnEnd = true;
  vi.clearAllMocks();
});

describe("R-41 Kokoro resume：AudioContext 挂起时必须放弃而非静默卡死", () => {
  it("resume 被拒（context 仍 suspended）→ 不创建 source、保持暂停、返回 false；再次 resume 成功后继续朗读", async () => {
    const manager = new TTSManager();
    manager.setEngine("zipvoice");
    manager.setPrefetchCount(0);
    const cb = makeCallbacks();
    const chain = manager.speak(chunks, cb).catch(() => {});
    await flush(40); // 首段开播（mock 播 200ms）
    expect(cb.onPlay).toHaveBeenCalledTimes(1);
    expect(ctxState.createSourceCalls).toBe(1);

    manager.pause();
    await flush(10);
    expect(manager.isPaused()).toBe(true);

    // 模拟 iOS 音频中断后 resume 被拒：调用不报错但状态依旧 suspended
    ctxState.state = "suspended";
    ctxState.resumeBehavior = "stay-suspended";

    const sourcesBefore = ctxState.createSourceCalls;
    const ok = await manager.resume();
    expect(ok).toBe(false);
    expect(ctxState.createSourceCalls).toBe(sourcesBefore); // 关键：不得创建 source
    expect(manager.isPaused()).toBe(true);                   // 关键：不得谎报已恢复
    expect(cb.onResume).not.toHaveBeenCalled();

    // 用户点击页面后浏览器放行 → 第二次 resume 必须真正续播，链未损坏
    ctxState.state = "running";
    ctxState.resumeBehavior = "running";
    const ok2 = await manager.resume();
    expect(ok2).toBe(true);
    expect(ctxState.createSourceCalls).toBe(sourcesBefore + 1);
    expect(manager.isPaused()).toBe(false);

    await flush(300); // 首段从暂停点播完 → 推进到第二段
    expect(cb.onChunkEnd).toHaveBeenCalledWith(0, 2, 0);
    expect(cb.onEnd).not.toHaveBeenCalled(); // 第二段仍在读（未卡死）

    manager.stop();
    await chain;
    manager.destroy();
  }, 15000);

  it("resume() 整体 reject（NotAllowedError）→ 同样保持暂停，不留下挂死链", async () => {
    const manager = new TTSManager();
    manager.setEngine("zipvoice");
    manager.setPrefetchCount(0);
    const cb = makeCallbacks();
    const chain = manager.speak(chunks, cb).catch(() => {});
    await flush(40);
    manager.pause();
    await flush(10);

    ctxState.state = "suspended";
    ctxState.resumeBehavior = "reject";
    expect(await manager.resume()).toBe(false);
    expect(manager.isPaused()).toBe(true);
    expect(ctxState.createSourceCalls).toBe(1);

    manager.stop();
    await chain;
    manager.destroy();
  }, 15000);

  it("连点两下 resume → 只恢复一次，不叠两个 source 混播", async () => {
    const manager = new TTSManager();
    manager.setEngine("zipvoice");
    manager.setPrefetchCount(0);
    const cb = makeCallbacks();
    const chain = manager.speak(chunks, cb).catch(() => {});
    await flush(40);
    manager.pause();
    await flush(10);
    expect(ctxState.createSourceCalls).toBe(1);

    // resume() 在飞行中（等待 ctx.resume 完成）——两次调用必须合并为一轮
    ctxState.state = "suspended";
    ctxState.resumeBehavior = "deferred";
    const p1 = manager.resume();
    const p2 = manager.resume();
    await flush(5);
    ctxState.state = "running";
    ctxState.resolveDeferredResume?.();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(ctxState.createSourceCalls).toBe(2); // 仅一个恢复用的 source

    manager.stop();
    await chain;
    manager.destroy();
  }, 15000);

  it("暂停期间 stop() → 迟到的 resume 不得继续出声", async () => {
    const manager = new TTSManager();
    manager.setEngine("zipvoice");
    manager.setPrefetchCount(0);
    const cb = makeCallbacks();
    const chain = manager.speak(chunks, cb).catch(() => {});
    await flush(40);
    manager.pause();
    await flush(10);

    ctxState.state = "suspended";
    ctxState.resumeBehavior = "deferred";
    const p = manager.resume();
    await flush(5);
    manager.stop();                       // 用户在 resume 飞行中按了停止
    ctxState.state = "running";
    ctxState.resolveDeferredResume?.();
    expect(await p).toBe(false);
    expect(ctxState.createSourceCalls).toBe(1); // 未新建播放源

    await chain;
    manager.destroy();
  }, 15000);
});

describe("R-42 Web Speech 暂停：cancel 触发的 onend 不得被当成播完", () => {
  it("pause() 后引擎补发 onend → 不推进 chunk、不朗读下一段、保持暂停", async () => {
    const manager = new TTSManager();
    manager.setEngine("webspeech");
    const cb = makeCallbacks();
    const chain = manager.speak(chunks, cb).catch(() => {});
    await flush(150); // speak 内 60ms 延迟 + onstart
    expect(speechState.spoken.map(u => u.text)).toEqual(["第一段内容"]);
    expect(cb.onPlay).toHaveBeenCalled();

    manager.pause();
    await flush(150); // cancel → onend 已补发

    expect(speechState.spoken).toHaveLength(1);   // 关键：没有偷偷读第二段
    expect(cb.onChunkEnd).not.toHaveBeenCalled();
    expect(cb.onEnd).not.toHaveBeenCalled();
    expect(manager.isPaused()).toBe(true);

    manager.stop();
    await chain;
    manager.destroy();
  }, 15000);

  it("pause → resume：从暂停处的那一段继续，而不是跳过或双重朗读", async () => {
    const manager = new TTSManager();
    manager.setEngine("webspeech");
    const cb = makeCallbacks();
    const chain = manager.speak(chunks, cb).catch(() => {});
    await flush(150);
    manager.pause();
    await flush(150);

    const ok = await manager.resume();
    expect(ok).toBe(true);
    await flush(150);
    expect(speechState.spoken.map(u => u.text)).toEqual(["第一段内容", "第一段内容"]);
    expect(cb.onResume).toHaveBeenCalled();

    manager.stop();
    await chain;
    manager.destroy();
  }, 15000);

  it("cancel 不补发 onend 的浏览器（Chrome 行为）：暂停/恢复同样只推进一次", async () => {
    speechState.cancelFiresOnEnd = false;
    const manager = new TTSManager();
    manager.setEngine("webspeech");
    const cb = makeCallbacks();
    const chain = manager.speak(chunks, cb).catch(() => {});
    await flush(150);
    manager.pause();
    await flush(80);
    expect(speechState.spoken).toHaveLength(1);
    const ok = await manager.resume();
    expect(ok).toBe(true);
    await flush(120);
    expect(speechState.spoken).toHaveLength(2);
    manager.stop();
    await chain;
    manager.destroy();
  }, 15000);
});
