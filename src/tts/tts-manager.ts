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
 */
class WebSpeechTTSEngine {
  private utterance: SpeechSynthesisUtterance | null = null;
  private preQueued: SpeechSynthesisUtterance | null = null;
  private paused = false;
  private voice: SpeechSynthesisVoice | null = null;
  private pendingVoiceId: string | null = null;
  private available = typeof speechSynthesis !== "undefined";
  /** R13: 合并段段落高亮定时回退（移动端 onboundary 不可靠） */
  private paraTimer: ReturnType<typeof setInterval> | null = null;

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

  /** R13: 启动合并段段落高亮定时回退 */
  private startParaTimer(
    text: string, speed: number,
    paragraphBreaks: number[], paragraphIndices: number[],
    onParagraphChange: ((paraIdx: number) => void) | undefined,
  ): void {
    if (!onParagraphChange || paragraphIndices.length <= 1) return;
    this.clearParaTimer();
    // 估算：中文朗读 ~4 字/秒 @ 1x，线性扩展
    const totalChars = text.length;
    const charsPerSec = 4 * Math.max(0.5, Math.min(3, speed));
    const estTotalMs = (totalChars / charsPerSec) * 1000;
    // 计算每段累计估计结束时间（毫秒）
    const paraEndMs: number[] = [];
    let cumChars = 0;
    for (let i = 0; i < paragraphIndices.length; i++) {
      const start = paragraphBreaks[i];
      const end = i < paragraphBreaks.length - 1 ? paragraphBreaks[i + 1] : totalChars;
      cumChars += end - start;
      paraEndMs.push((cumChars / totalChars) * estTotalMs);
    }
    const startTime = performance.now();
    let steppedPara = 0; // 已推进到段落 steppedPara
    this.paraTimer = setInterval(() => {
      const elapsed = performance.now() - startTime;
      while (steppedPara < paragraphIndices.length - 1 && elapsed >= paraEndMs[steppedPara]) {
        steppedPara++;
        onParagraphChange(paragraphIndices[steppedPara]);
      }
    }, 250);
  }

  private clearParaTimer(): void {
    if (this.paraTimer) { clearInterval(this.paraTimer); this.paraTimer = null; }
  }

  setupParagraphTracking(
    utterance: SpeechSynthesisUtterance,
    breaks: number[],
    indices: number[],
    onParagraphChange: ((paraIndex: number) => void) | undefined,
  ): void {
    if (!onParagraphChange || indices.length <= 1) return;
    let currentTracked = 0;
    utterance.onboundary = (e: SpeechSynthesisEvent) => {
      if (e.charIndex === undefined) return;
      const ci = e.charIndex;
      let newIdx = 0;
      for (let i = breaks.length - 1; i >= 0; i--) {
        if (ci >= breaks[i]) { newIdx = i; break; }
      }
      // R13: 不后退（定时估算可能已推进到后续段落，onboundary 不应覆盖回退）
      if (newIdx !== currentTracked && newIdx > currentTracked) {
        currentTracked = newIdx;
        onParagraphChange(indices[newIdx]);
      }
    };
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
    // R13: 合并段启动定时回退（移动端 onboundary 不触发时的兜底高亮）
    if (paragraphBreaks && paragraphIndices && paragraphIndices.length > 1) {
      this.utterance.onstart = () => {
        callbacks.onPlay?.();
        this.startParaTimer(text, speed, paragraphBreaks, paragraphIndices, callbacks.onParagraphChange);
      };
      this.utterance.onend = () => {
        this.clearParaTimer();
        callbacks.onEnd?.();
      };
      this.utterance.onerror = (e) => {
        this.clearParaTimer();
        if (e.error !== "canceled" && e.error !== "interrupted") callbacks.onError?.(e.error);
      };
      this.setupParagraphTracking(this.utterance, paragraphBreaks, paragraphIndices, callbacks.onParagraphChange);
    } else {
      this.utterance.onstart = () => callbacks.onPlay?.();
      this.utterance.onend = () => callbacks.onEnd?.();
      this.utterance.onerror = (e) => {
        if (e.error !== "canceled" && e.error !== "interrupted") callbacks.onError?.(e.error);
      };
    }
    speechSynthesis.speak(this.utterance);
    this.paused = false;
  }

