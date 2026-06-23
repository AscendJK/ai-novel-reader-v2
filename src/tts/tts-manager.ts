/**
 * TTS 管理器
 * 统一的 TTS 引擎抽象层，支持 ZipVoice 和 Web Speech API
 * 支持流式播放（边生成边播放 + 预生成下一章）
 */

import { loadModel, isModelLoaded, generateAudio } from "./zipvoice-engine";

export type TTSEngine = "zipvoice" | "webspeech";

export interface TTSChunk {
  text: string;
  index: number;
}

export interface TTSPlaybackCallbacks {
  onPlay?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onStop?: () => void;
  onEnd?: () => void;
  onChunkStart?: (index: number, total: number) => void;
  onChunkEnd?: (index: number, total: number) => void;
  onError?: (error: string) => void;
  onFallback?: (from: TTSEngine, to: TTSEngine) => void;
  onModelProgress?: (progress: number) => void;
  onModelLoaded?: () => void;
}

/**
 * Web Speech API TTS 引擎
 */
class WebSpeechTTSEngine {
  private utterance: SpeechSynthesisUtterance | null = null;
  private paused = false;
  private voice: SpeechSynthesisVoice | null = null;

  setVoice(voiceId: string) {
    const voices = speechSynthesis.getVoices();
    this.voice = voices.find(v => v.voiceURI === voiceId) || null;
  }

  speak(text: string, speed: number, volume: number, pitch: number, callbacks: TTSPlaybackCallbacks): void {
    this.stop();
    this.utterance = new SpeechSynthesisUtterance(text);
    this.utterance.rate = speed;
    this.utterance.volume = volume;
    this.utterance.pitch = pitch;
    this.utterance.lang = "zh-CN";
    if (this.voice) this.utterance.voice = this.voice;
    this.utterance.onstart = () => callbacks.onPlay?.();
    this.utterance.onend = () => callbacks.onEnd?.();
    this.utterance.onerror = (e) => {
      if (e.error !== "canceled") callbacks.onError?.(e.error);
    };
    speechSynthesis.speak(this.utterance);
    this.paused = false;
  }

  pause(): void {
    if (speechSynthesis.speaking) { speechSynthesis.pause(); this.paused = true; }
  }
  resume(): void { if (this.paused) { speechSynthesis.resume(); this.paused = false; } }
  stop(): void { speechSynthesis.cancel(); this.utterance = null; this.paused = false; }
  isSpeaking(): boolean { return speechSynthesis.speaking; }
  isPaused(): boolean { return this.paused; }
  destroy(): void { this.stop(); }
}

/**
 * ZipVoice TTS 引擎（通过 Web Audio API 播放）
 */
class ZipVoiceTTSEngine {
  private audioContext: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private paused = false;
  private stopped = false;
  private pausedAt = 0;
  private startedAt = 0;
  private currentBuffer: AudioBuffer | null = null;
  private voice = "0";
  private pendingPlayResolve: (() => void) | null = null;

  setVoice(voiceId: string) { this.voice = voiceId; }

  private getAudioContext(): AudioContext {
    if (!this.audioContext) this.audioContext = new AudioContext();
    return this.audioContext;
  }

  async ensureResumed(): Promise<void> {
    const ctx = this.getAudioContext();
    if (ctx.state === "suspended") await ctx.resume();
  }

