/**
 * TTS 设置双引擎参数独立回归测试
 * 覆盖 M14 修复：Web Speech 与 ZipVoice 的 voiceId/speed/volume/pitch 独立存储，
 * 切换引擎互不影响；playbackRate（朗读栏倍速）为全局设置。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useTTSStore } from "../tts-store";

const KEY = "novel-reader-tts-settings";

function readPersisted(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(KEY) || "{}");
}

beforeEach(() => {
  localStorage.clear();
  useTTSStore.setState({
    engine: "webspeech",
    voiceId: "",
    speed: 1.0,
    volume: 1.0,
    pitch: 1.0,
    playbackRate: 1.0,
    autoNextChapter: true,
  });
});

describe("TTS 双引擎设置独立", () => {
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
});
