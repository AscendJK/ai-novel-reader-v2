/**
 * 缓冲池跨代次与参数变更回归测试（批次 5d：R-46 / R-49a）
 *
 * R-46：预生成在途标记原来是跨代次共享的 Set。新一轮遇到旧一轮残留的同段任务时，
 *       要么把标记抹掉、要么把自己挂到那个永远不会有可用产出的任务上等结果——
 *       表现为朗读停在"正在生成"里不动。改为按代次归属：不认别人家的在途标记。
 * R-49a：暂停中/生成间隙改倍速，旧代码只在"正在播放"时处理，池里旧语速的音频
 *       原封不动 → 同一章混着两套语速播完。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TTSManager, type TTSChunk } from "../tts-manager";

type Gate = { text: string; speed: number; resolve: (samples: Float32Array) => void };
const gates: Gate[] = [];
const doneLog: { text: string; speed: number }[] = [];

vi.mock("../zipvoice-engine", () => ({
  isModelLoaded: () => true,
  loadModel: vi.fn(async () => {}),
  resetWorker: vi.fn(),
  // 不放行就永远不返回：用它模拟"旧一轮卡住的在飞任务"
  generateAudio: vi.fn((text: string, opts: { speed: number }, onChunk: (d: Float32Array) => void) =>
    new Promise<void>((resolve) => {
      gates.push({ text, speed: opts.speed, resolve: (samples) => { onChunk(samples); resolve(); } });
    })
  ),
}));

// 本文件的用例走浏览器推理；server-engine 只提供 onError 可重试判定所需的错误类
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
  start() { this.timer = setTimeout(() => this.fire(), 200); }
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

const TEXTS = ["第一段内容", "第二段内容", "第三段内容"];
const chunks: TTSChunk[] = TEXTS.map((text, i) => ({
  text, index: i, paragraphIndex: i, paragraphIndices: [i], paragraphBreaks: [0],
}));

const flush = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 放行某段文本的全部在飞生成 */
function releaseAll(text: string): number {
  const matching = gates.filter(g => g.text === text);
  for (const g of matching) {
    const i = gates.indexOf(g);
    if (i >= 0) gates.splice(i, 1);
    doneLog.push({ text: g.text, speed: g.speed });
    g.resolve(new Float32Array(24000));
  }
  return matching.length;
}

function pending(text: string): Gate | undefined {
  return gates.find(g => g.text === text);
}

function makeCallbacks() {
  const bufferLevels: number[] = [];
  return {
    bufferLevels,
    cb: {
      onPlay: vi.fn(),
      onEnd: vi.fn(),
      onError: vi.fn(),
      onChunkStart: vi.fn(),
      onChunkEnd: vi.fn(),
      onBufferChange: (n: number) => { bufferLevels.push(n); },
    },
  };
}

beforeEach(() => {
  gates.length = 0;
  doneLog.length = 0;
  vi.clearAllMocks();
});

describe("R-46 预生成在途标记的代次归属", () => {
  it("旧一轮迟到的预生成不抹掉新一轮的标记、不提前叫醒它的等待", async () => {
    const manager = new TTSManager();
    manager.setEngine("zipvoice");
    manager.setPrefetchCount(2);
    const { cb } = makeCallbacks();
    const chain = manager.speak(chunks, cb).catch(() => {});

    await flush(20);
    expect(gates.map(g => g.text)).toEqual(["第一段内容", "第二段内容"]);
    releaseAll("第一段内容");
    releaseAll("第二段内容");

    // prepareBuffers 以 100ms 轮询收尾 → 给足时间让开播与滚动预生成落地
    await flush(300);
    const staleThird = pending("第三段内容");         // 旧一轮（A）为第三段提交的预生成
    expect(staleThird).toBeDefined();

    // 跳回第一段：换代清池。A 的在飞任务此后不会再有可用产出（结果按代次丢弃），
    // 但它的收尾动作仍会触碰共享的在途标记表
    manager.seekToChunk(0);
    await flush(30);
    releaseAll("第一段内容");
    await flush(150);
    releaseAll("第二段内容");

    // 等新一轮真的推进到第三段（挂在自家预生成上、或已在现场生成都算到位），
    // 这样 A 那份迟到任务的收尾才正好落在"新一轮正在等"的窗口里
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !cb.onChunkStart.mock.calls.some(([i]) => i === 2)) {
      await flush(50);
    }
    expect(cb.onChunkStart.mock.calls.some(([i]) => i === 2)).toBe(true);

    // 关键时点：只放行 A 那份迟到的第三段，其余仍在飞。旧实现会无条件删标记并
    // 叫醒该段所有等待者 → 新一轮被提前叫醒、发现缓冲是空的，于是再现场生成一遍
    const attemptsBefore = doneLog.filter(g => g.text === "第三段内容").length
      + gates.filter(g => g.text === "第三段内容").length;
    const staleIdx = gates.indexOf(staleThird as Gate);
    if (staleIdx >= 0) gates.splice(staleIdx, 1);
    doneLog.push({ text: staleThird!.text, speed: staleThird!.speed });
    staleThird!.resolve(new Float32Array(24000));
    await flush(500);

    const thirdAttempts = doneLog.filter(g => g.text === "第三段内容").length
      + gates.filter(g => g.text === "第三段内容").length;
    // 放行 A 的任务不该新增任何一份生成：A 的作废任务 + 新一轮自己的那一份
    expect(thirdAttempts).toBeLessThanOrEqual(attemptsBefore);
    expect(cb.onError).not.toHaveBeenCalled();

    releaseAll("第一段内容");
    releaseAll("第二段内容");
    releaseAll("第三段内容");
    manager.stop();
    await chain;
    manager.destroy();
  }, 20000);
});

describe("R-49a 生成参数变更时的缓冲池", () => {
  it("暂停中改倍速：旧语速缓冲作废且不落池，恢复后按新语速重新生成", async () => {
    const manager = new TTSManager();
    manager.setEngine("zipvoice");
    manager.setPrefetchCount(2);
    const { bufferLevels, cb } = makeCallbacks();
    const chain = manager.speak(chunks, cb).catch(() => {});

    await flush(20);
    expect(gates.map(g => g.text)).toEqual(["第一段内容", "第二段内容"]);
    releaseAll("第一段内容");
    releaseAll("第二段内容");
    await flush(300);                     // 预生成轮询 → 第一段开播 → 第三段在飞
    expect(pending("第三段内容")).toBeDefined();

    manager.pause();
    await flush(20);
    manager.setPlaybackRate(1.5);         // 暂停中改倍速（旧代码此处什么都不做）
    await flush(20);
    expect(bufferLevels[bufferLevels.length - 1]).toBe(0);   // 池已作废

    releaseAll("第三段内容");             // 旧语速的在飞任务迟到
    await flush(60);
    expect(bufferLevels[bufferLevels.length - 1]).toBe(0);   // 不得再落池

    expect(await manager.resume()).toBe(true);
    await flush(400);
    // 恢复后按新语速（1.0 × 1.5）重新生成
    const speeds = [...gates.map(g => g.speed), ...doneLog.map(g => g.speed)];
    expect(speeds.some(s => Math.abs(s - 1.5) < 0.01)).toBe(true);

    releaseAll("第一段内容");
    releaseAll("第二段内容");
    releaseAll("第三段内容");
    manager.stop();
    await chain;
    manager.destroy();
  }, 20000);
});
