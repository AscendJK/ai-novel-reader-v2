/**
 * TTS Zustand Store
 * 管理 TTS 播放状态、设置、模型状态
 * 三个引擎（server 服务端推理 / zipvoice 浏览器推理 / webspeech 浏览器内置）
 * 的音色、语速、音量、音调、分块大小参数完全互相独立。
 */

import { create } from "zustand";

export type TTSEngine = "server" | "zipvoice" | "webspeech";

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
  /** 预生成阶段：已完成段数（Kokoro 引擎开播前缓冲） */
  prepareReady: number;
  /** 预生成阶段：目标段数（0=未启用） */
  prepareTotal: number;
  /** 播放中缓冲水位（已缓存待播段数） */
  bufferedChunks: number;

  // ── 模型状态 ──
  /** 模型是否已下载 */
  modelDownloaded: boolean;
  /** 模型是否正在下载 */
  modelDownloading: boolean;
  /** 模型下载进度 0-100 */
  modelDownloadProgress: number;

  // ── 设置（当前引擎生效值）──
  /** 当前引擎的语音 ID（根据 engine 自动切换） */
  voiceId: string;
  /** TTS 生成语速 0.5-3.0（当前引擎；生成 & WebSpeech rate） */
  speed: number;
  /** 播放倍速 0.5-3.0（正文朗读栏，独立于生成语速，两者相乘为实际语速） */
  playbackRate: number;
  /** F7: 音量 0-1 */
  volume: number;
  /** F8: 音调 0.5-2.0（仅 Web Speech 生效） */
  pitch: number;
  /** 自动翻章 */
  autoNextChapter: boolean;
  /** 单次生成字数上限（当前引擎分块，30-500） */
  chunkSize: number;
  /** 开播前预生成段数（Kokoro 引擎：server/zipvoice 生效，1-10） */
  prefetchCount: number;
  /** 浏览器推理并行 Worker 数（仅 zipvoice 生效，1-3；每个约占用 400-500MB 内存） */
  workerCount: number;
  /** TTS 引擎类型 */
  engine: TTSEngine;

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
  setChunkSize: (chunkSize: number) => void;
  /** 开播前预生成段数（写入当前引擎参数，Kokoro 引擎生效） */
  setPrefetchCount: (count: number) => void;
  /** 浏览器推理并行 Worker 数（仅 zipvoice 生效，下次朗读应用） */
  setWorkerCount: (count: number) => void;
  /** 预生成阶段进度（manager 回调 → 朗读栏显示） */
  setPrepareProgress: (ready: number, total: number) => void;
  /** 播放中缓冲水位（manager 回调 → 朗读栏显示） */
  setBufferedChunks: (buffered: number) => void;
  setEngine: (engine: TTSEngine) => void;
  /** 顶栏朗读按钮触发计数器（外部递增，AudioPlayer 监听） */
  startRequested: number;
  requestStart: () => void;
  /** 浏览器已加载的语音列表（朗读时 waitForVoices 同步） */
  browserVoices: SpeechSynthesisVoice[];
  setBrowserVoices: (voices: SpeechSynthesisVoice[]) => void;
  reset: () => void;
}

const TTS_SETTINGS_KEY = "novel-reader-tts-settings";

/** 三引擎各自独立的持久化参数 */
interface PersistedSettings {
  // 服务端推理（Python 原生，快）
  serverVoiceId: string;
  serverSpeed: number;
  serverVolume: number;
  serverPitch: number;
  serverChunkSize: number;
  serverPrefetchCount: number;
  // 浏览器推理（wasm 离线）
  zipvoiceVoiceId: string;
  zipvoiceSpeed: number;
  zipvoiceVolume: number;
  zipvoicePitch: number;
  zipvoiceChunkSize: number;
  zipvoicePrefetchCount: number;
  zipvoiceWorkerCount: number;
  // 浏览器内置
  webspeechVoiceId: string;
  webspeechSpeed: number;
  webspeechVolume: number;
  webspeechPitch: number;
  webspeechChunkSize: number;
  /** 播放倍速（朗读栏，全局） */
  playbackRate: number;
  autoNextChapter: boolean;
  engine: TTSEngine;
  modelDownloaded: boolean;
}

