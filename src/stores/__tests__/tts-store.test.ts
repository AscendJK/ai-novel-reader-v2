/**
 * TTS 设置三引擎参数独立回归测试
 * 覆盖 M14 修复扩展：server（服务端推理）/ zipvoice（浏览器推理）/ webspeech（浏览器内置）
 * 三者的 voiceId/speed/volume/pitch/chunkSize 完全独立存储，切换引擎互不影响；
 * playbackRate（朗读栏倍速）为全局设置。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useTTSStore, __resetTTSSettingsCache } from "../tts-store";

const KEY = "novel-reader-tts-settings";

function readPersisted(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(KEY) || "{}");
}

beforeEach(() => {
  localStorage.clear();
  __resetTTSSettingsCache(); // 重置模块级缓存，保证每个测试从干净状态开始
  useTTSStore.setState({
    engine: "webspeech",
    voiceId: "",
    speed: 1.0,
    volume: 1.0,
    pitch: 1.0,
    chunkSize: 300,
    playbackRate: 1.0,
    autoNextChapter: true,
  });
});

describe("TTS 三引擎设置独立", () => {
  it("ZipVoice 调整语速/音调/音色后，切回 Web Speech 参数不受影响", () => {
    const s = useTTSStore.getState();

    // 默认 Web Speech
    expect(s.engine).toBe("webspeech");
    expect(s.speed).toBe(1.0);

    // 切到 ZipVoice，调整参数
    s.setEngine("zipvoice");
    s.setSpeed(2.5);
    s.setPitch(1.5);
    s.setVoiceId("3");

    expect(useTTSStore.getState().speed).toBe(2.5);
    expect(useTTSStore.getState().pitch).toBe(1.5);
    expect(useTTSStore.getState().voiceId).toBe("3");

    // 切回 Web Speech：参数必须是 Web Speech 自己的（1.0），而不是 ZipVoice 的 2.5
    s.setEngine("webspeech");
    expect(useTTSStore.getState().speed).toBe(1.0);
    expect(useTTSStore.getState().pitch).toBe(1.0);
    expect(useTTSStore.getState().voiceId).toBe("");

    // 调整 Web Speech 语速
    s.setSpeed(0.75);

    // 再切回 ZipVoice：ZipVoice 的 2.5 应被保留（不被 Web Speech 覆盖）
    s.setEngine("zipvoice");
    expect(useTTSStore.getState().speed).toBe(2.5);
    expect(useTTSStore.getState().pitch).toBe(1.5);
    expect(useTTSStore.getState().voiceId).toBe("3");
  });

  it("持久化：两个引擎的语速/音调/音色分开存储", () => {
    const s = useTTSStore.getState();
    s.setEngine("zipvoice");
    s.setSpeed(2.0);
    s.setPitch(1.4);
    s.setVoiceId("5");
    s.setEngine("webspeech");
    s.setSpeed(1.25);
    s.setPitch(1.1);
    s.setVoiceId("zh-voice-1");

    const p = readPersisted();
    expect(p.zipvoiceSpeed).toBe(2.0);
    expect(p.webspeechSpeed).toBe(1.25);
    expect(p.zipvoicePitch).toBe(1.4);
    expect(p.webspeechPitch).toBe(1.1);
    expect(p.zipvoiceVoiceId).toBe("5");
    expect(p.webspeechVoiceId).toBe("zh-voice-1");
  });

  it("播放倍速为全局设置，不随引擎切换", () => {
    const s = useTTSStore.getState();
    s.setPlaybackRate(1.5);
    s.setEngine("zipvoice");
    s.setSpeed(2.0);
    s.setEngine("webspeech");
    // playbackRate 是朗读栏全局倍速，切换引擎不应重置
    expect(useTTSStore.getState().playbackRate).toBe(1.5);
    expect(readPersisted().playbackRate).toBe(1.5);
  });

  it("服务端推理参数独立：调整后切其他引擎不受影响", () => {
    const s = useTTSStore.getState();

    s.setEngine("server");
    expect(useTTSStore.getState().voiceId).toBe("45"); // server 默认 Kokoro 女声
    s.setSpeed(2.5);
    s.setPitch(1.3);
    s.setVolume(0.6);
    s.setVoiceId("52"); // 男声云扬
    s.setChunkSize(200);

    expect(useTTSStore.getState().speed).toBe(2.5);
    expect(useTTSStore.getState().voiceId).toBe("52");
    expect(useTTSStore.getState().chunkSize).toBe(200);

    // 切到浏览器推理：载入 zipvoice 自己的参数（默认 1.0/45/60）
    s.setEngine("zipvoice");
    expect(useTTSStore.getState().speed).toBe(1.0);
    expect(useTTSStore.getState().voiceId).toBe("45");
    expect(useTTSStore.getState().chunkSize).toBe(60);

    // 调整 zipvoice 参数
    s.setSpeed(1.8);
    s.setVoiceId("47");
    s.setChunkSize(90);

    // 切回 server：server 的 2.5/52/200 必须被保留
    s.setEngine("server");
    expect(useTTSStore.getState().speed).toBe(2.5);
    expect(useTTSStore.getState().voiceId).toBe("52");
    expect(useTTSStore.getState().volume).toBe(0.6);
    expect(useTTSStore.getState().chunkSize).toBe(200);

    // 再切回 zipvoice：zipvoice 的 1.8/47/90 保留
    s.setEngine("zipvoice");
    expect(useTTSStore.getState().speed).toBe(1.8);
    expect(useTTSStore.getState().voiceId).toBe("47");
    expect(useTTSStore.getState().chunkSize).toBe(90);
  });

  it("持久化：三个引擎的语速/音色/分块大小分开存储", () => {
    const s = useTTSStore.getState();

    s.setEngine("server");
    s.setSpeed(2.0);
    s.setVoiceId("49");
    s.setChunkSize(180);

    s.setEngine("zipvoice");
    s.setSpeed(1.5);
    s.setVoiceId("46");
    s.setChunkSize(70);

    s.setEngine("webspeech");
    s.setSpeed(1.25);
    s.setVoiceId("zh-voice-1");

    const p = readPersisted();
    expect(p.serverSpeed).toBe(2.0);
    expect(p.serverVoiceId).toBe("49");
    expect(p.serverChunkSize).toBe(180);
    expect(p.zipvoiceSpeed).toBe(1.5);
    expect(p.zipvoiceVoiceId).toBe("46");
    expect(p.zipvoiceChunkSize).toBe(70);
    expect(p.webspeechSpeed).toBe(1.25);
    expect(p.webspeechVoiceId).toBe("zh-voice-1");
    expect(p.webspeechChunkSize).toBe(300);
  });

  it("预生成段数按引擎独立，Worker 数仅浏览器推理生效", () => {
    const s = useTTSStore.getState();
    // zipvoice：默认预生成 3 段、1 worker
    s.setEngine("zipvoice");
    expect(useTTSStore.getState().prefetchCount).toBe(3);
    expect(useTTSStore.getState().workerCount).toBe(1);

    // 调整 zipvoice 预生成段数 + worker 数
    s.setPrefetchCount(6);
    s.setWorkerCount(2);
    expect(useTTSStore.getState().prefetchCount).toBe(6);
    expect(useTTSStore.getState().workerCount).toBe(2);
    expect(readPersisted().zipvoicePrefetchCount).toBe(6);
    expect(readPersisted().zipvoiceWorkerCount).toBe(2);

    // 切到 server：prefetchCount 是 server 自己的（默认 2）
    s.setEngine("server");
    expect(useTTSStore.getState().prefetchCount).toBe(2);

    // 切回 zipvoice：6 段 / 2 worker 保留
    s.setEngine("zipvoice");
    expect(useTTSStore.getState().prefetchCount).toBe(6);
    expect(useTTSStore.getState().workerCount).toBe(2);

    // 越界 clamp
    s.setPrefetchCount(99);
    expect(useTTSStore.getState().prefetchCount).toBe(10);
    s.setWorkerCount(0);
    expect(useTTSStore.getState().workerCount).toBe(1);
  });
});
