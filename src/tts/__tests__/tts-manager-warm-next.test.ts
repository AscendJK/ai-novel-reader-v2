/**
 * 章界预热：预生成的音频必须活到下一章、并且真的被下一章用上（T-章界 缓冲侧）
 *
 * 预热的全部价值在于"下一章开播时第一句已经在手里"。三件事缺一不可，各自一条判据：
 *   1) 结果要跨得过 `speak()` 开场那轮清理（`tts-manager.ts:1086` 会 clearPrefetch）；
 *   2) 下一章不许把它再推一遍（否则章界没省到钱，还多花一份）；
 *   3) 音色/语速变了就不认（否则同一章里混着两套声音或两套语速播）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TTSManager, type TTSChunk } from "../tts-manager";

type Gate = { text: string; speed: number; voiceUsed?: string; resolve: (s: Float32Array) => void };
const gates: Gate[] = [];
const doneLog: { text: string; speed: number }[] = [];

vi.mock("../zipvoice-engine", () => ({
  isModelLoaded: () => true,
  loadModel: vi.fn(async () => {}),
  resetWorker: vi.fn(),
  generateAudio: vi.fn((text: string, opts: { speed: number }, onChunk: (d: Float32Array) => void) =>
    new Promise<void>((resolve) => {
      gates.push({ text, speed: opts.speed, resolve: (samples) => { onChunk(samples); resolve(); } });
    })
  ),
}));

vi.mock("../server-engine", () => ({
  cancelServerInference: vi.fn(async () => {}),
  synthesizeServer: vi.fn(async () => { throw new Error("本用例不使用服务端推理"); }),
  ServerInferenceTimeoutError: class ServerInferenceTimeoutError extends Error {},
}));

const globalAny = globalThis as Record<string, unknown>;

class MockSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fired = false;
  connect() { /* noop */ }
  private fire() { if (this.fired) return; this.fired = true; this.onended?.(); }
  start() { this.timer = setTimeout(() => this.fire(), 120); }
  stop() { if (this.timer) clearTimeout(this.timer); setTimeout(() => this.fire(), 0); }
}

globalAny.AudioContext = class {
  currentTime = 0;
  state = "running" as const;
  destination = {};
  createBuffer() {
    return {
      duration: 1, length: 24000, sampleRate: 24000, numberOfChannels: 1,
      copyToChannel() { /* noop */ },
      getChannelData: () => new Float32Array(24000),
    };
  }
  createBufferSource() { return new MockSource(); }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
};

const chunk = (text: string, i: number): TTSChunk => ({
  text, index: i, paragraphIndex: i, paragraphIndices: [i], paragraphBreaks: [0],
});
const CH1 = [chunk("第一章的最后一句，渡口那条船等了半月没人下来。", 0)];
const CH2 = [
  chunk("第二章第一句，虎牢关的鼓声一夜未停。", 0),
  chunk("第二章第二句，探马第三次回报敌军尚在三十里外。", 1),
  chunk("第二章第三句，守将把盔缨系了两遍又松开。", 2),
];

const flush = (ms: number) => new Promise(r => setTimeout(r, ms));
const releaseAll = (text: string) => {
  for (const g of gates.filter(x => x.text === text)) {
    gates.splice(gates.indexOf(g), 1);
    doneLog.push({ text: g.text, speed: g.speed });
    g.resolve(new Float32Array(24000));
  }
};
/** 某句正文一共被送去推理过几次（在飞 + 已完成）——判"重复花钱"就用它 */
const attemptsOf = (text: string) =>
  gates.filter(g => g.text === text).length + doneLog.filter(g => g.text === text).length;

function makeManager(prefetchCount = 2) {
  const manager = new TTSManager();
  manager.setEngine("zipvoice");
  manager.setPrefetchCount(prefetchCount);
  return manager;
}
const cb = () => ({ onPlay: vi.fn(), onEnd: vi.fn(), onError: vi.fn(), onChunkStart: vi.fn(), onChunkEnd: vi.fn() });

beforeEach(() => {
  gates.length = 0;
  doneLog.length = 0;
  vi.clearAllMocks();
});

