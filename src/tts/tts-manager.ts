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
  paragraphBreaks: number[];       // 每个段落在合并文本中的起始字符位置（用于 onboundary 逐段高亮）
}

export interface TTSPlaybackCallbacks {
  onPlay?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onStop?: () => void;
  onEnd?: () => void;
  onChunkStart?: (index: number, total: number, paragraphIndex: number) => void;
  onChunkEnd?: (index: number, total: number, paragraphIndex: number) => void;
  onParagraphChange?: (paragraphIndex: number) => void; // 合并段内段落切换（onboundary 驱动）
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

  setVoice(voiceId: string) {
    if (!this.available) return;
    this.pendingVoiceId = voiceId;
    const voices = speechSynthesis.getVoices();
    if (voices.length > 0) {
      this.voice = voices.find(v => v.voiceURI === voiceId) || null;
      this.pendingVoiceId = null;
    }
    // R12: Chrome 异步加载语音，length=0 时保留 pendingVoiceId，speak() 时重试
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

  // U8: 等待 Chrome 异步加载语音列表，确保第一段就用对音色
  async waitForVoices(): Promise<SpeechSynthesisVoice[]> {
    if (!this.available) return [];
    if (speechSynthesis.getVoices().length > 0) return speechSynthesis.getVoices();
    // 移动端 Chrome：voice 懒加载，事件+轮询双保险
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => resolve(), 10000); // 延长到 10 秒
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
    this.ensureVoice(); // 语音加载完成后解析 pendingVoiceId
    return speechSynthesis.getVoices();
  }

