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
  /** F7: 音量 0-1 */
  volume: number;
  /** F8: 音调 0.5-2.0 */
  pitch: number;
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
  setVolume: (volume: number) => void;
  setPitch: (pitch: number) => void;
  setAutoNextChapter: (auto: boolean) => void;
  setEngine: (engine: "zipvoice" | "webspeech") => void;
  /** 顶栏朗读按钮触发计数器（外部递增，AudioPlayer 监听） */
  startRequested: number;
  requestStart: () => void;
  /** 浏览器已加载的语音列表（朗读时 waitForVoices 同步） */
  browserVoices: SpeechSynthesisVoice[];
  setBrowserVoices: (voices: SpeechSynthesisVoice[]) => void;
  reset: () => void;
}

const TTS_SETTINGS_KEY = "novel-reader-tts-settings";

interface PersistedSettings {
  zipvoiceVoiceId: string;
  webspeechVoiceId: string;
  speed: number;
  volume: number;
  pitch: number;
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
        volume: s.volume ?? 1.0,
        pitch: s.pitch ?? 1.0,
        autoNextChapter: s.autoNextChapter ?? true,
        engine: (s.engine === "zipvoice" || s.engine === "webspeech") ? s.engine : "webspeech",
        modelDownloaded: s.modelDownloaded ?? false,
      };
    }
  } catch { /* ignore */ }
  return { zipvoiceVoiceId: "0", webspeechVoiceId: "", speed: 1.0, volume: 1.0, pitch: 1.0, autoNextChapter: true, engine: "webspeech", modelDownloaded: false };
}

// Cached settings to avoid repeated localStorage reads
let _cachedSettings: PersistedSettings | null = null;

function getCachedSettings(): PersistedSettings {
  if (!_cachedSettings) _cachedSettings = loadSettings();
  return _cachedSettings;
}

function saveSettings(s: PersistedSettings) {
  _cachedSettings = s; // Update cache
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
  volume: defaults.volume,
  pitch: defaults.pitch,
  autoNextChapter: defaults.autoNextChapter,
  engine: defaults.engine,

  // 朗读触发（顶栏按钮 → AudioPlayer 监听）
  startRequested: 0,

  // 浏览器语音列表（朗读时 waitForVoices 同步，设置页直接读取）
  browserVoices: [],

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
    const s = get();
    const settings = getCachedSettings();
    saveSettings({
      ...settings,
      zipvoiceVoiceId: s.engine === "zipvoice" ? s.voiceId : settings.zipvoiceVoiceId,
      webspeechVoiceId: s.engine === "webspeech" ? s.voiceId : settings.webspeechVoiceId,
      speed: s.speed, volume: s.volume, pitch: s.pitch, autoNextChapter: s.autoNextChapter, engine: s.engine, modelDownloaded: downloaded,
    });
  },
  setModelDownloading: (downloading, progress) => set({ modelDownloading: downloading, modelDownloadProgress: progress ?? 0 }),
  setVoiceId: (voiceId) => {
    const s = get();
    set({ voiceId });
    const settings = getCachedSettings();
    if (s.engine === "zipvoice") settings.zipvoiceVoiceId = voiceId;
    else settings.webspeechVoiceId = voiceId;
    settings.speed = s.speed;
    settings.autoNextChapter = s.autoNextChapter;
    settings.engine = s.engine;
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setSpeed: (speed) => {
    const clamped = Math.max(0.5, Math.min(3.0, speed));
    const s = get(); set({ speed: clamped });
    const settings = getCachedSettings();
    settings.speed = clamped;
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setVolume: (volume) => {
    const clamped = Math.max(0, Math.min(1, volume));
    const s = get(); set({ volume: clamped });
    const settings = getCachedSettings();
    settings.volume = clamped;
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setPitch: (pitch) => {
    const clamped = Math.max(0.5, Math.min(2, pitch));
    const s = get(); set({ pitch: clamped });
    const settings = getCachedSettings();
    settings.pitch = clamped;
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setAutoNextChapter: (autoNextChapter) => {
    const s = get(); set({ autoNextChapter });
    const settings = getCachedSettings();
    settings.autoNextChapter = autoNextChapter;
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setEngine: (engine) => {
    const s = get();
    const settings = getCachedSettings();
    const newVoiceId = getVoiceIdForEngine(engine, settings.zipvoiceVoiceId, settings.webspeechVoiceId);
    set({ engine, voiceId: newVoiceId });
    settings.engine = engine;
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  requestStart: () => set(s => ({ startRequested: s.startRequested + 1 })),
  setBrowserVoices: (voices) => set({ browserVoices: voices }),
  reset: () => set({
    playing: false, paused: false,
    currentNovelId: null, currentChapterIndex: null,
    currentTime: 0, duration: 0,
    currentParagraph: 0, totalParagraphs: 0,
    generating: false, generateProgress: 0,
  }),
}));