describe("章末预生成的音频", () => {
  it("要活到下一章：下一章开播时不许再推一遍，第一句也不该等生成", async () => {
    const manager = makeManager(2);
    const first = cb();
    const chainA = manager.speak(CH1, first).catch(() => {});
    await flush(20);
    expect(gates.map(g => g.text)).toEqual([CH1[0].text]);

    // 本章最后一句正在播 → 预热下一章开头
    manager.warmAhead(CH2);
    await flush(20);
    expect(gates.map(g => g.text)).toContain(CH2[0].text);

    releaseAll(CH1[0].text);
    releaseAll(CH2[0].text);
    releaseAll(CH2[1].text);
    await flush(400);   // 第一章播完（onEnd 之后 speak() 会清池）

    const second = cb();
    const chainB = manager.speak(CH2, second).catch(() => {});
    await flush(250);

    expect(attemptsOf(CH2[0].text), "预热过的句子在章界又被推了一遍 —— 章界没省下时间，钱还多花一份").toBe(1);
    expect(attemptsOf(CH2[1].text), "预热过的句子在章界又被推了一遍").toBe(1);
    expect(second.onPlay, "预热的音频没被下一章用上：章界仍在等冷启动生成").toHaveBeenCalled();

    manager.stop();
    await chainA;
    await chainB;
    manager.destroy();
  }, 20000);

  it("段数上限跟着当前引擎的预生成段数走，不许把整章推进缓冲", async () => {
    const manager = makeManager(2);
    const first = cb();
    const chainA = manager.speak(CH1, first).catch(() => {});
    await flush(20);
    manager.warmAhead(CH2);
    await flush(20);
    const warmed = gates.map(g => g.text).filter(t => t !== CH1[0].text);
    expect(warmed).toEqual([CH2[0].text, CH2[1].text]);
    expect(warmed).not.toContain(CH2[2].text);
    manager.stop();
    await chainA;
    manager.destroy();
  }, 20000);

  it("换了音色就不认：预热的音频不能拿错声音播给下一章", async () => {
    const manager = makeManager(2);
    const first = cb();
    const chainA = manager.speak(CH1, first).catch(() => {});
    await flush(20);
    manager.warmAhead(CH2);
    await flush(20);
    releaseAll(CH1[0].text);
    releaseAll(CH2[0].text);
    releaseAll(CH2[1].text);
    await flush(300);

    manager.setVoice("46");                     // 用户在章界前改了音色
    const second = cb();
    const chainB = manager.speak(CH2, second).catch(() => {});
    await flush(250);

    expect(attemptsOf(CH2[0].text), "旧音色的预热被新音色用上了 —— 下一章会用错声音开口").toBeGreaterThanOrEqual(2);
    manager.stop();
    await chainA;
    await chainB;
    manager.destroy();
  }, 20000);

  it("改了语速/倍速就不认：同一章里不许混着两套语速", async () => {
    const manager = makeManager(2);
    const first = cb();
    const chainA = manager.speak(CH1, first).catch(() => {});
    await flush(20);
    manager.warmAhead(CH2);
    await flush(20);
    releaseAll(CH1[0].text);
    releaseAll(CH2[0].text);
    releaseAll(CH2[1].text);
    await flush(300);

    manager.setSpeed(1.3);
    const second = cb();
    const chainB = manager.speak(CH2, second).catch(() => {});
    await flush(250);

    expect(attemptsOf(CH2[0].text), "旧语速的预热被新语速用上了").toBeGreaterThanOrEqual(2);
    manager.stop();
    await chainA;
    await chainB;
    manager.destroy();
  }, 20000);

  it("停止之前已经推好的预热，重启同一章时还得用上（丢了就是白花钱）", async () => {
    const manager = makeManager(2);
    const first = cb();
    const chainA = manager.speak(CH1, first).catch(() => {});
    await flush(20);
    manager.warmAhead(CH2);
    await flush(20);
    releaseAll(CH2[0].text);   // 预热在停止之前就落好了
    releaseAll(CH2[1].text);
    await flush(60);
    manager.stop();            // 用户中途关掉朗读
    await flush(60);
    expect(first.onEnd, "停止不该被当成播完").not.toHaveBeenCalled();

    // 他马上又点开播：那两段是同一音色、同一语速的有效音频，没理由重推一遍
    releaseAll(CH1[0].text);
    const second = cb();
    const chainB = manager.speak(CH2, second).catch(() => {});
    await flush(250);
    expect(attemptsOf(CH2[0].text), "停止把已落好的预热一起丢了 —— 下一章开头又冷启动一遍，那份钱白扔").toBe(1);

    manager.stop();
    await chainA;
    await chainB;
    manager.destroy();
  }, 20000);
});
