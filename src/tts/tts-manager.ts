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
  paragraphIndex: number;          // 组内第一段的原始索引（兼容）
  paragraphIndices: number[];      // 组内所有段落的原始索引
  paragraphBreaks: number[];       // 每个段落在合并文本中的起始字符位置
}

export interface TTSPlaybackCallbacks {
  onPlay?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onStop?: () => void;
  onEnd?: () => void;
  onChunkStart?: (index: number, total: number, paragraphIndex: number) => void;
  onChunkEnd?: (index: number, total: number, paragraphIndex: number) => void;
  onParagraphChange?: (paragraphIndex: number) => void;
  onError?: (error: string) => void;
  onFallback?: (from: TTSEngine, to: TTSEngine) => void;
  onModelProgress?: (progress: number) => void;
  onModelLoaded?: () => void;
  onVoicesLoaded?: (voices: SpeechSynthesisVoice[]) => void;
}

/**
 * Web Speech API TTS 引擎
 * 段落追踪：优先使用 onboundary 字符位置映射，检测到不可用时降级为校准语速估算
 */
class WebSpeechTTSEngine {
  private utterance: SpeechSynthesisUtterance | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private pendingVoiceId: string | null = null;
  private available = typeof speechSynthesis !== "undefined";
  private paraTimer: ReturnType<typeof setInterval> | null = null;

  // 段落追踪状态
  private boundaryEventCount = 0;
  private onboundaryAvailable = false;
  private boundaryDetectionDone = false;
  private calibratedCharsPerSec = 4; // 默认值，会被首个 onboundary 事件校准
  private chunkStartTime = 0;

  setVoice(voiceId: string) {
    if (!this.available) return;
    this.pendingVoiceId = voiceId;
    const voices = speechSynthesis.getVoices();
    if (voices.length > 0) {
      this.voice = voices.find(v => v.voiceURI === voiceId) || null;
      this.pendingVoiceId = null;
    }
  }

  private ensureVoice(): void {
    if (this.pendingVoiceId) {
      const voices = speechSynthesis.getVoices();
      if (voices.length > 0) {
        this.voice = voices.find(v => v.voiceURI === this.pendingVoiceId) || null;
        this.pendingVoiceId = null;
      }
    }
  }

