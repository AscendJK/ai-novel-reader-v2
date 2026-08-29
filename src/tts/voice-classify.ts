/**
 * WebSpeech 语音分类工具
 * 设置页语音选择：先按语言分组（中文优先），再按是否需要网络细分。
 * 纯函数，无副作用，便于单元测试。
 */

export type VoiceNetworkTag = "local" | "online" | "unknown";

export interface VoiceNetworkGroup {
  tag: VoiceNetworkTag;
  /** optgroup 标签，如 "🔌 本地（离线可用）" */
  label: string;
  voices: SpeechSynthesisVoice[];
}

export interface VoiceLanguageGroup {
  /** 语言主码，如 "zh"、"en" */
  lang: string;
  /** 语言显示名，如 "中文"、"英语" */
  label: string;
  /** 网络细分分组（本地 → 在线 → 未知），至少一个 */
  groups: VoiceNetworkGroup[];
  voiceCount: number;
}

/** 网络状态标签（含 emoji，optgroup 分组名用） */
export const NETWORK_LABELS: Record<VoiceNetworkTag, string> = {
  local: "🔌 本地（离线可用）",
  online: "🌐 在线（需联网）",
  unknown: "⚠️ 联网状态未知",
};

/** 常用语言白名单（除中文外），按此顺序排列 */
const COMMON_LANGS = ["en", "ja", "ko"];

/** 网络分组展示顺序 */
const NETWORK_ORDER: VoiceNetworkTag[] = ["local", "online", "unknown"];

/**
 * 获取语言中文显示名。
 * 优先用 Intl.DisplayNames（Chrome 81+/Safari 14+），不支持时回退 lang 原始代码。
 */
export function getLanguageLabel(lang: string): string {
  try {
    const display = new Intl.DisplayNames(["zh"], { type: "language" });
    const name = display.of(lang);
    return name || lang;
  } catch {
    return lang;
  }
}

/**
 * 网络状态映射：
 * - localService === true  → 本地（离线可用）
 * - localService === false → 在线（需联网）
 * - 其余（undefined）     → 未知（浏览器不提供该属性，不瞎猜）
 */
export function getNetworkTag(voice: SpeechSynthesisVoice): VoiceNetworkTag {
  if (voice.localService === true) return "local";
  if (voice.localService === false) return "online";
  return "unknown";
}

/** 语言主码：zh-CN → zh（小写） */
function langPrimary(lang: string): string {
  return (lang || "").split("-")[0].trim().toLowerCase();
}

/** 语言排序键：中文最前 → 常用语言 → 其他按代码 */
function langSortKey(code: string): [number, number, string] {
  if (code === "zh") return [0, 0, ""];
  const i = COMMON_LANGS.indexOf(code);
  if (i >= 0) return [1, i, ""];
  return [2, 0, code];
}

/**
 * 分类语音列表：
 * 1. 按 voiceURI 去重（同 URI 只保留一个）
 * 2. 按语言主码分组
 * 3. 语言排序：中文 → en/ja/ko → 其他
 * 4. 每组内按网络细分：本地 → 在线 → 未知
 */
export function classifyVoices(voices: SpeechSynthesisVoice[]): VoiceLanguageGroup[] {
  // 去重（同 voiceURI）
  const seen = new Set<string>();
  const uniq = voices.filter(v => {
    const key = v.voiceURI || v.name || "";
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 按语言主码分组
  const byLang = new Map<string, SpeechSynthesisVoice[]>();
  for (const v of uniq) {
    const code = langPrimary(v.lang);
    if (!code) continue;
    const list = byLang.get(code);
    if (list) list.push(v);
    else byLang.set(code, [v]);
  }

  // 语言排序：中文 → 常用 → 其他
  const codes = [...byLang.keys()].sort((a, b) => {
    const [ka1, ka2, ka3] = langSortKey(a);
    const [kb1, kb2, kb3] = langSortKey(b);
    if (ka1 !== kb1) return ka1 - kb1;
    if (ka2 !== kb2) return ka2 - kb2;
    return ka3.localeCompare(kb3);
  });

  return codes.map(code => {
    const voicesInLang = byLang.get(code)!;
    const groups: VoiceNetworkGroup[] = NETWORK_ORDER
      .map(tag => ({
        tag,
        label: NETWORK_LABELS[tag],
        voices: voicesInLang.filter(v => getNetworkTag(v) === tag),
      }))
      .filter(g => g.voices.length > 0);
    return {
      lang: code,
      label: getLanguageLabel(code),
      groups,
      voiceCount: voicesInLang.length,
    };
  });
}
