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
  /** TTS 生成语速 0.5-3.0（设置页；ZipVoice 生成 & WebSpeech rate） */
  speed: number;
  /** 播放倍速 0.5-3.0（正文朗读栏，独立于生成语速，两者相乘为实际语速） */
  playbackRate: number;
  /** F7: 音量 0-1 */
  volume: number;
  /** F8: 音调 0.5-2.0（仅 Web Speech 生效） */
  pitch: number;
  /** 自动翻章 */
  autoNextChapter: boolean;
  /** 单次生成字数上限（ZipVoice 离线引擎分块，30-500，默认 150） */
  zipvoiceChunkSize: number;
  /** 一次朗读字数上限（Web Speech 分块，30-500，默认 300） */
  webspeechChunkSize: number;
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
  setPlaybackRate: (rate: number) => void;
  setVolume: (volume: number) => void;
  setPitch: (pitch: number) => void;
  setAutoNextChapter: (auto: boolean) => void;
  setZipvoiceChunkSize: (zipvoiceChunkSize: number) => void;
  setWebspeechChunkSize: (webspeechChunkSize: number) => void;
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
  /** 各引擎独立的生成参数（切换引擎不互相影响） */
  zipvoiceSpeed: number;
  webspeechSpeed: number;
  zipvoiceVolume: number;
  webspeechVolume: number;
  zipvoicePitch: number;
  webspeechPitch: number;
  /** 播放倍速（朗读栏，全局） */
  playbackRate: number;
  autoNextChapter: boolean;
  engine: "zipvoice" | "webspeech";
  modelDownloaded: boolean;
  /** ZipVoice 单次生成字数上限（30-500，默认 150；旧字段 chunkSize 迁移至此） */
  zipvoiceChunkSize: number;
  /** Web Speech 一次朗读字数上限（30-500，默认 300） */
  webspeechChunkSize: number;
}

function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(TTS_SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      // 兼容旧数据：旧版本 speed/volume/pitch 是全局的，迁移为两个引擎各自一份
      // 兼容旧音色：旧 ZipVoice 音色 0-2 → Kokoro 默认女声 45（晓北）；
      // 超出 Kokoro 中文音色范围（45-52）的旧 sid 统一回退到 45
      let zipvoiceVoiceId = s.zipvoiceVoiceId || s.voiceId || "45";
      const oldSid = parseInt(String(zipvoiceVoiceId), 10);
      if (!Number.isNaN(oldSid) && (oldSid < 45 || oldSid > 52)) {
        zipvoiceVoiceId = "45"; // 旧音色全部映射到默认女声晓北
      }
      return {
        zipvoiceVoiceId,
        webspeechVoiceId: s.webspeechVoiceId || "",
        zipvoiceSpeed: s.zipvoiceSpeed ?? s.speed ?? 1.0,
        webspeechSpeed: s.webspeechSpeed ?? s.speed ?? 1.0,
        zipvoiceVolume: s.zipvoiceVolume ?? s.volume ?? 1.0,
        webspeechVolume: s.webspeechVolume ?? s.volume ?? 1.0,
        zipvoicePitch: s.zipvoicePitch ?? s.pitch ?? 1.0,
        webspeechPitch: s.webspeechPitch ?? s.pitch ?? 1.0,
        playbackRate: s.playbackRate ?? 1.0,
        autoNextChapter: s.autoNextChapter ?? true,
        engine: (s.engine === "zipvoice" || s.engine === "webspeech") ? s.engine : "webspeech",
        modelDownloaded: s.modelDownloaded ?? false,
        zipvoiceChunkSize: clampChunkSize(s.zipvoiceChunkSize ?? s.chunkSize ?? 150),
        webspeechChunkSize: clampChunkSize(s.webspeechChunkSize ?? 300),
      };
    }
  } catch { /* ignore */ }
  return { zipvoiceVoiceId: "45", webspeechVoiceId: "", zipvoiceSpeed: 1.0, webspeechSpeed: 1.0, zipvoiceVolume: 1.0, webspeechVolume: 1.0, zipvoicePitch: 1.0, webspeechPitch: 1.0, playbackRate: 1.0, autoNextChapter: true, engine: "webspeech", modelDownloaded: false, zipvoiceChunkSize: 150, webspeechChunkSize: 300 };
}