  // U6: 预队列下一段 utterance（不 cancel 当前，浏览器自动衔接）
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
    // R13: 合并段预队列也启动定时回退
    if (paragraphBreaks && paragraphIndices && paragraphIndices.length > 1) {
      let qTimer: ReturnType<typeof setInterval> | null = null;
      utterance.onstart = () => {
        onStart();
        // 预队列段的定时推进（使用独立闭包而非引擎的 paraTimer）
        const totalChars = text.length;
        const charsPerSec = 4 * Math.max(0.5, Math.min(3, speed));
        const estTotalMs = (totalChars / charsPerSec) * 1000;
        const paraEndMs: number[] = [];
        let cumChars = 0;
        for (let i = 0; i < paragraphIndices.length; i++) {
          const start = paragraphBreaks[i];
          const end = i < paragraphBreaks.length - 1 ? paragraphBreaks[i + 1] : totalChars;
          cumChars += end - start;
          paraEndMs.push((cumChars / totalChars) * estTotalMs);
        }
        const startT = performance.now();
        let stepped = 0;
        qTimer = setInterval(() => {
          const elapsed = performance.now() - startT;
          while (stepped < paragraphIndices.length - 1 && elapsed >= paraEndMs[stepped]) {
            stepped++;
            onParagraphChange?.(paragraphIndices[stepped]);
          }
        }, 250);
      };
      utterance.onend = () => {
        if (qTimer) { clearInterval(qTimer); qTimer = null; }
        onEnd();
      };
      utterance.onerror = (e) => {
        if (qTimer) { clearInterval(qTimer); qTimer = null; }
        if (e.error !== "canceled" && e.error !== "interrupted") onError(e.error);
      };
      this.setupParagraphTracking(utterance, paragraphBreaks, paragraphIndices, onParagraphChange);
    } else {
      utterance.onstart = () => onStart();
      utterance.onend = () => onEnd();
      utterance.onerror = (e) => {
        if (e.error !== "canceled" && e.error !== "interrupted") onError(e.error);
      };
    }
    this.preQueued = utterance;
    speechSynthesis.speak(utterance);
  }

  pause(): void {
    if (this.available && speechSynthesis.speaking) { speechSynthesis.pause(); this.paused = true; }
  }
  resume(): void { if (this.available && this.paused) { speechSynthesis.resume(); this.paused = false; } }
  stop(): void {
    this.clearParaTimer();
    if (this.available) speechSynthesis.cancel();
    this.utterance = null; this.preQueued = null; this.paused = false;
  }
  isSpeaking(): boolean { return this.available ? speechSynthesis.speaking : false; }
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
  private callbacks: TTSPlaybackCallbacks = {};
  private speed = 1.0;
  private volume = 1.0;
  private pitch = 1.0;
  private voiceId = "0";
  private stopped = false;
  private generationId = 0;
  private seekId = 0;
  private currentChunkWasPreQueued = false;
  private userPaused = false;

  constructor() { this.webSpeech = new WebSpeechTTSEngine(); }

  setEngine(engine: TTSEngine) { this.engine = engine; }

  setVoice(voiceId: string) {
    this.voiceId = voiceId;
    if (this.engine === "webspeech") {
      this.webSpeech.setVoice(voiceId);
      if (this.webSpeech.isSpeaking() && this.currentChunkIndex < this.chunks.length) {
        this.generationId++;
        this.currentChunkWasPreQueued = false;
        this.webSpeech.stop();
        this.speakNextChunk();
      }
    } else if (this.zipvoice) this.zipvoice.setVoice(voiceId);
  }

  setSpeed(speed: number) {
    this.speed = Math.max(0.5, Math.min(3.0, speed));
    this.restartIfPlaying();
  }
  setVolume(volume: number) { this.volume = Math.max(0, Math.min(1, volume)); }
  setPitch(pitch: number) {
    this.pitch = Math.max(0.5, Math.min(2.0, pitch));
    this.restartIfPlaying();
  }

  private restartIfPlaying(): void {
    if (this.engine === "webspeech" && this.webSpeech.isSpeaking() && this.currentChunkIndex < this.chunks.length) {
      this.generationId++;
      this.currentChunkWasPreQueued = false;
      this.webSpeech.stop();
      this.speakNextChunk();
    }
  }

  async speak(chunks: TTSChunk[], callbacks: TTSPlaybackCallbacks): Promise<void> {
    this.stop();
    this.chunks = chunks;
    this.currentChunkIndex = 0;
    this.callbacks = callbacks;
    this.stopped = false;
    this.currentChunkWasPreQueued = false;
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
      // U6: WebSpeech 预队列模式 — 播当前段的同时预队列下一段，消除段落间停顿
      // R13: 合并段保留单 utterance（无停顿感），段落高亮通过定时回退推进（移动端 onboundary 兜底）
      if (this.currentChunkWasPreQueued) {
        this.currentChunkWasPreQueued = false;
        this.preQueueNextIfAvailable(genId);
      } else {
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
            this.callbacks.onParagraphChange?.(paraIdx);
          },
        }, chunk.paragraphBreaks, chunk.paragraphIndices);
        this.preQueueNextIfAvailable(genId);
      }
    }
  }

  private preQueueNextIfAvailable(genId: number): void {
    const nextIdx = this.currentChunkIndex + 1;
    if (nextIdx >= this.chunks.length) return;
    const nextChunk = this.chunks[nextIdx];
    this.webSpeech.queue(
      nextChunk.text, this.speed, this.volume, this.pitch,
      () => {
        if (this.stopped || this.generationId !== genId) return;
        this.callbacks.onChunkStart?.(nextIdx, this.chunks.length, nextChunk.paragraphIndex);
      },
      () => this.handleChunkEnded(genId),
      (err) => this.handleChunkError(err, genId),
      nextChunk.paragraphBreaks, nextChunk.paragraphIndices,
      (paraIdx) => {
        if (this.stopped || this.generationId !== genId) return;
        this.callbacks.onParagraphChange?.(paraIdx);
      },
    );
    this.currentChunkWasPreQueued = true;
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
      this.webSpeech.stop();
      this.currentChunkWasPreQueued = false;
    }
    this.userPaused = true;
    this.callbacks.onPause?.();
  }

  async resume(): Promise<void> {
    if (this.engine === "zipvoice" && this.zipvoice) await this.zipvoice.resume();
    else {
      this.webSpeech.stop();
      this.currentChunkWasPreQueued = false;
      this.userPaused = false;
      this.speakNextChunk();
    }
    this.callbacks.onResume?.();
  }

  stop(): void {
    this.stopped = true;
    this.userPaused = false;
    this.generationId++;
    this.seekId++;
    this.currentChunkWasPreQueued = false;
    if (this.zipvoice) this.zipvoice.stop();
    this.webSpeech.stop();
    this.callbacks.onStop?.();
  }

  getCurrentChunkIndex(): number { return this.currentChunkIndex; }
  getCurrentGenerationId(): number { return this.generationId; }

  seekToChunk(index: number): void {
    if (index >= 0 && index < this.chunks.length) {
      this.generationId++;
      this.currentChunkWasPreQueued = false;
      this.userPaused = false;
      this.stopped = true;
      if (this.zipvoice) this.zipvoice.stop();
      this.webSpeech.stop();
      this.currentChunkIndex = index;
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
    return this.webSpeech.isSpeaking() && !this.webSpeech.isPaused();
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
