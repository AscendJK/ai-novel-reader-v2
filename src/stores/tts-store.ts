/**
 * TTS Zustand Store
 * 管理 TTS 播放状态、设置、模型状态
 */

import { create } from "zustand";
import type { TTSCapability } from "@/tts/capability";

export interface TTSState {
  // ── 播放状态 ──
  /** 是否正在播放 */
  playing: boolean;
  /** 是否暂停（区别于停止） */
  paused: boolean;
  /** 当前播放的小说 ID */
  currentNovelId: string | null;
  /** 当前播放的章节索引 */
  currentChapterIndex: number | null;
  /** 当前播放位置（秒） */
  currentTime: number;
  /** 总时长（秒） */
  duration: number;
  /** 当前生成/播放的段落索引 */
  currentParagraph: number;
  /** 总段落数 */
  totalParagraphs: number;

  // ── 生成状态 ──
  /** 是否正在生成音频 */
  generating: boolean;
  /** 生成进度 0-100 */
  generateProgress: number;

  // ── 模型状态 ──
  /** 模型是否已下载 */
  modelDownloaded: boolean;
  /** 模型是否正在下载 */
  modelDownloading: boolean;
  /** 模型下载进度 0-100 */
  modelDownloadProgress: number;

  // ── 设备能力 ──
  /** 设备能力检测结果 */
  capability: TTSCapability | null;
  /** 是否已检测 */
  capabilityChecked: boolean;

  // ── 设置 ──
  /** 语音 ID */
  voiceId: string;
  /** 语速 0.5-3.0 */
  speed: number;
  /** 自动翻章 */
  autoNextChapter: boolean;
  /** TTS 引擎类型 */
  engine: "kokoro" | "webspeech";

  // ── Actions ──
  setPlaying: (playing: boolean) => void;
  setPaused: (paused: boolean) => void;
  setCurrentChapter: (novelId: string | null, chapterIndex: number | null) => void;
  setCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  setParagraphProgress: (current: number, total: number) => void;
  setGenerating: (generating: boolean, progress?: number) => void;
  setModelDownloaded: (downloaded: boolean) => void;
  setModelDownloading: (downloading: boolean, progress?: number) => void;
  setCapability: (capability: TTSCapability) => void;
  setVoiceId: (voiceId: string) => void;
  setSpeed: (speed: number) => void;
  setAutoNextChapter: (auto: boolean) => void;
  setEngine: (engine: "kokoro" | "webspeech") => void;
  reset: () => void;
}

const TTS_SETTINGS_KEY = "novel-reader-tts-settings";

function loadSettings(): { voiceId: string; speed: number; autoNextChapter: boolean; engine: "kokoro" | "webspeech" } {
  try {
    const raw = localStorage.getItem(TTS_SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return {
        voiceId: s.voiceId || "zf_001",
        speed: s.speed ?? 1.0,
        autoNextChapter: s.autoNextChapter ?? true,
        engine: s.engine || "kokoro",
      };
    }
  } catch { /* ignore */ }
  return { voiceId: "zf_001", speed: 1.0, autoNextChapter: true, engine: "kokoro" };
}

function saveSettings(s: { voiceId: string; speed: number; autoNextChapter: boolean; engine: string }) {
  try { localStorage.setItem(TTS_SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

const defaults = loadSettings();

export const useTTSStore = create<TTSState>((set, get) => ({
  // 播放状态
  playing: false,
  paused: false,
  currentNovelId: null,
  currentChapterIndex: null,
  currentTime: 0,
  duration: 0,
  currentParagraph: 0,
  totalParagraphs: 0,

  // 生成状态
  generating: false,
  generateProgress: 0,

  // 模型状态
  modelDownloaded: false,
  modelDownloading: false,
  modelDownloadProgress: 0,

  // 设备能力
  capability: null,
  capabilityChecked: false,

  // 设置
  voiceId: defaults.voiceId,
  speed: defaults.speed,
  autoNextChapter: defaults.autoNextChapter,
  engine: defaults.engine,

  // Actions
  setPlaying: (playing) => set({ playing, paused: false }),
  setPaused: (paused) => set({ paused }),
  setCurrentChapter: (novelId, chapterIndex) => set({
    currentNovelId: novelId,
    currentChapterIndex: chapterIndex,
    currentTime: 0,
    currentParagraph: 0,
    totalParagraphs: 0,
  }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setDuration: (duration) => set({ duration }),
  setParagraphProgress: (current, total) => set({ currentParagraph: current, totalParagraphs: total }),
  setGenerating: (generating, progress) => set({ generating, generateProgress: progress ?? 0 }),
  setModelDownloaded: (downloaded) => set({ modelDownloaded: downloaded }),
  setModelDownloading: (downloading, progress) => set({ modelDownloading: downloading, modelDownloadProgress: progress ?? 0 }),
  setCapability: (capability) => set({ capability, capabilityChecked: true }),
  setVoiceId: (voiceId) => { const s = get(); set({ voiceId }); saveSettings({ voiceId, speed: s.speed, autoNextChapter: s.autoNextChapter, engine: s.engine }); },
  setSpeed: (speed) => { const s = get(); set({ speed }); saveSettings({ voiceId: s.voiceId, speed, autoNextChapter: s.autoNextChapter, engine: s.engine }); },
  setAutoNextChapter: (autoNextChapter) => { const s = get(); set({ autoNextChapter }); saveSettings({ voiceId: s.voiceId, speed: s.speed, autoNextChapter, engine: s.engine }); },
  setEngine: (engine) => { const s = get(); set({ engine }); saveSettings({ voiceId: s.voiceId, speed: s.speed, autoNextChapter: s.autoNextChapter, engine }); },
  reset: () => set({
    playing: false, paused: false,
    currentNovelId: null, currentChapterIndex: null,
    currentTime: 0, duration: 0,
    currentParagraph: 0, totalParagraphs: 0,
    generating: false, generateProgress: 0,
  }),
}));
