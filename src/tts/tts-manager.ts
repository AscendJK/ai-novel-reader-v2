/**
 * TTS 管理器
 * 统一的 TTS 引擎抽象层，支持 ZipVoice 和 Web Speech API
 * 支持流式播放（边生成边播放 + 预生成下一章）
 */

import { loadModel, isModelLoaded, generateAudio, resetWorker } from "./zipvoice-engine";

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
  private fallbackCheckTimer: ReturnType<typeof setTimeout> | null = null;

  // 段落追踪状态
  private boundaryEventCount = 0;
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
        // 可选链：部分移动 WebView 的 speechSynthesis 非标准 EventTarget
        speechSynthesis.removeEventListener?.("voiceschanged", handler);
        clearInterval(poll);
        resolve();
      };
      speechSynthesis.addEventListener?.("voiceschanged", handler);
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
    if (this.fallbackCheckTimer) { clearTimeout(this.fallbackCheckTimer); this.fallbackCheckTimer = null; }
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
    this.boundaryDetectionDone = false;
    this.chunkStartTime = performance.now();

    utterance.onboundary = (e: SpeechSynthesisEvent) => {
      if (e.charIndex === undefined) return;
      this.boundaryEventCount++;

      // 首次收到 onboundary：校准语速
      if (!this.boundaryDetectionDone) {
        this.boundaryDetectionDone = true;
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
    // 保存 timer 引用并在播放结束/停止时清理，防止 interval 泄漏
    if (this.fallbackCheckTimer) clearTimeout(this.fallbackCheckTimer);
    this.fallbackCheckTimer = setTimeout(() => {
      this.fallbackCheckTimer = null;
      // 仅在当前 utterance 仍在播放时启动降级（stop/新 speak 后跳过）
      if (!this.boundaryDetectionDone && this.utterance === utterance) {
        this.boundaryDetectionDone = true;
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
    // Chrome/Edge: cancel() 后立即 speak() 会被忽略（异步取消竞态）。
    // 延迟到下一宏任务再 speak，避免“停止后立即播放无反应”。
    const u = this.utterance;
    setTimeout(() => {
      if (this.utterance === u) speechSynthesis.speak(u);
    }, 60);
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
    // 与 speak() 一致：延迟 speak 避免 cancel 竞态
    this.utterance = utterance;
    setTimeout(() => {
      if (this.utterance === utterance) speechSynthesis.speak(utterance);
    }, 60);
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
 * 离线 TTS 引擎（Kokoro，通过 Web Audio API 播放）
 */
class ZipVoiceTTSEngine {
  private audioContext: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private paused = false;
  private stopped = false;
  private pausedAt = 0;
  private startedAt = 0;
  private currentBuffer: AudioBuffer | null = null;
  private voice = "45";
  private pendingPlayResolve: (() => void) | null = null;

  setVoice(voiceId: string) { this.voice = voiceId; }

  private getAudioContext(): AudioContext {
    if (!this.audioContext) this.audioContext = new AudioContext();
    return this.audioContext;
  }

  async ensureResumed(): Promise<void> {
    const ctx = this.getAudioContext();
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch { /* 自动播放策略拒绝：继续尝试播放 */ }
    }
  }

  private playOneBuffer(buffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      const ctx = this.getAudioContext();
      const startPlayback = () => {
        // 自动播放策略：resume 被拒时 context 仍是 suspended，
        // source.start() 静默失败（不发声也不触发 onended）→ promise 永不 resolve → 朗读链卡死。
        // 此时放弃该 chunk 并 resolve，避免整章无声卡死。
        if (ctx.state === "suspended") {
          console.warn("[TTS] AudioContext 无法恢复（自动播放策略），跳过该 chunk");
          resolve();
          return;
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        // 播放固定 1.0 倍速：倍速已并入生成 speed（模型级变速保音高），
        // AudioBufferSourceNode.playbackRate 是重采样会变调（花栗鼠音）
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
        try { source.start(); } catch { resolve(); } // context 已关闭等异常时不要卡死
        this.pendingPlayResolve = resolve;
      };
      if (ctx.state === "suspended") {
        ctx.resume().then(() => {
          if (ctx.state === "running") startPlayback();
          else { console.warn("[TTS] AudioContext.resume 后仍非 running，跳过该 chunk"); resolve(); }
        }).catch(() => {
          console.warn("[TTS] AudioContext.resume 被拒绝，跳过该 chunk");
          resolve();
        });
      } else startPlayback();
    });
  }

  async speak(text: string, speed: number, callbacks: TTSPlaybackCallbacks, isCancelled?: () => boolean): Promise<void> {
    this.stop();
    this.stopped = false;
    const ctx = this.getAudioContext();
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch { /* 自动播放策略拒绝，继续尝试 */ }
    }
    // 移到块外重新检查：避免 TS 对块内 ctx.state 的窄化（resume 可能成功也可能被拒）
    if (ctx.state !== "running") {
      // 无法出声：直接报错而非静默跳过所有 chunk（避免朗读瞬间“播完”触发自动翻章）
      callbacks.onError?.("浏览器阻止了自动播放，请点击页面任意位置后重试");
      return;
    }
    let firstChunk = true;
    try {
      await generateAudio(text, { voice: this.voice, speed }, async (audioData) => {
        // 双重防护：引擎内部 stopped（主动停止）+ 会话失效（停止后重开的旧结果串扰）
        if (this.stopped || isCancelled?.()) return;
        const buffer = ctx.createBuffer(1, audioData.length, 24000);
        buffer.copyToChannel(new Float32Array(audioData), 0);
        if (firstChunk) { firstChunk = false; callbacks.onPlay?.(); }
        await this.playOneBuffer(buffer);
      });
      if (!this.stopped) callbacks.onEnd?.();
    } catch (err) {
      if (this.stopped) return; // 主动停止（resetWorker reject）导致的取消，静默丢弃
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
        if (ctx.state === "suspended") {
          try { await ctx.resume(); } catch { /* 忽略，继续尝试播放 */ }
        }
        const source = ctx.createBufferSource();
        source.buffer = this.currentBuffer;
        // 同 playOneBuffer：播放固定 1.0 倍速，倍速由生成 speed 控制（保音高）
        source.connect(ctx.destination);
        const resolve = this.pendingPlayResolve;
        source.onended = () => { this.currentSource = null; if (!this.paused) { this.currentBuffer = null; this.pendingPlayResolve = null; resolve?.(); } };
        this.currentSource = source;
        this.startedAt = ctx.currentTime - this.pausedAt;
        this.paused = false;
        try { source.start(0, this.pausedAt); } catch { resolve?.(); }
      } catch { /* context closed, buffer detached */ }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.currentSource) { try { this.currentSource.stop(); } catch { /* 已停止的 source 忽略 */ } this.currentSource = null; }
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
  private playbackRate = 1.0; // 播放倍速（独立于生成语速 speed）
  private volume = 1.0;
  private pitch = 1.0;
  private voiceId = "45";
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
    } else if (this.engine === "zipvoice" && this.zipvoice?.isSpeaking()) {
      // ZipVoice：语速是生成参数，需用新语速重新生成当前 chunk（保音高）
      this.restartZipVoiceFromCurrentChunk();
    }
  }

  /**
   * 播放倍速（正文朗读栏）。
   * - ZipVoice：倍速并入生成 speed（模型级变速保音高），需重新生成当前 chunk；
   *   不再用 AudioBufferSourceNode.playbackRate（重采样会变调）
   * - WebSpeech：最终 rate = 生成语速 × 倍速，需重新 speak
   */
  setPlaybackRate(playbackRate: number) {
    this.playbackRate = Math.max(0.5, Math.min(3.0, playbackRate));
    if (this.engine === "zipvoice" && this.zipvoice?.isSpeaking()) {
      this.restartZipVoiceFromCurrentChunk();
    } else if (this.engine === "webspeech" && this.webSpeech.isSpeaking()) {
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

  /**
   * ZipVoice 语速/倍速变更后的恢复：从当前 chunk 用新参数重新生成。
   * ZipVoice 一次生成整个 chunk 音频（无 chunk 内段落定位），
   * 因此从当前 chunk 开头重读，与 seekToChunk 行为一致。
   */
  private restartZipVoiceFromCurrentChunk(): void {
    if (this.engine !== "zipvoice" || !this.zipvoice) return;
    const chunkIdx = this.currentChunkIndex;
    if (chunkIdx >= 0 && chunkIdx < this.chunks.length) {
      this.seekToChunk(chunkIdx);
    }
  }

  async speak(chunks: TTSChunk[], callbacks: TTSPlaybackCallbacks): Promise<void> {
    // 先更新 callbacks：内部重置时不再触发旧 onStop（否则会把刚设置的
    // generating/playing 状态重置掉，导致停止后无法重新打开/自动翻章失败）
    this.callbacks = callbacks;
    this.stopped = true;
    this.userPaused = false;
    this.generationId++;
    this.seekId++;
    this.currentParagraphIndex = 0;
    if (this.zipvoice) this.zipvoice.stop();
    this.webSpeech.stop();

    this.chunks = chunks;
    this.currentChunkIndex = 0;
    this.currentParagraphIndex = 0;
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
    if (this.currentChunkIndex >= this.chunks.length) { this.callbacks.onEnd?.(); return; }

    const chunk = this.chunks[this.currentChunkIndex];
    const genId = this.generationId;

    if (this.engine === "zipvoice" && this.zipvoice) {
      this.callbacks.onChunkStart?.(this.currentChunkIndex, this.chunks.length, chunk.paragraphIndex);
      await new Promise(r => setTimeout(r, 0));
      // 有效语速 = 设置页生成语速 × 朗读栏播放倍速（clamp 到 sherpa-onnx 官方 0.4-3.5）
      const effectiveSpeed = Math.max(0.4, Math.min(3.5, this.speed * this.playbackRate));
      const chunkT0 = performance.now();
      console.log(`[TTS] ▶ 生成 chunk ${this.currentChunkIndex + 1}/${this.chunks.length}: ${chunk.text.length} 字, speed=${effectiveSpeed.toFixed(2)}`);
      await this.zipvoice.speak(chunk.text, effectiveSpeed, {
        onPlay: () => {
          if (this.stopped || this.generationId !== genId) return;
          this.callbacks.onPlay?.();
        },
        onEnd: () => {
          if (this.stopped || this.generationId !== genId) return;
          // ZipVoice 每个 chunk 是一整段音频，无组内逐段追踪；
          // 结束时传组内最后一段的原始索引，与 WebSpeech 路径（handleChunkEnded）对齐
          const lastIdx = chunk.paragraphIndices?.length
            ? chunk.paragraphIndices[chunk.paragraphIndices.length - 1]
            : chunk.paragraphIndex;
          console.log(`[TTS] ✓ chunk ${this.currentChunkIndex + 1}/${this.chunks.length} 播放结束（生成+播放共 ${((performance.now() - chunkT0) / 1000).toFixed(1)}s）`);
          this.callbacks.onChunkEnd?.(this.currentChunkIndex, this.chunks.length, lastIdx);
          this.currentChunkIndex++;
          this.speakNextChunk();
        },
        onError: (err) => {
          if (this.stopped || this.generationId !== genId) return;
          this.callbacks.onError?.(err);
        },
      }, () => this.stopped || this.generationId !== genId);
    } else {
      // 顺序播放：chunk 完成后立即播放下一个（不使用预队列）
      // 最终语速 = 设置页生成语速 × 正文朗读栏播放倍速
      const effectiveSpeed = this.speed * this.playbackRate;
      this.callbacks.onChunkStart?.(this.currentChunkIndex, this.chunks.length, chunk.paragraphIndex);
      this.webSpeech.speak(chunk.text, effectiveSpeed, this.volume, this.pitch, {
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
    // 立即中断 worker 推理：wasm 同步推理无法取消单次任务，
    // 只能 terminate worker 让 CPU 立刻释放；结果也不会再回来（pending 已 reject）
    resetWorker();
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
    // 组件卸载：中断 worker 推理，避免页面切走后 CPU 仍在跑
    resetWorker();
    this.callbacks.onStop?.();
  }
}