/** chunkSize 合法范围：30-500 字 */
function clampChunkSize(v: number): number {
  const n = Math.round(Number(v) || 150);
  return Math.max(30, Math.min(500, n));
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

  // 设置 — M14 fix: 每个引擎独立的 voiceId + 生成参数（speed/volume/pitch 按引擎独立）
  voiceId: getVoiceIdForEngine(defaults.engine, defaults.zipvoiceVoiceId, defaults.webspeechVoiceId),
  speed: defaults.engine === "zipvoice" ? defaults.zipvoiceSpeed : defaults.webspeechSpeed,
  playbackRate: defaults.playbackRate,
  volume: defaults.engine === "zipvoice" ? defaults.zipvoiceVolume : defaults.webspeechVolume,
  pitch: defaults.engine === "zipvoice" ? defaults.zipvoicePitch : defaults.webspeechPitch,
  autoNextChapter: defaults.autoNextChapter,
  zipvoiceChunkSize: defaults.zipvoiceChunkSize,
  webspeechChunkSize: defaults.webspeechChunkSize,
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
      zipvoiceSpeed: s.engine === "zipvoice" ? s.speed : settings.zipvoiceSpeed,
      webspeechSpeed: s.engine === "webspeech" ? s.speed : settings.webspeechSpeed,
      zipvoiceVolume: s.engine === "zipvoice" ? s.volume : settings.zipvoiceVolume,
      webspeechVolume: s.engine === "webspeech" ? s.volume : settings.webspeechVolume,
      zipvoicePitch: s.engine === "zipvoice" ? s.pitch : settings.zipvoicePitch,
      webspeechPitch: s.engine === "webspeech" ? s.pitch : settings.webspeechPitch,
      autoNextChapter: s.autoNextChapter, engine: s.engine, modelDownloaded: downloaded,
    });
  },
  setModelDownloading: (downloading, progress) => set({ modelDownloading: downloading, modelDownloadProgress: progress ?? 0 }),
  setVoiceId: (voiceId) => {
    const s = get();
    set({ voiceId });
    const settings = getCachedSettings();
    if (s.engine === "zipvoice") {
      settings.zipvoiceVoiceId = voiceId;
      settings.zipvoiceSpeed = s.speed;
      settings.zipvoiceVolume = s.volume;
      settings.zipvoicePitch = s.pitch;
    } else {
      settings.webspeechVoiceId = voiceId;
      settings.webspeechSpeed = s.speed;
      settings.webspeechVolume = s.volume;
      settings.webspeechPitch = s.pitch;
    }
    settings.autoNextChapter = s.autoNextChapter;
    settings.engine = s.engine;
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setSpeed: (speed) => {
    const clamped = Math.max(0.5, Math.min(3.0, speed));
    const s = get(); set({ speed: clamped });
    const settings = getCachedSettings();
    if (s.engine === "zipvoice") settings.zipvoiceSpeed = clamped;
    else settings.webspeechSpeed = clamped;
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setPlaybackRate: (playbackRate) => {
    const clamped = Math.max(0.5, Math.min(3.0, playbackRate));
    const s = get(); set({ playbackRate: clamped });
    const settings = getCachedSettings();
    settings.playbackRate = clamped;
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setVolume: (volume) => {
    const clamped = Math.max(0, Math.min(1, volume));
    const s = get(); set({ volume: clamped });
    const settings = getCachedSettings();
    if (s.engine === "zipvoice") settings.zipvoiceVolume = clamped;
    else settings.webspeechVolume = clamped;
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setPitch: (pitch) => {
    const clamped = Math.max(0.5, Math.min(2, pitch));
    const s = get(); set({ pitch: clamped });
    const settings = getCachedSettings();
    if (s.engine === "zipvoice") settings.zipvoicePitch = clamped;
    else settings.webspeechPitch = clamped;
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
  setZipvoiceChunkSize: (zipvoiceChunkSize) => {
    const clamped = clampChunkSize(zipvoiceChunkSize);
    const s = get(); set({ zipvoiceChunkSize: clamped });
    const settings = getCachedSettings();
    settings.zipvoiceChunkSize = clamped;
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setWebspeechChunkSize: (webspeechChunkSize) => {
    const clamped = clampChunkSize(webspeechChunkSize);
    const s = get(); set({ webspeechChunkSize: clamped });
    const settings = getCachedSettings();
    settings.webspeechChunkSize = clamped;
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setEngine: (engine) => {
    const s = get();
    const settings = getCachedSettings();
    const newVoiceId = getVoiceIdForEngine(engine, settings.zipvoiceVoiceId, settings.webspeechVoiceId);
    // 切换引擎时载入该引擎独立的生成参数（speed/volume/pitch），互不影响
    set({
      engine,
      voiceId: newVoiceId,
      speed: engine === "zipvoice" ? settings.zipvoiceSpeed : settings.webspeechSpeed,
      volume: engine === "zipvoice" ? settings.zipvoiceVolume : settings.webspeechVolume,
      pitch: engine === "zipvoice" ? settings.zipvoicePitch : settings.webspeechPitch,
    });
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
