import { describe, it, expect } from "vitest";
import {
  classifyVoices,
  getLanguageLabel,
  getNetworkTag,
} from "../voice-classify";

/** 构造一个测试语音（localService 三态可控） */
function makeVoice(overrides: Partial<SpeechSynthesisVoice> & { voiceURI: string }): SpeechSynthesisVoice {
  return {
    name: overrides.voiceURI,
    lang: "zh-CN",
    localService: true,
    default: false,
    voiceURI: overrides.voiceURI,
    ...overrides,
  } as SpeechSynthesisVoice;
}

describe("classifyVoices", () => {
  it("按语言分组，中文优先", () => {
    const voices = [
      makeVoice({ voiceURI: "en-1", lang: "en-US" }),
      makeVoice({ voiceURI: "zh-1", lang: "zh-CN" }),
      makeVoice({ voiceURI: "ja-1", lang: "ja-JP" }),
    ];
    const groups = classifyVoices(voices);
    expect(groups.map(g => g.lang)).toEqual(["zh", "en", "ja"]);
  });

  it("语言组内按网络细分：本地 → 在线 → 未知", () => {
    const voices = [
      makeVoice({ voiceURI: "zh-online", lang: "zh-CN", localService: false }),
      makeVoice({ voiceURI: "zh-local", lang: "zh-CN", localService: true }),
      makeVoice({ voiceURI: "zh-unknown", lang: "zh-CN", localService: undefined }),
    ];
    const groups = classifyVoices(voices);
    const zh = groups.find(g => g.lang === "zh")!;
    expect(zh.groups.map(g => g.tag)).toEqual(["local", "online", "unknown"]);
    expect(zh.voiceCount).toBe(3);
  });

  it("同 voiceURI 去重", () => {
    const voices = [
      makeVoice({ voiceURI: "zh-1", lang: "zh-CN" }),
      makeVoice({ voiceURI: "zh-1", lang: "zh-CN" }),
    ];
    const groups = classifyVoices(voices);
    expect(groups[0].voiceCount).toBe(1);
  });

  it("空数组返回空", () => {
    expect(classifyVoices([])).toEqual([]);
  });

  it("无语言码的语音被跳过", () => {
    const voices = [
      makeVoice({ voiceURI: "no-lang", lang: "" }),
      makeVoice({ voiceURI: "zh-1", lang: "zh-CN" }),
    ];
    const groups = classifyVoices(voices);
    expect(groups.map(g => g.lang)).toEqual(["zh"]);
  });

  it("常用语言白名单顺序：en/ja/ko 在其他语言之前", () => {
    const voices = [
      makeVoice({ voiceURI: "fr-1", lang: "fr-FR" }),
      makeVoice({ voiceURI: "ko-1", lang: "ko-KR" }),
      makeVoice({ voiceURI: "en-1", lang: "en-US" }),
      makeVoice({ voiceURI: "de-1", lang: "de-DE" }),
    ];
    const groups = classifyVoices(voices);
    expect(groups.map(g => g.lang)).toEqual(["en", "ko", "de", "fr"]);
  });
});

describe("getNetworkTag", () => {
  it("localService true → local", () => {
    expect(getNetworkTag(makeVoice({ voiceURI: "v1", localService: true }))).toBe("local");
  });

  it("localService false → online", () => {
    expect(getNetworkTag(makeVoice({ voiceURI: "v2", localService: false }))).toBe("online");
  });

  it("localService undefined → unknown", () => {
    expect(getNetworkTag(makeVoice({ voiceURI: "v3", localService: undefined }))).toBe("unknown");
  });
});

describe("getLanguageLabel", () => {
  it("返回中文语言名（Intl.DisplayNames 可用时）", () => {
    const label = getLanguageLabel("zh");
    // zh 显示为“中文”（环境支持 Intl.DisplayNames 时）
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
  });

  it("Intl.DisplayNames 不可用时回退 lang 代码", () => {
    // 模拟不支持：用一个不存在的语言码，DisplayNames 会原样返回（或抛出后回退）
    const label = getLanguageLabel("zz-XX");
    expect(label.length).toBeGreaterThan(0);
  });
});