/** chunkSize 合法范围：30-500 字 */
function clampChunkSize(v: number): number {
  const n = Math.round(Number(v) || 60);
  return Math.max(30, Math.min(500, n));
}

/** prefetchCount 合法范围：1-10 段（0=关闭预生成，设置页不提供） */
function clampPrefetchCount(v: number): number {
  const n = Math.round(Number(v) || 3);
  return Math.max(1, Math.min(10, n));
}

/** workerCount 合法范围：1-3（每个 worker 约 400-500MB 内存） */
function clampWorkerCount(v: number): number {
  const n = Math.round(Number(v) || 1);
  return Math.max(1, Math.min(3, n));
}

/** 兼容旧音色：旧 ZipVoice 音色 0-2 → Kokoro 默认女声 45（晓北） */
function normalizeKokoroVoiceId(v: unknown, fallback = "45"): string {
  const s = String(v ?? "");
  const sid = parseInt(s, 10);
  if (!Number.isNaN(sid) && sid >= 45 && sid <= 52) return String(sid);
  if (s && Number.isNaN(sid)) return s; // 非数字 id（保留原样，可能是命名音色）
  return fallback;
}

function loadSettings(): PersistedSettings {
  const defaults: PersistedSettings = {
    serverVoiceId: "45", serverSpeed: 1.0, serverVolume: 1.0, serverPitch: 1.0, serverChunkSize: 150, serverPrefetchCount: 2,
    zipvoiceVoiceId: "45", zipvoiceSpeed: 1.0, zipvoiceVolume: 1.0, zipvoicePitch: 1.0, zipvoiceChunkSize: 60, zipvoicePrefetchCount: 3, zipvoiceWorkerCount: 1,
    webspeechVoiceId: "", webspeechSpeed: 1.0, webspeechVolume: 1.0, webspeechPitch: 1.0, webspeechChunkSize: 300,
    playbackRate: 1.0, autoNextChapter: true, engine: "webspeech", modelDownloaded: false,
  };
  try {
    const raw = localStorage.getItem(TTS_SETTINGS_KEY);
    if (!raw) return defaults;
    const s = JSON.parse(raw);
    // 兼容旧数据：
    // - 旧版本 speed/volume/pitch 是全局的（s.speed），迁移到各引擎一份
    // - server 参数从 zipvoice 迁移（旧版本 server 与 zipvoice 共用）
    // - 旧 ZipVoice 音色 0-2 → Kokoro 45；旧 chunkSize 字段迁移到 zipvoiceChunkSize
    const engine: TTSEngine =
      s.engine === "server" || s.engine === "zipvoice" || s.engine === "webspeech" ? s.engine : "webspeech";
    return {
      serverVoiceId: normalizeKokoroVoiceId(s.serverVoiceId ?? s.zipvoiceVoiceId ?? s.voiceId ?? "45"),
      serverSpeed: Number(s.serverSpeed ?? s.zipvoiceSpeed ?? s.speed ?? 1.0),
      serverVolume: Number(s.serverVolume ?? s.zipvoiceVolume ?? s.volume ?? 1.0),
      serverPitch: Number(s.serverPitch ?? s.zipvoicePitch ?? s.pitch ?? 1.0),
      serverChunkSize: clampChunkSize(s.serverChunkSize ?? s.zipvoiceChunkSize ?? s.chunkSize ?? 150),
      serverPrefetchCount: clampPrefetchCount(s.serverPrefetchCount ?? s.zipvoicePrefetchCount ?? 2),
      zipvoiceVoiceId: normalizeKokoroVoiceId(s.zipvoiceVoiceId ?? s.voiceId ?? "45"),
      zipvoiceSpeed: Number(s.zipvoiceSpeed ?? s.speed ?? 1.0),
      zipvoiceVolume: Number(s.zipvoiceVolume ?? s.volume ?? 1.0),
      zipvoicePitch: Number(s.zipvoicePitch ?? s.pitch ?? 1.0),
      zipvoiceChunkSize: clampChunkSize(s.zipvoiceChunkSize ?? s.chunkSize ?? 60),
      zipvoicePrefetchCount: clampPrefetchCount(s.zipvoicePrefetchCount ?? 3),
      zipvoiceWorkerCount: clampWorkerCount(s.zipvoiceWorkerCount ?? 1),
      webspeechVoiceId: String(s.webspeechVoiceId ?? ""),
      webspeechSpeed: Number(s.webspeechSpeed ?? s.speed ?? 1.0),
      webspeechVolume: Number(s.webspeechVolume ?? s.volume ?? 1.0),
      webspeechPitch: Number(s.webspeechPitch ?? s.pitch ?? 1.0),
      webspeechChunkSize: clampChunkSize(s.webspeechChunkSize ?? 300),
      playbackRate: Number(s.playbackRate ?? 1.0),
      autoNextChapter: s.autoNextChapter ?? true,
      engine,
      modelDownloaded: s.modelDownloaded ?? false,
    };
  } catch { /* ignore */ }
  return defaults;
}

