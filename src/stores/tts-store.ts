/**
 * TTS Zustand Store
 * 管理 TTS 播放状态、设置、模型状态
 */

import { create } from "zustand";

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

  // ── 设置 ──
  /** 当前引擎的语音 ID（根据 engine 自动切换） */
  voiceId: string;
  /** 语速 0.5-3.0 */
  speed: number;
  /** 自动翻章 */
  autoNextChapter: boolean;
  /** TTS 引擎类型 */
  engine: "zipvoice" | "webspeech";

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
  setVoiceId: (voiceId: string) => void;
  setSpeed: (speed: number) => void;
  setAutoNextChapter: (auto: boolean) => void;
  setEngine: (engine: "zipvoice" | "webspeech") => void;
  reset: () => void;
}

const TTS_SETTINGS_KEY = "novel-reader-tts-settings";

interface PersistedSettings {
  zipvoiceVoiceId: string;
  webspeechVoiceId: string;
  speed: number;
  autoNextChapter: boolean;
  engine: "zipvoice" | "webspeech";
  modelDownloaded: boolean;
}

function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(TTS_SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return {
        zipvoiceVoiceId: s.zipvoiceVoiceId || s.voiceId || "0",
        webspeechVoiceId: s.webspeechVoiceId || "",
        speed: s.speed ?? 1.0,
        autoNextChapter: s.autoNextChapter ?? true,
        engine: "webspeech", // ZipVoice 暂不可用，强制 WebSpeech
        modelDownloaded: s.modelDownloaded ?? false,
      };
    }
  } catch { /* ignore */ }
  return { zipvoiceVoiceId: "0", webspeechVoiceId: "", speed: 1.0, autoNextChapter: true, engine: "webspeech", modelDownloaded: false };
}

function saveSettings(s: PersistedSettings) {
  try { localStorage.setItem(TTS_SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

const defaults = loadSettings();

// 根据当前引擎获取对应的 voiceId
function getVoiceIdForEngine(engine: "zipvoice" | "webspeech", zipvoiceVoiceId: string, webspeechVoiceId: string): string {
  return engine === "zipvoice" ? zipvoiceVoiceId : webspeechVoiceId;
}

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

  // 模型状态 — C6 fix: 从 localStorage 恢复
  modelDownloaded: defaults.modelDownloaded,
  modelDownloading: false,
  modelDownloadProgress: 0,

  // 设置 — M14 fix: 每个引擎独立的 voiceId
  voiceId: getVoiceIdForEngine(defaults.engine, defaults.zipvoiceVoiceId, defaults.webspeechVoiceId),
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
  setModelDownloaded: (downloaded) => {
    set({ modelDownloaded: downloaded });
    // C6 fix: 持久化 modelDownloaded
    const s = get();
    saveSettings({
      zipvoiceVoiceId: s.engine === "zipvoice" ? s.voiceId : loadSettings().zipvoiceVoiceId,
      webspeechVoiceId: s.engine === "webspeech" ? s.voiceId : loadSettings().webspeechVoiceId,
      speed: s.speed, autoNextChapter: s.autoNextChapter, engine: s.engine, modelDownloaded: downloaded,
    });
  },
  setModelDownloading: (downloading, progress) => set({ modelDownloading: downloading, modelDownloadProgress: progress ?? 0 }),
  setVoiceId: (voiceId) => {
    const s = get();
    set({ voiceId });
    // M14 fix: 按引擎分别保存 voiceId
    const settings = loadSettings();
    if (s.engine === "zipvoice") settings.zipvoiceVoiceId = voiceId;
    else settings.webspeechVoiceId = voiceId;
    settings.speed = s.speed;
    settings.autoNextChapter = s.autoNextChapter;
    settings.engine = s.engine;
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setSpeed: (speed) => {
    const s = get(); set({ speed });
    const settings = loadSettings();
    settings.speed = speed;
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setAutoNextChapter: (autoNextChapter) => {
    const s = get(); set({ autoNextChapter });
    const settings = loadSettings();
    settings.autoNextChapter = autoNextChapter;
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setEngine: (engine) => {
    const s = get();
    // M14 fix: 切换引擎时自动切换到该引擎的 voiceId
    const settings = loadSettings();
    const newVoiceId = getVoiceIdForEngine(engine, settings.zipvoiceVoiceId, settings.webspeechVoiceId);
    set({ engine, voiceId: newVoiceId });
    settings.engine = engine;
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  reset: () => set({
    playing: false, paused: false,
    currentNovelId: null, currentChapterIndex: null,
    currentTime: 0, duration: 0,
    currentParagraph: 0, totalParagraphs: 0,
    generating: false, generateProgress: 0,
  }),
}));