  private playOneBuffer(buffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      const ctx = this.getAudioContext();
      const startPlayback = () => {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        this.currentSource = source;
        this.currentBuffer = buffer;
        this.startedAt = ctx.currentTime;
        this.pausedAt = 0;
        this.paused = false;
        this.pendingPlayResolve = resolve;
        source.onended = () => {
          this.currentSource = null;
          if (!this.paused) { this.currentBuffer = null; this.pendingPlayResolve = null; resolve(); }
        };
        source.start();
      };
      if (ctx.state === "suspended") ctx.resume().then(startPlayback);
      else startPlayback();
    });
  }

  async speak(text: string, speed: number, callbacks: TTSPlaybackCallbacks): Promise<void> {
    this.stop();
    this.stopped = false;
    const ctx = this.getAudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    let firstChunk = true;
    try {
      await generateAudio(text, { voice: this.voice, speed }, async (audioData) => {
        if (this.stopped) return;
        const buffer = ctx.createBuffer(1, audioData.length, 24000);
        buffer.copyToChannel(new Float32Array(audioData), 0);
        if (firstChunk) { firstChunk = false; callbacks.onPlay?.(); }
        await this.playOneBuffer(buffer);
      });
      if (!this.stopped) callbacks.onEnd?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      callbacks.onError?.(`音频生成失败: ${msg}`);
    }
  }

  pause(): void {
    if (this.currentSource && !this.paused) {
      const ctx = this.getAudioContext();
      this.pausedAt = ctx.currentTime - this.startedAt;
      this.currentSource.stop();
      this.currentSource = null;
      this.paused = true;
    }
  }

  async resume(): Promise<void> {
    if (this.paused && this.currentBuffer) {
      const ctx = this.getAudioContext();
      if (ctx.state === "suspended") await ctx.resume();
      const source = ctx.createBufferSource();
      source.buffer = this.currentBuffer;
      source.connect(ctx.destination);
      const resolve = this.pendingPlayResolve;
      source.onended = () => { this.currentSource = null; this.currentBuffer = null; this.pendingPlayResolve = null; resolve?.(); };
      this.currentSource = source;
      this.startedAt = ctx.currentTime - this.pausedAt;
      this.paused = false;
      source.start(0, this.pausedAt);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.currentSource) { try { this.currentSource.stop(); } catch {} this.currentSource = null; }
    if (this.pendingPlayResolve) { this.pendingPlayResolve(); this.pendingPlayResolve = null; }
    this.currentBuffer = null;
    this.paused = false;
    this.pausedAt = 0;
  }

  isSpeaking(): boolean { return this.currentSource !== null && !this.paused; }
  isPaused(): boolean { return this.paused; }
  destroy(): void {
    this.stop();
    if (this.audioContext) { this.audioContext.close().catch(() => {}); this.audioContext = null; }
  }
}

/**
 * TTS 管理器（支持流式播放）
 */
export class TTSManager {
  private engine: TTSEngine = "webspeech";
  private webSpeech: WebSpeechTTSEngine;
  private zipvoice: ZipVoiceTTSEngine | null = null;
  private chunks: TTSChunk[] = [];
  private currentChunkIndex = 0;
  private callbacks: TTSPlaybackCallbacks = {};
  private speed = 1.0;
  private volume = 1.0;
  private pitch = 1.0;
  private voiceId = "0";
  private stopped = false;
  private generationId = 0;

  constructor() { this.webSpeech = new WebSpeechTTSEngine(); }

  setEngine(engine: TTSEngine) { this.engine = engine; }

  setVoice(voiceId: string) {
    this.voiceId = voiceId;
    if (this.engine === "webspeech") this.webSpeech.setVoice(voiceId);
    else if (this.zipvoice) this.zipvoice.setVoice(voiceId);
  }

  setSpeed(speed: number) { this.speed = Math.max(0.5, Math.min(3.0, speed)); }
  setVolume(volume: number) { this.volume = Math.max(0, Math.min(1, volume)); }
  setPitch(pitch: number) { this.pitch = Math.max(0.5, Math.min(2.0, pitch)); }