  async waitForVoices(): Promise<SpeechSynthesisVoice[]> {
    if (!this.available) return [];
    if (speechSynthesis.getVoices().length > 0) return speechSynthesis.getVoices();
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => resolve(), 10000);
      const handler = () => {
        clearTimeout(timeout);
        speechSynthesis.removeEventListener("voiceschanged", handler);
        clearInterval(poll);
        resolve();
      };
      speechSynthesis.addEventListener("voiceschanged", handler);
      const poll = setInterval(() => {
        if (speechSynthesis.getVoices().length > 0) handler();
      }, 500);
    });
    this.ensureVoice();
    return speechSynthesis.getVoices();
  }

  // ── 段落追踪：字符位置映射 ──

  /** 二分查找：charIndex → paragraphBreaks 中的段落索引 */
  private findParagraphByCharIndex(charIdx: number, breaks: number[]): number {
    let lo = 0, hi = breaks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (breaks[mid] <= charIdx) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** 从已用时间估算当前字符位置，再映射到段落（降级方案） */
  private estimateParagraphFromTime(
    elapsedMs: number, text: string, speed: number,
    breaks: number[], indices: number[],
  ): number {
    const charsPerSec = this.calibratedCharsPerSec * Math.max(0.5, Math.min(3, speed));
    const charPos = Math.min(Math.floor((elapsedMs / 1000) * charsPerSec), text.length - 1);
    return indices[this.findParagraphByCharIndex(charPos, breaks)];
  }

  /** 启动降级定时器（onboundary 不可用时使用） */
  private startFallbackTimer(
    text: string, speed: number,
    breaks: number[], indices: number[],
    onParagraphChange: ((paraIdx: number) => void) | undefined,
  ): void {
    if (!onParagraphChange || indices.length <= 1) return;
    this.clearParaTimer();
    const startTime = performance.now();
    let lastParaIdx = indices[0];
    this.paraTimer = setInterval(() => {
      const elapsed = performance.now() - startTime;
      const paraIdx = this.estimateParagraphFromTime(elapsed, text, speed, breaks, indices);
      if (paraIdx !== lastParaIdx) {
        lastParaIdx = paraIdx;
        onParagraphChange(paraIdx);
      }
    }, 200);
  }

  private clearParaTimer(): void {
    if (this.paraTimer) { clearInterval(this.paraTimer); this.paraTimer = null; }
  }

  /** 设置段落追踪：onboundary 字符映射 + 检测降级 */
  setupParagraphTracking(
    utterance: SpeechSynthesisUtterance,
    breaks: number[],
    indices: number[],
    onParagraphChange: ((paraIndex: number) => void) | undefined,
    text: string,
    speed: number,
  ): void {
    if (!onParagraphChange || indices.length <= 1) return;

    // 重置检测状态
    this.boundaryEventCount = 0;
    this.onboundaryAvailable = false;
    this.boundaryDetectionDone = false;
    this.chunkStartTime = performance.now();

    utterance.onboundary = (e: SpeechSynthesisEvent) => {
      if (e.charIndex === undefined) return;
      this.boundaryEventCount++;

      // 首次收到 onboundary：校准语速
      if (!this.boundaryDetectionDone) {
        this.boundaryDetectionDone = true;
        this.onboundaryAvailable = true;
        const elapsed = (performance.now() - this.chunkStartTime) / 1000;
        if (elapsed > 0.1) {
          this.calibratedCharsPerSec = e.charIndex / elapsed;
        }
        // 检测完成，停止降级定时器（如果已启动）
        this.clearParaTimer();
      }

      // 字符位置 → 段落映射（二分查找）
      const paraIdx = this.findParagraphByCharIndex(e.charIndex, breaks);
      if (paraIdx >= 0 && paraIdx < indices.length) {
        onParagraphChange(indices[paraIdx]);
      }
    };

    // 启动降级检测：播放 1.5 秒后如果没有收到 onboundary，启动定时器
    setTimeout(() => {
      if (!this.boundaryDetectionDone) {
        this.boundaryDetectionDone = true;
        this.onboundaryAvailable = false;
        this.startFallbackTimer(text, speed, breaks, indices, onParagraphChange);
      }
    }, 1500);
  }

  speak(
    text: string, speed: number, volume: number, pitch: number,
    callbacks: TTSPlaybackCallbacks,
    paragraphBreaks?: number[], paragraphIndices?: number[],
  ): void {
    if (!this.available) { callbacks.onError?.("Web Speech API 不可用"); return; }
    this.stop();
    this.ensureVoice();
    this.utterance = new SpeechSynthesisUtterance(text);
    this.utterance.rate = speed;
    this.utterance.volume = volume;
    this.utterance.pitch = pitch;
    this.utterance.lang = "zh-CN";
    if (this.voice) this.utterance.voice = this.voice;

    if (paragraphBreaks && paragraphIndices && paragraphIndices.length > 1) {
      this.utterance.onstart = () => callbacks.onPlay?.();
      this.utterance.onend = () => {
        this.clearParaTimer();
        callbacks.onEnd?.();
      };
      this.utterance.onerror = (e) => {
        this.clearParaTimer();
        if (e.error !== "canceled" && e.error !== "interrupted") callbacks.onError?.(e.error);
      };
      this.setupParagraphTracking(
        this.utterance, paragraphBreaks, paragraphIndices,
        callbacks.onParagraphChange, text, speed,
      );
    } else {
      this.utterance.onstart = () => callbacks.onPlay?.();
      this.utterance.onend = () => callbacks.onEnd?.();
      this.utterance.onerror = (e) => {
        if (e.error !== "canceled" && e.error !== "interrupted") callbacks.onError?.(e.error);
      };
    }
    speechSynthesis.speak(this.utterance);
  }

  /** 顺序播放下一段（不使用预队列，移动端兼容性更好） */
  queue(
    text: string, speed: number, volume: number, pitch: number,
    onStart: () => void, onEnd: () => void, onError: (err: string) => void,
    paragraphBreaks?: number[], paragraphIndices?: number[],
    onParagraphChange?: (paraIndex: number) => void,
  ): void {
    if (!this.available) return;
    this.ensureVoice();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = speed;
    utterance.volume = volume;
    utterance.pitch = pitch;
    utterance.lang = "zh-CN";
    if (this.voice) utterance.voice = this.voice;

    if (paragraphBreaks && paragraphIndices && paragraphIndices.length > 1) {
      utterance.onstart = () => onStart();
      utterance.onend = () => {
        this.clearParaTimer();
        onEnd();
      };
      utterance.onerror = (e) => {
        this.clearParaTimer();
        if (e.error !== "canceled" && e.error !== "interrupted") onError(e.error);
      };
      this.setupParagraphTracking(
        utterance, paragraphBreaks, paragraphIndices,
        onParagraphChange, text, speed,
      );
    } else {
      utterance.onstart = () => onStart();
      utterance.onend = () => onEnd();
      utterance.onerror = (e) => {
        if (e.error !== "canceled" && e.error !== "interrupted") onError(e.error);
      };
    }
    speechSynthesis.speak(utterance);
  }

  stop(): void {
    this.clearParaTimer();
    if (this.available) speechSynthesis.cancel();
    this.utterance = null;
  }
  isSpeaking(): boolean { return this.available ? speechSynthesis.speaking : false; }
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
        source.onended = () => {
          this.currentSource = null;
          if (!this.paused) { this.currentBuffer = null; this.pendingPlayResolve = null; resolve(); }
        };
        source.start();
        this.pendingPlayResolve = resolve;
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
      try {
        const ctx = this.getAudioContext();
        this.pausedAt = ctx.currentTime - this.startedAt;
        this.currentSource.stop();
      } catch { /* already stopped */ }
      this.currentSource = null;
      this.paused = true;
    }
  }

  async resume(): Promise<void> {
    if (this.paused && this.currentBuffer) {
      try {
        const ctx = this.getAudioContext();
        if (ctx.state === "suspended") await ctx.resume();
        const source = ctx.createBufferSource();
        source.buffer = this.currentBuffer;
        source.connect(ctx.destination);
        const resolve = this.pendingPlayResolve;
        source.onended = () => { this.currentSource = null; if (!this.paused) { this.currentBuffer = null; this.pendingPlayResolve = null; resolve?.(); } };
        this.currentSource = source;
        this.startedAt = ctx.currentTime - this.pausedAt;
        this.paused = false;
        source.start(0, this.pausedAt);
      } catch { /* context closed, buffer detached */ }
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
  private currentParagraphIndex = 0;
  private callbacks: TTSPlaybackCallbacks = {};
  private speed = 1.0;
  private volume = 1.0;
  private pitch = 1.0;
  private voiceId = "0";
  private stopped = false;
  private generationId = 0;
  private seekId = 0;
  private userPaused = false;

  constructor() { this.webSpeech = new WebSpeechTTSEngine(); }

  setEngine(engine: TTSEngine) { this.engine = engine; }

  setVoice(voiceId: string) {
    this.voiceId = voiceId;
    if (this.engine === "webspeech") {
      this.webSpeech.setVoice(voiceId);
      if (this.webSpeech.isSpeaking() && this.currentChunkIndex < this.chunks.length) {
        this.generationId++;
        this.webSpeech.stop();
        this.speakNextChunk();
      }
    } else if (this.zipvoice) this.zipvoice.setVoice(voiceId);
  }

  setSpeed(speed: number) {
    this.speed = Math.max(0.5, Math.min(3.0, speed));
    // 速度变更时从当前段落位置恢复，不从 chunk 头部重读
    if (this.engine === "webspeech" && this.webSpeech.isSpeaking()) {
      const para = this.currentParagraphIndex;
      this.generationId++;
      this.webSpeech.stop();
      this.speakFromParagraph(para);
    }
  }
  setVolume(volume: number) { this.volume = Math.max(0, Math.min(1, volume)); }
  setPitch(pitch: number) {
    this.pitch = Math.max(0.5, Math.min(2.0, pitch));
    // 音调变更同理，从当前段落恢复
    if (this.engine === "webspeech" && this.webSpeech.isSpeaking()) {
      const para = this.currentParagraphIndex;
      this.generationId++;
      this.webSpeech.stop();
      this.speakFromParagraph(para);
    }
  }

  /** 从指定段落位置开始朗读（用于速度/音调变更后的恢复） */
  private speakFromParagraph(paraIndex: number): void {
    // 找到包含该段落的 chunk
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i].paragraphIndices.includes(paraIndex)) {
        this.currentChunkIndex = i;
        this.currentParagraphIndex = paraIndex;
        this.speakNextChunk();
        return;
      }
    }
    // 找不到则从当前 chunk 继续
    this.speakNextChunk();
  }

  async speak(chunks: TTSChunk[], callbacks: TTSPlaybackCallbacks): Promise<void> {
    this.stop();
    this.chunks = chunks;
    this.currentChunkIndex = 0;
    this.currentParagraphIndex = 0;
    this.callbacks = callbacks;
    this.stopped = false;
    this.generationId++;

    if (chunks.length === 0) { callbacks.onError?.("没有可朗读的内容"); return; }

    if (this.engine === "webspeech") {
      const loadedVoices = await this.webSpeech.waitForVoices();
      if (loadedVoices.length > 0) callbacks.onVoicesLoaded?.(loadedVoices);
    }

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
    if (this.userPaused) return; // R13: 暂停状态下不推进 chunk
    if (this.currentChunkIndex >= this.chunks.length) { this.callbacks.onEnd?.(); return; }

    const chunk = this.chunks[this.currentChunkIndex];
    const genId = this.generationId;

    if (this.engine === "zipvoice" && this.zipvoice) {
      this.callbacks.onChunkStart?.(this.currentChunkIndex, this.chunks.length, chunk.paragraphIndex);
      await new Promise(r => setTimeout(r, 0));
      await this.zipvoice.speak(chunk.text, this.speed, {
        onPlay: () => {
          if (this.stopped || this.generationId !== genId) return;
          this.callbacks.onPlay?.();
        },
        onEnd: () => {
          if (this.stopped || this.generationId !== genId) return;
          this.callbacks.onChunkEnd?.(this.currentChunkIndex, this.chunks.length, chunk.paragraphIndex);
          this.currentChunkIndex++;
          this.speakNextChunk();
        },
        onError: (err) => {
          if (this.stopped || this.generationId !== genId) return;
          this.callbacks.onError?.(err);
        },
      });
    } else {
      // 顺序播放：chunk 完成后立即播放下一个（不使用预队列）
      this.callbacks.onChunkStart?.(this.currentChunkIndex, this.chunks.length, chunk.paragraphIndex);
      this.webSpeech.speak(chunk.text, this.speed, this.volume, this.pitch, {
        onPlay: () => {
          if (this.stopped || this.generationId !== genId) return;
          this.callbacks.onPlay?.();
        },
        onEnd: () => this.handleChunkEnded(genId),
        onError: (err) => this.handleChunkError(err, genId),
        onParagraphChange: (paraIdx) => {
          if (this.stopped || this.generationId !== genId) return;
          this.currentParagraphIndex = paraIdx;
          this.callbacks.onParagraphChange?.(paraIdx);
        },
      }, chunk.paragraphBreaks, chunk.paragraphIndices);
    }
  }

  private handleChunkEnded(genId: number): void {
    if (this.stopped || this.generationId !== genId) return;
    const chunk = this.chunks[this.currentChunkIndex];
    const lastIdx = chunk?.paragraphIndices?.length
      ? chunk.paragraphIndices[chunk.paragraphIndices.length - 1]
      : chunk?.paragraphIndex ?? 0;
    this.callbacks.onChunkEnd?.(this.currentChunkIndex, this.chunks.length, lastIdx);
    this.currentChunkIndex++;
    this.speakNextChunk();
  }

  private handleChunkError(err: string, genId: number): void {
    if (this.stopped || this.generationId !== genId) return;
    this.callbacks.onError?.(err);
  }

  pause(): void {
    if (this.engine === "zipvoice" && this.zipvoice) this.zipvoice.pause();
    else {
      // Web Speech API：保存当前段落位置，cancel 后恢复时从该位置继续
      this.webSpeech.stop();
    }
    this.userPaused = true;
    this.callbacks.onPause?.();
  }

  async resume(): Promise<void> {
    if (this.engine === "zipvoice" && this.zipvoice) await this.zipvoice.resume();
    else {
      this.webSpeech.stop();
      this.userPaused = false;
      // 从当前段落位置恢复（不是从 chunk 头部）
      this.speakFromParagraph(this.currentParagraphIndex);
    }
    this.callbacks.onResume?.();
  }

  stop(): void {
    this.stopped = true;
    this.userPaused = false;
    this.generationId++;
    this.seekId++;
    this.currentParagraphIndex = 0;
    if (this.zipvoice) this.zipvoice.stop();
    this.webSpeech.stop();
    this.callbacks.onStop?.();
  }

  getCurrentChunkIndex(): number { return this.currentChunkIndex; }
  getCurrentGenerationId(): number { return this.generationId; }

  seekToChunk(index: number): void {
    if (index >= 0 && index < this.chunks.length) {
      this.generationId++;
      this.userPaused = false;
      this.stopped = true;
      if (this.zipvoice) this.zipvoice.stop();
      this.webSpeech.stop();
      this.currentChunkIndex = index;
      this.currentParagraphIndex = this.chunks[index]?.paragraphIndex ?? 0;
      const sid = ++this.seekId;
      setTimeout(() => {
        if (this.seekId !== sid) return;
        this.stopped = false;
        this.speakNextChunk();
      }, 0);
    }
  }

  isPlaying(): boolean {
    if (this.engine === "zipvoice" && this.zipvoice) return this.zipvoice.isSpeaking();
    return this.webSpeech.isSpeaking();
  }

  isPaused(): boolean {
    if (this.engine === "zipvoice" && this.zipvoice) return this.zipvoice.isPaused();
    return this.userPaused;
  }

  destroy(): void {
    this.stopped = true;
    this.userPaused = false;
    this.generationId++;
    if (this.zipvoice) { this.zipvoice.destroy(); this.zipvoice = null; }
    this.webSpeech.destroy();
    this.callbacks.onStop?.();
  }
}
