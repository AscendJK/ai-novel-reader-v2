import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock zipvoice-engine：不加载真实 WASM ──
vi.mock("../zipvoice-engine", () => ({
  isModelLoaded: () => true,
  loadModel: vi.fn(async () => {}),
  generateAudio: vi.fn(async () => {}),
  resetWorker: vi.fn(),
}));

// ── Mock 浏览器 Web Speech API ──
class MockUtterance {
  text: string;
  rate = 1; volume = 1; pitch = 1; lang = ""; voice = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onboundary: ((e: { charIndex?: number }) => void) | null = null;
  constructor(text: string) { this.text = text; }
}

const globalAny = globalThis as Record<string, unknown>;
const mockVoices = [{ voiceURI: "v1", lang: "zh-CN", name: "Mock", default: true, localService: true }];

// 全局 SpeechSynthesisUtterance（tts-manager 里 new 它）
globalAny.SpeechSynthesisUtterance = MockUtterance;

const speechState = {
  speaking: false,
  pending: false,
  utterances: [] as MockUtterance[],
  cancelled: false,
};

function resetSpeechMock() {
  speechState.speaking = false;
  speechState.pending = false;
  speechState.utterances = [];
  speechState.cancelled = false;
}

beforeEach(() => {
  resetSpeechMock();
  vi.clearAllMocks();
});

globalAny.speechSynthesis = {
  getVoices: () => mockVoices,
  get speaking() { return speechState.speaking; },
  get pending() { return speechState.pending; },
  speak: (u: MockUtterance) => {
    speechState.utterances.push(u);
    speechState.speaking = true;
    // 模拟 speak 开始（Chrome 会在稍后触发 onstart）
    setTimeout(() => {
      if (speechState.utterances.includes(u)) {
        console.log("[diag-mock] onstart for", u.text);
        u.onstart?.();
      } else {
        console.log("[diag-mock] onstart SKIPPED for", u.text, "(cancelled)");
      }
    }, 0);
  },
  cancel: () => {
    speechState.cancelled = true;
    speechState.speaking = false;
    const u = speechState.utterances[speechState.utterances.length - 1];
    speechState.utterances = [];
    // 模拟 cancel 触发旧 utterance 的 error（canceled），不应传播为错误
    if (u) setTimeout(() => u.onerror?.({ error: "canceled" }), 0);
  },
  pause: () => {},
  resume: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
};

// 延迟 speak 用 setTimeout（60ms），测试中等待宏任务
const flush = () => new Promise(r => setTimeout(r, 150));

/**
 * 等到条件成立（最多 timeoutMs）。
 *
 * 正向断言不能靠固定 150ms 赌调度：整仓 79 个文件一起跑、机器负载高时，同一条断言会在
 * 没人改任何代码的情况下飘红，而假红的代价是你开始不信任闸门。轮询到点之后仍由后面的
 * expect 判负，判别力没丢——实测把 mock 的 onstart 摘掉，5 条里 4 条红。
 */