  async speak(chunks: TTSChunk[], callbacks: TTSPlaybackCallbacks): Promise<void> {
    // B2: 先保存旧回调，stop后再设置新回调，避免 onStop 丢失
    const oldCallbacks = this.callbacks;
    this.stop();
    oldCallbacks.onStop?.();
    this.chunks = chunks;
    this.currentChunkIndex = 0;
    this.callbacks = callbacks;
    this.stopped = false;
    this.generationId++;

    if (chunks.length === 0) { callbacks.onError?.("没有可朗读的内容"); return; }

    if (this.engine === "zipvoice") {
      try {
        if (!this.zipvoice) this.zipvoice = new ZipVoiceTTSEngine();
        this.zipvoice.setVoice(this.voiceId);
        await this.zipvoice.ensureResumed();

        if (!isModelLoaded()) {
          const genBeforeLoad = this.generationId;
          callbacks.onModelProgress?.(0);
          await loadModel({ onProgress: (p) => callbacks.onModelProgress?.(p) });
          if (this.generationId !== genBeforeLoad) return;
          callbacks.onModelLoaded?.();
        }
      } catch (err) {
        console.warn("[TTS] ZipVoice 加载失败，降级到 Web Speech API:", err);
        this.engine = "webspeech";
        callbacks.onFallback?.("zipvoice", "webspeech");
      }
    }

    await this.speakNextChunk();
  }

  private async speakNextChunk(): Promise<void> {
    if (this.stopped) return;
    if (this.currentChunkIndex >= this.chunks.length) { this.callbacks.onEnd?.(); return; }

    const chunk = this.chunks[this.currentChunkIndex];
    const genId = this.generationId;
    this.callbacks.onChunkStart?.(this.currentChunkIndex, this.chunks.length);

    if (this.engine === "zipvoice" && this.zipvoice) {
      await new Promise(r => setTimeout(r, 0));
      await this.zipvoice.speak(chunk.text, this.speed, {
        onPlay: () => this.callbacks.onPlay?.(),
        onEnd: () => {
          if (this.stopped || this.generationId !== genId) return;
          this.callbacks.onChunkEnd?.(this.currentChunkIndex, this.chunks.length);
          this.currentChunkIndex++;
          this.speakNextChunk();
        },
        onError: (err) => this.callbacks.onError?.(err),
      });
    } else {
      this.webSpeech.speak(chunk.text, this.speed, this.volume, this.pitch, {
        onPlay: () => this.callbacks.onPlay?.(),
        onEnd: () => {
          if (this.stopped || this.generationId !== genId) return;
          this.callbacks.onChunkEnd?.(this.currentChunkIndex, this.chunks.length);
          this.currentChunkIndex++;
          this.speakNextChunk();
        },
        onError: (err) => this.callbacks.onError?.(err),
      });
    }
  }

  pause(): void {
    if (this.engine === "zipvoice" && this.zipvoice) this.zipvoice.pause();
    else this.webSpeech.pause();
    this.callbacks.onPause?.();
  }

  async resume(): Promise<void> {
    if (this.engine === "zipvoice" && this.zipvoice) await this.zipvoice.resume();
    else this.webSpeech.resume();
    this.callbacks.onResume?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.zipvoice) this.zipvoice.stop();
    this.webSpeech.stop();
    this.callbacks.onStop?.();
  }

  /** U5: 获取当前播放段落索引（供错误重试使用） */
  getCurrentChunkIndex(): number { return this.currentChunkIndex; }

  seekToChunk(index: number): void {
    if (index >= 0 && index < this.chunks.length) {
      // H8 fix: 先递增 generationId 使旧链路的所有回调失效，再停止旧播放
      this.generationId++;
      this.stopped = true;
      if (this.zipvoice) this.zipvoice.stop();
      this.webSpeech.stop();
      this.currentChunkIndex = index;
      // 使用 setTimeout 确保旧链路的同步回调（如 onChunk）先执行完毕
      setTimeout(() => {
        this.stopped = false;
        this.speakNextChunk();
      }, 0);
    }
  }

  isPlaying(): boolean {
    if (this.engine === "zipvoice" && this.zipvoice) return this.zipvoice.isSpeaking();
    return this.webSpeech.isSpeaking() && !this.webSpeech.isPaused();
  }

  isPaused(): boolean {
    if (this.engine === "zipvoice" && this.zipvoice) return this.zipvoice.isPaused();
    return this.webSpeech.isPaused();
  }

  destroy(): void {
    this.stopped = true;
    this.generationId++;
    if (this.zipvoice) { this.zipvoice.destroy(); this.zipvoice = null; }
    this.webSpeech.destroy();
  }
}