  // U6: 设置 onboundary 在合并段内逐段切换高亮
  private setupParagraphTracking(
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
      if (newIdx !== currentTracked) {
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
    this.utterance.onstart = () => callbacks.onPlay?.();
    this.utterance.onend = () => callbacks.onEnd?.();
    this.utterance.onerror = (e) => {
      // "interrupted" 在 seek/stop 时正常出现，不需要报错
      if (e.error !== "canceled" && e.error !== "interrupted") callbacks.onError?.(e.error);
    };
    if (paragraphBreaks && paragraphIndices) {
      this.setupParagraphTracking(this.utterance, paragraphBreaks, paragraphIndices, callbacks.onParagraphChange);
    }
    speechSynthesis.speak(this.utterance);
    this.paused = false;
  }

  /**
   * 合并段拆分朗读 — 将多段落的合并 chunk 拆成独立 utterance 一次性入列
   * 每段独立触发 onParagraphStart/onParagraphEnd，最后一段结束时触发 onAllEnd
   * 浏器内部音频队列自动无缝衔接，无停顿感
   */
  speakMerged(
    texts: string[],
    paragraphIndices: number[],
    speed: number, volume: number, pitch: number,
    callbacks: {
      onPlay: () => void;
      onParagraphStart: (paraIdx: number) => void;
      onParagraphEnd: (paraIdx: number) => void;
      onAllEnd: () => void;
      onError: (err: string) => void;
    },
  ): void {
    if (!this.available) { callbacks.onError("Web Speech API 不可用"); return; }
    this.stop();
    this.ensureVoice();
    const total = texts.length;
    if (total === 0) return;
    let playFired = false;
    for (let i = 0; i < total; i++) {
      const utterance = new SpeechSynthesisUtterance(texts[i]);
      utterance.rate = speed;
      utterance.volume = volume;
      utterance.pitch = pitch;
      utterance.lang = "zh-CN";
      if (this.voice) utterance.voice = this.voice;
      utterance.onstart = () => {
        if (!playFired) { playFired = true; callbacks.onPlay(); }
        callbacks.onParagraphStart(paragraphIndices[i]);
      };
      utterance.onend = () => {
        callbacks.onParagraphEnd(paragraphIndices[i]);
        if (i === total - 1) callbacks.onAllEnd();
      };
      utterance.onerror = (e) => {
        if (e.error !== "canceled" && e.error !== "interrupted") callbacks.onError(e.error);
      };
      if (i === 0) this.utterance = utterance;
      speechSynthesis.speak(utterance);
    }
  }

  // U6: 预队列下一段 utterance（不 cancel 当前，浏览器自动衔接）
  // R13: 支持合并段拆分 — 多段落时拆成独立 utterance 一次性入列
  queue(
    text: string, speed: number, volume: number, pitch: number,
    onStart: () => void, onEnd: () => void, onError: (err: string) => void,
    paragraphBreaks?: number[], paragraphIndices?: number[],
    onParagraphChange?: (paraIndex: number) => void,
  ): void {
    if (!this.available) return;
    this.ensureVoice();

    // 合并段：拆成独立 utterance 入列，每段触发 onParagraphChange
    if (paragraphIndices && paragraphIndices.length > 1) {
      let endedCount = 0;
      let hasStarted = false;
      for (let i = 0; i < paragraphIndices.length; i++) {
        const start = paragraphBreaks[i];
        const end = i < paragraphBreaks.length - 1 ? paragraphBreaks[i + 1] : text.length;
        let paraText = text.slice(start, end);
        if (i > 0) paraText = paraText.replace(/^[。，,、]/, "").trim();
        if (!paraText) paraText = text.slice(start, end);

        const utterance = new SpeechSynthesisUtterance(paraText);
        utterance.rate = speed;
        utterance.volume = volume;
        utterance.pitch = pitch;
        utterance.lang = "zh-CN";
        if (this.voice) utterance.voice = this.voice;
        utterance.onstart = () => {
          if (!hasStarted) { hasStarted = true; onStart(); }
          onParagraphChange?.(paragraphIndices[i]);
        };
        utterance.onend = () => {
          endedCount++;
          if (endedCount >= paragraphIndices.length) onEnd();
        };
        utterance.onerror = (e) => {
          if (e.error !== "canceled" && e.error !== "interrupted") onError(e.error);
        };
        speechSynthesis.speak(utterance);
      }
      this.preQueued = null;
      return;
    }

    // 单段：原有预队列逻辑
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = speed;
    utterance.volume = volume;
    utterance.pitch = pitch;
    utterance.lang = "zh-CN";
    if (this.voice) utterance.voice = this.voice;
    utterance.onstart = () => onStart();
    utterance.onend = () => onEnd();
    utterance.onerror = (e) => {
      if (e.error !== "canceled" && e.error !== "interrupted") onError(e.error);
    };
    if (paragraphBreaks && paragraphIndices) {
      this.setupParagraphTracking(utterance, paragraphBreaks, paragraphIndices, onParagraphChange);
    }
    this.preQueued = utterance;
    speechSynthesis.speak(utterance);
  }

  pause(): void {
    if (this.available && speechSynthesis.speaking) { speechSynthesis.pause(); this.paused = true; }
  }
  resume(): void { if (this.available && this.paused) { speechSynthesis.resume(); this.paused = false; } }
  stop(): void { if (this.available) speechSynthesis.cancel(); this.utterance = null; this.preQueued = null; this.paused = false; }
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
        this.pendingPlayResolve = resolve; // B3: start 成功后再赋值
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
  private seekId = 0; // B1: 防止 stop 后 seekToChunk 的 timeout 激活
  private currentChunkWasPreQueued = false; // U6: 预队列标志位
  private userPaused = false; // R13: 移动端 pause/resume 状态（cancel+re-speak 模式）

  constructor() { this.webSpeech = new WebSpeechTTSEngine(); }

  setEngine(engine: TTSEngine) { this.engine = engine; }

  setVoice(voiceId: string) {
    this.voiceId = voiceId;
    if (this.engine === "webspeech") {
      this.webSpeech.setVoice(voiceId);
      // B1: 播放中切音色，中断当前段并用新音色重新朗读
      if (this.webSpeech.isSpeaking() && this.currentChunkIndex < this.chunks.length) {
        this.generationId++; // R5: 无效化旧 onEnd 避免同步级联跳段
        this.currentChunkWasPreQueued = false; // U6: cancel 已清除队列，重置标志位
        this.webSpeech.stop();
        this.speakNextChunk();
      }
    } else if (this.zipvoice) this.zipvoice.setVoice(voiceId);
  }

  setSpeed(speed: number) {
    this.speed = Math.max(0.5, Math.min(3.0, speed));
    // WebSpeech 的 rate 在 utterance 创建时固化，需要重启才能生效
    this.restartIfPlaying();
  }
  setVolume(volume: number) { this.volume = Math.max(0, Math.min(1, volume)); }
  setPitch(pitch: number) {
    this.pitch = Math.max(0.5, Math.min(2.0, pitch));
    // WebSpeech 的 pitch 在 utterance 创建时固化，需要重启才能生效
    this.restartIfPlaying();
  }

  /** 语速/音调变化时，从当前段重新开始播放（新参数立即生效） */
  private restartIfPlaying(): void {
    if (this.engine === "webspeech" && this.webSpeech.isSpeaking() && this.currentChunkIndex < this.chunks.length) {
      this.generationId++;
      this.currentChunkWasPreQueued = false;
      this.webSpeech.stop();
      this.speakNextChunk();
    }
  }

  async speak(chunks: TTSChunk[], callbacks: TTSPlaybackCallbacks): Promise<void> {
    this.stop(); // 内部已调用 this.callbacks.onStop?.()
    this.chunks = chunks;
    this.currentChunkIndex = 0;
    this.callbacks = callbacks;
    this.stopped = false;
    this.currentChunkWasPreQueued = false;
    this.generationId++;

    if (chunks.length === 0) { callbacks.onError?.("没有可朗读的内容"); return; }

    // U8: 等待 Chrome 异步加载语音列表，确保第一段就用对音色
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
      // R13: 合并段（paragraphIndices.length > 1）拆成独立 utterance 精确追踪高亮
      if (this.currentChunkWasPreQueued) {
        this.currentChunkWasPreQueued = false;
        this.preQueueNextIfAvailable(genId);
      } else if (chunk.paragraphIndices.length > 1) {
        this.speakMergedChunk(chunk, genId);
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

  /** U6: 预队列下一个 chunk（不 cancel 当前正在播放的 utterance） */
  private preQueueNextIfAvailable(genId: number): void {
    const nextIdx = this.currentChunkIndex + 1;
    if (nextIdx >= this.chunks.length) return;
    const nextChunk = this.chunks[nextIdx];
    this.webSpeech.queue(
      nextChunk.text, this.speed, this.volume, this.pitch,
      () => {
        // onStart: 浏览器实际开始播放预队列段时触发，确保进度精确
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

  /** R13: 将合并段拆成独立 utterance 逐段朗读，精确追踪段落高亮 */
  private speakMergedChunk(chunk: TTSChunk, genId: number): void {
    const texts = this.extractParagraphTexts(chunk);
    // 第一段触发初始高亮
    this.callbacks.onChunkStart?.(this.currentChunkIndex, this.chunks.length, chunk.paragraphIndices[0]);
    this.webSpeech.speakMerged(
      texts, chunk.paragraphIndices, this.speed, this.volume, this.pitch,
      {
        onPlay: () => {
          if (this.stopped || this.generationId !== genId) return;
          this.callbacks.onPlay?.();
        },
        onParagraphStart: (paraIdx) => {
          if (this.stopped || this.generationId !== genId) return;
          this.callbacks.onChunkStart?.(this.currentChunkIndex, this.chunks.length, paraIdx);
        },
        onParagraphEnd: (paraIdx) => {
          if (this.stopped || this.generationId !== genId) return;
          this.callbacks.onChunkEnd?.(this.currentChunkIndex, this.chunks.length, paraIdx);
        },
        onAllEnd: () => {
          if (this.stopped || this.generationId !== genId) return;
          // 所有段落朗读完毕，预队列下一 chunk 并前进
          this.preQueueNextIfAvailable(genId);
          this.currentChunkIndex++;
          this.speakNextChunk();
        },
        onError: (err) => this.handleChunkError(err, genId),
      },
    );
  }

  /** R13: 从合并段文本中提取各段落的独立文本 */
  private extractParagraphTexts(chunk: TTSChunk): string[] {
    const texts: string[] = [];
    for (let i = 0; i < chunk.paragraphIndices.length; i++) {
      const start = chunk.paragraphBreaks[i];
      const end = i < chunk.paragraphBreaks.length - 1
        ? chunk.paragraphBreaks[i + 1]
        : chunk.text.length;
      let t = chunk.text.slice(start, end);
      // 移除合并时添加的句号分隔符前缀
      if (i > 0) t = t.replace(/^[。，,、]/, "").trim();
      texts.push(t || chunk.text.slice(start, end));
    }
    return texts;
  }

  private handleChunkEnded(genId: number): void {
    if (this.stopped || this.generationId !== genId) return;
    const chunk = this.chunks[this.currentChunkIndex];
    // 使用组内最后一段的索引，避免合并段结束时高亮闪回第一段
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
      // R13: 移动端 speechSynthesis.pause/resume 不可靠，改用 cancel+re-speak
      this.webSpeech.stop();
      this.currentChunkWasPreQueued = false;
    }
    this.userPaused = true;
    this.callbacks.onPause?.();
  }

  async resume(): Promise<void> {
    if (this.engine === "zipvoice" && this.zipvoice) await this.zipvoice.resume();
    else {
      // R13: 移动端 resume 不可靠，cancel 当前所有 utterance 后从当前 chunk 重新朗读
      this.webSpeech.stop(); // 确保 all utterances 被清除 + onerror("canceled") 被忽略
      this.currentChunkWasPreQueued = false;
      this.userPaused = false;
      this.speakNextChunk();
    }
    this.callbacks.onResume?.();
  }

  stop(): void {
    this.stopped = true;
    this.userPaused = false; // R13: 清除暂停状态
    this.generationId++; // R3F2: 无效化 auto-retry 的 setTimeout
    this.seekId++;       // B1: 无效化 seekToChunk timeout
    this.currentChunkWasPreQueued = false;
    if (this.zipvoice) this.zipvoice.stop();
    this.webSpeech.stop();
    this.callbacks.onStop?.();
  }

  /** U5: 获取当前播放段落索引（供错误重试使用） */
  getCurrentChunkIndex(): number { return this.currentChunkIndex; }
  /** H6: 获取当前 generation ID（防并发重试） */
  getCurrentGenerationId(): number { return this.generationId; }

  seekToChunk(index: number): void {
    if (index >= 0 && index < this.chunks.length) {
      this.generationId++;
      this.currentChunkWasPreQueued = false;
      this.userPaused = false; // R13: seek 时清除暂停状态（重新开始播放）
      this.stopped = true;
      if (this.zipvoice) this.zipvoice.stop();
      this.webSpeech.stop();
      this.currentChunkIndex = index;
      // B1: seekId 防止 stop() 后旧 timeout 激活
      const sid = ++this.seekId;
      setTimeout(() => {
        if (this.seekId !== sid) return; // stop() 后 seekId 已递增，放弃
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
    // R13: WebSpeech 的 cancel+re-speak 模式使用独立标记位
    return this.userPaused;
  }

  destroy(): void {
    this.stopped = true;
    this.generationId++;
    if (this.zipvoice) { this.zipvoice.destroy(); this.zipvoice = null; }
    this.webSpeech.destroy();
  }
}