async function until(cond: () => boolean, timeoutMs = 3000) {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

import { TTSManager, type TTSChunk } from "../tts-manager";

const chunks: TTSChunk[] = [
  { text: "第一段内容", index: 0, paragraphIndex: 0, paragraphIndices: [0], paragraphBreaks: [0] },
  { text: "第二段内容", index: 1, paragraphIndex: 1, paragraphIndices: [1], paragraphBreaks: [0] },
];

function makeCallbacks() {
  return {
    onPlay: vi.fn(),
    onEnd: vi.fn(),
    onStop: vi.fn(),
    onError: vi.fn(),
    onChunkStart: vi.fn(),
    onChunkEnd: vi.fn(),
  };
}

describe("TTSManager 状态机", () => {
  it("speak → stop → 再次 speak 能正常重新开始（修复：旧 onStop 不再重置新状态）", async () => {
    const manager = new TTSManager();
    manager.setEngine("webspeech");

    const cb1 = makeCallbacks();
    await manager.speak(chunks, cb1);
    await until(() => cb1.onPlay.mock.calls.length > 0);
    expect(cb1.onPlay).toHaveBeenCalled();
    expect(cb1.onStop).not.toHaveBeenCalled();

    // 停止
    manager.stop();
    expect(cb1.onStop).toHaveBeenCalled();
    await flush();

    // 再次 speak（模拟停止后重新点播放）
    const cb2 = makeCallbacks();
    await manager.speak(chunks, cb2);
    await until(() => cb2.onPlay.mock.calls.length > 0);
    expect(cb2.onPlay).toHaveBeenCalled();
    expect(cb2.onStop).not.toHaveBeenCalled();
    // 旧 callbacks 不应被再次触发
    expect(cb1.onPlay).toHaveBeenCalledTimes(1);
  });

  it("speak 中途 stop 后 onEnd 不应触发（避免自动翻章误触发）", async () => {
    const manager = new TTSManager();
    manager.setEngine("webspeech");

    const cb = makeCallbacks();
    const p = manager.speak(chunks, cb);
    await until(() => cb.onPlay.mock.calls.length > 0);
    expect(cb.onPlay).toHaveBeenCalled();

    manager.stop();
    await flush();
    expect(cb.onEnd).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
    await p;
  });

  it("播放完所有 chunk 后触发 onEnd（自动翻章基础）", async () => {
    const manager = new TTSManager();
    manager.setEngine("webspeech");

    const cb = makeCallbacks();
    const p = manager.speak(chunks, cb);
    await flush();

    // 模拟第一个 chunk 播放结束
    const u1 = speechState.utterances[0];
    speechState.speaking = false;
    u1.onend?.();
    // 下一个 chunk 的 utterance 要等新对象出现：cancel() 会清空数组，只看回调计数会读不到它
    await until(() => !!speechState.utterances[0] && speechState.utterances[0] !== u1);

    // 第二个 chunk 开始
    expect(cb.onChunkStart).toHaveBeenCalledTimes(2);
    const u2 = speechState.utterances[0];
    speechState.speaking = false;
    u2.onend?.();
    await until(() => cb.onEnd.mock.calls.length > 0);

    expect(cb.onEnd).toHaveBeenCalledTimes(1);
    await p;
  });

  it("自动翻章后 pendingAutoPlay 流程中再次 speak 正常（翻章竞态修复）", async () => {
    const manager = new TTSManager();
    manager.setEngine("webspeech");

    const cb = makeCallbacks();
    const p = manager.speak(chunks, cb);
    await until(() => !!speechState.utterances[0]);
    // 触发第一个 chunk 结束 → 自动播第二个
    const first = speechState.utterances[0];
    speechState.speaking = false;
    first.onend?.();
    await until(() => !!speechState.utterances[0] && speechState.utterances[0] !== first);
    // 触发第二个 chunk 结束 → onEnd
    const last = speechState.utterances[0];
    speechState.speaking = false;
    last.onend?.();
    await until(() => cb.onEnd.mock.calls.length > 0);
    expect(cb.onEnd).toHaveBeenCalledTimes(1);

    // 模拟自动翻章：新章节 speak（同一 manager，未 stop）
    const cb2 = makeCallbacks();
    const p2 = manager.speak(chunks, cb2);
    await until(() => cb2.onPlay.mock.calls.length > 0);
    expect(cb2.onPlay).toHaveBeenCalled();
    expect(cb2.onEnd).not.toHaveBeenCalled();
    await p;
    await p2;
  });

  it("setPlaybackRate 在 WebSpeech 播放中重新 speak（不触发旧回调）", async () => {
    const manager = new TTSManager();
    manager.setEngine("webspeech");

    const cb = makeCallbacks();
    const p = manager.speak(chunks, cb);
    await until(() => cb.onPlay.mock.calls.length >= 1);
    expect(cb.onPlay).toHaveBeenCalledTimes(1);

    manager.setPlaybackRate(1.5);
    await until(() => cb.onPlay.mock.calls.length >= 2);
    expect(cb.onPlay).toHaveBeenCalledTimes(2); // 重新 speak 又触发 onPlay
    expect(cb.onStop).not.toHaveBeenCalled(); // 不应触发 onStop
    await p;
  });
});
