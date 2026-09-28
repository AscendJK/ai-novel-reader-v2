import { describe, it, expect, afterEach, vi } from "vitest";
import { ZipVoiceTTSEngine, TTSManager } from "../tts-manager";

/**
 * 运行时那一行的"进度线索"契约（真机自检的现场行全靠它）。
 *
 * 为什么单开一档：09-28 用一次性台架把页面 JS 停住 30 秒量过一次——导出的现场行里
 * 音频侧只有 `ctx=running` 这种**状态字符串**，没有任何秒数。于是"停摆期间到底还有没有
 * 出声"在报告里判不了：我自己在页面外挂一只 AudioContext 才读到"那 30 秒音频走了 36.12 秒"。
 * 这一档把那个数字钉进产品：现场行必须带一枚**单调的音频时钟**，而且两档引擎各有各的来源。
 *
 * 夹具的规矩（同一族坑踩过两次）：两个候选值必须不一样，否则"读错字段/写死一个数"当场 0 红。
 *
 * 刀账：
 * - Z7 摘掉音频秒表（`clock` 写成空串）→ 红 2（取数那一条 + 「没有上下文要明说」那一条）
 * - Z8 读错字段（`ctx.currentTime` → `this.startedAt`，段起点在停摆期间不前进）→ 红 1
 * - Z9 `describeRuntime` 不按引擎分（退回"没有 Kokoro 实例"那一支）→ 红 3（系统语音那一档三条全红）
 */

function pokeClock(engine: ZipVoiceTTSEngine, currentTime: number, state: AudioContextState = "running") {
  (engine as unknown as { audioContext: { currentTime: number; state: AudioContextState } | null })
    .audioContext = { currentTime, state };
}

describe("Kokoro 那一档（服务端推理 / 浏览器推理）：音频侧要带秒表", () => {
  afterEach(() => vi.restoreAllMocks());

  it("秒表取的就是 AudioContext.currentTime，两个不同值都要跟着变", () => {
    const e = new ZipVoiceTTSEngine();
    pokeClock(e, 12.34);
    expect(e.describeAudio()).toContain("音频秒表=12.3s");
    pokeClock(e, 99.91);
    expect(e.describeAudio()).toContain("音频秒表=99.9s");
  });

  it("还没建音频上下文时不许写 0——要写明没有时钟（0 会被读成「一秒都没走」）", () => {
    const e = new ZipVoiceTTSEngine();
    const line = e.describeAudio();
    expect(line).toContain("音频秒表=没有音频上下文");
    expect(line).not.toMatch(/音频秒表=0/);
    expect(line).toContain("ctx=(未创建)");
  });

  it("原有那几格一个都不许丢（暂停链的判定还要靠它们）", () => {
    const e = new ZipVoiceTTSEngine();
    pokeClock(e, 5);
    const line = e.describeAudio();
    for (const key of ["ctx=", "paused=", "pauseRequested=", "source=", "buffer=", "pendingResolve=", "stopped="]) {
      expect(line, `音频侧少了 ${key} 这一格`).toContain(key);
    }
  });
});

describe("系统语音那一档：没有 AudioContext，进度只能靠边界计数与已播秒", () => {
  const realSpeech = Object.getOwnPropertyDescriptor(globalThis, "speechSynthesis");
  afterEach(() => {
    if (realSpeech) Object.defineProperty(globalThis, "speechSynthesis", realSpeech);
    else delete (globalThis as unknown as { speechSynthesis?: unknown }).speechSynthesis;
  });

  function withSpeech(speaking: boolean) {
    Object.defineProperty(globalThis, "speechSynthesis", {
      configurable: true,
      value: { speaking, paused: false, pending: false, getVoices: () => [], cancel: () => {}, speak: () => {}, addEventListener: () => {} },
    });
  }

  it("这一档的运行时行里要看得见边界计数与已播秒（服务端那两枚在这里根本不存在）", () => {
    withSpeech(true);
    const m = new TTSManager();
    m.setEngine("webspeech");
    const inner = (m as unknown as { webSpeech: { boundaryEventCount: number; chunkStartTime: number; available: boolean } }).webSpeech;
    inner.available = true;
    inner.boundaryEventCount = 7;
    inner.chunkStartTime = 1_000;
    vi.spyOn(performance, "now").mockReturnValue(13_400);

    const line = m.describeRuntime();
    expect(line).toContain("boundary=7");
    expect(line).toContain("已播=12.4s");
    expect(line, "这一档不该出现 Kokoro 的音频侧，否则读的人以为在看另一条链").not.toContain("无 Kokoro 实例");
  });

  it("边界计数要跟着走：换一个数就得换一个读数（写死会被这条抓住）", () => {
    withSpeech(true);
    const m = new TTSManager();
    m.setEngine("webspeech");
    const inner = (m as unknown as { webSpeech: { boundaryEventCount: number; chunkStartTime: number; available: boolean } }).webSpeech;
    inner.available = true;
    vi.spyOn(performance, "now").mockReturnValue(2_000);
    inner.boundaryEventCount = 3;
    inner.chunkStartTime = 1_000;
    expect(m.describeRuntime()).toContain("boundary=3");
    inner.boundaryEventCount = 41;
    expect(m.describeRuntime()).toContain("boundary=41");
  });

  it("这台设备没有系统语音时那一行要说不支持，不许混成「计数为 0」那种像还在读的样子", () => {
    delete (globalThis as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    const m = new TTSManager();
    m.setEngine("webspeech");
    const line = m.describeRuntime();
    expect(line).toContain("这档不支持");
    expect(line).not.toMatch(/已播=\d/);
  });
});