// Cached settings to avoid repeated localStorage reads
let _cachedSettings: PersistedSettings | null = null;

function getCachedSettings(): PersistedSettings {
  if (!_cachedSettings) _cachedSettings = loadSettings();
  return _cachedSettings;
}

/**
 * 重置 settings 缓存（测试辅助；localStorage 被外部清空时也可手动调用）
 */
export function __resetTTSSettingsCache(): void {
  _cachedSettings = null;
}

function saveSettings(s: PersistedSettings) {
  _cachedSettings = s; // Update cache
  try { localStorage.setItem(TTS_SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

const defaults = loadSettings();

// 根据当前引擎获取对应的 voiceId（三引擎完全独立）
function getVoiceIdForEngine(engine: TTSEngine, p: PersistedSettings): string {
  if (engine === "server") return p.serverVoiceId;
  if (engine === "zipvoice") return p.zipvoiceVoiceId;
  return p.webspeechVoiceId;
}

// 当前引擎生效的 speed/volume/pitch/chunkSize/prefetchCount（三引擎完全独立）
function getParamsForEngine(engine: TTSEngine, p: PersistedSettings) {
  if (engine === "server") return { speed: p.serverSpeed, volume: p.serverVolume, pitch: p.serverPitch, chunkSize: p.serverChunkSize, prefetchCount: p.serverPrefetchCount };
  if (engine === "zipvoice") return { speed: p.zipvoiceSpeed, volume: p.zipvoiceVolume, pitch: p.zipvoicePitch, chunkSize: p.zipvoiceChunkSize, prefetchCount: p.zipvoicePrefetchCount };
  return { speed: p.webspeechSpeed, volume: p.webspeechVolume, pitch: p.webspeechPitch, chunkSize: p.webspeechChunkSize, prefetchCount: 0 };
}

// 把当前生效值写回当前引擎的持久化参数
function writeCurrentParams(p: PersistedSettings, engine: TTSEngine, voiceId: string, speed: number, volume: number, pitch: number): void {
  if (engine === "server") {
    p.serverVoiceId = voiceId; p.serverSpeed = speed; p.serverVolume = volume; p.serverPitch = pitch;
  } else if (engine === "zipvoice") {
    p.zipvoiceVoiceId = voiceId; p.zipvoiceSpeed = speed; p.zipvoiceVolume = volume; p.zipvoicePitch = pitch;
  } else {
    p.webspeechVoiceId = voiceId; p.webspeechSpeed = speed; p.webspeechVolume = volume; p.webspeechPitch = pitch;
  }
}

function writeChunkSize(p: PersistedSettings, engine: TTSEngine, size: number): void {
  if (engine === "server") p.serverChunkSize = size;
  else if (engine === "zipvoice") p.zipvoiceChunkSize = size;
  else p.webspeechChunkSize = size;
}

function writePrefetchCount(p: PersistedSettings, engine: TTSEngine, count: number): void {
  if (engine === "server") p.serverPrefetchCount = count;
  else if (engine === "zipvoice") p.zipvoicePrefetchCount = count;
  // webspeech 无预生成概念，忽略
}

function writeWorkerCount(p: PersistedSettings, count: number): void {
  p.zipvoiceWorkerCount = count; // 仅浏览器推理使用
}

const initialParams = getParamsForEngine(defaults.engine, defaults);

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

  // 设置 — 三引擎完全独立（M14 fix 扩展）
  voiceId: getVoiceIdForEngine(defaults.engine, defaults),
  speed: initialParams.speed,
  playbackRate: defaults.playbackRate,
  volume: initialParams.volume,
  pitch: initialParams.pitch,
  autoNextChapter: defaults.autoNextChapter,
  chunkSize: initialParams.chunkSize,
  prefetchCount: initialParams.prefetchCount,
  workerCount: defaults.zipvoiceWorkerCount,
  engine: defaults.engine,

  // 预生成缓冲状态（Kokoro 引擎朗读时）
  prepareReady: 0,
  prepareTotal: 0,
  bufferedChunks: 0,

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
  setPrepareProgress: (ready, total) => set({ prepareReady: ready, prepareTotal: total }),
  setBufferedChunks: (buffered) => set({ bufferedChunks: buffered }),
  setModelDownloaded: (downloaded) => {
    set({ modelDownloaded: downloaded });
    const s = get();
    const settings = getCachedSettings();
    writeCurrentParams(settings, s.engine, s.voiceId, s.speed, s.volume, s.pitch);
    writeChunkSize(settings, s.engine, s.chunkSize);
    settings.autoNextChapter = s.autoNextChapter;
    settings.engine = s.engine;
    settings.modelDownloaded = downloaded;
    saveSettings(settings);
  },
  setModelDownloading: (downloading, progress) => set({ modelDownloading: downloading, modelDownloadProgress: progress ?? 0 }),
  setVoiceId: (voiceId) => {
    const s = get();
    set({ voiceId });
    const settings = getCachedSettings();
    writeCurrentParams(settings, s.engine, voiceId, s.speed, s.volume, s.pitch);
    settings.autoNextChapter = s.autoNextChapter;
    settings.engine = s.engine;
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setSpeed: (speed) => {
    const clamped = Math.max(0.5, Math.min(3.0, speed));
    const s = get(); set({ speed: clamped });
    const settings = getCachedSettings();
    writeCurrentParams(settings, s.engine, s.voiceId, clamped, s.volume, s.pitch);
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
    writeCurrentParams(settings, s.engine, s.voiceId, s.speed, clamped, s.pitch);
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setPitch: (pitch) => {
    const clamped = Math.max(0.5, Math.min(2, pitch));
    const s = get(); set({ pitch: clamped });
    const settings = getCachedSettings();
    writeCurrentParams(settings, s.engine, s.voiceId, s.speed, s.volume, clamped);
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
  setChunkSize: (chunkSize) => {
    const clamped = clampChunkSize(chunkSize);
    const s = get(); set({ chunkSize: clamped });
    const settings = getCachedSettings();
    writeChunkSize(settings, s.engine, clamped);
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setPrefetchCount: (count) => {
    const clamped = clampPrefetchCount(count);
    const s = get(); set({ prefetchCount: clamped });
    const settings = getCachedSettings();
    writePrefetchCount(settings, s.engine, clamped);
    settings.modelDownloaded = s.modelDownloaded;
    saveSettings(settings);
  },
  setWorkerCount: (count) => {
    const clamped = clampWorkerCount(count);
    set({ workerCount: clamped });
    const settings = getCachedSettings();
    writeWorkerCount(settings, clamped);
    settings.modelDownloaded = get().modelDownloaded;
    saveSettings(settings);
  },
  setEngine: (engine) => {
    const s = get();
    const settings = getCachedSettings();
    // 切换引擎前先把当前生效值写回旧引擎（防止切换后丢失未保存的调整）
    writeCurrentParams(settings, s.engine, s.voiceId, s.speed, s.volume, s.pitch);
    writeChunkSize(settings, s.engine, s.chunkSize);
    // 载入新引擎独立的参数（三引擎完全独立，互不影响）
    const params = getParamsForEngine(engine, settings);
    set({
      engine,
      voiceId: getVoiceIdForEngine(engine, settings),
      speed: params.speed,
      volume: params.volume,
      pitch: params.pitch,
      chunkSize: params.chunkSize,
      prefetchCount: params.prefetchCount,
      // workerCount 仅浏览器推理使用（全局设置，不随引擎切换）
      workerCount: settings.zipvoiceWorkerCount,
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
