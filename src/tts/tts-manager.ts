/**
 * TTS 管理器
 * 统一的 TTS 引擎抽象层，支持 Kokoro 和 Web Speech API
 * 支持流式播放（边生成边播放 + 预生成下一章）
 */

import { loadKokoroModel, isKokoroLoaded, generateAudio } from "./kokoro-engine";

export type TTSEngine = "kokoro" | "webspeech";

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
  /** 引擎降级回调（如 Kokoro 加载失败降级到 Web Speech API） */
  onFallback?: (from: TTSEngine, to: TTSEngine) => void;
  /** 模型加载进度回调 */
  onModelProgress?: (progress: number) => void;
  /** 模型加载完成回调 */
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

  speak(text: string, speed: number, callbacks: TTSPlaybackCallbacks): void {
    this.stop();

    this.utterance = new SpeechSynthesisUtterance(text);
    this.utterance.rate = speed;
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
    if (speechSynthesis.speaking) {
      speechSynthesis.pause();
      this.paused = true;
    }
  }

  resume(): void {
    if (this.paused) {
      speechSynthesis.resume();
      this.paused = false;
    }
  }

  stop(): void {
    speechSynthesis.cancel();
    this.utterance = null;
    this.paused = false;
  }

  isSpeaking(): boolean {
    return speechSynthesis.speaking;
  }

  isPaused(): boolean {
    return this.paused;
  }

  destroy(): void {
    this.stop();
  }
}

/**
 * Kokoro TTS 引擎（通过 Web Audio API 播放）
 */
class KokoroTTSEngine {
  private audioContext: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private paused = false;
  private stopped = false;
  private pausedAt = 0;
  private startedAt = 0;
  private currentBuffer: AudioBuffer | null = null;
  private voice = "zf_001";
  // playOneBuffer 的 resolve 引用，供 resume() 调用
  private pendingPlayResolve: (() => void) | null = null;

  setVoice(voiceId: string) {
    this.voice = voiceId;
  }

  private getAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  /**
   * 确保 AudioContext 已创建并处于运行状态
   * 必须在用户手势上下文中调用（点击事件处理函数内）
   */
  async ensureResumed(): Promise<void> {
    const ctx = this.getAudioContext();
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
  }

  /**
   * 播放单个 AudioBuffer
   * 暂停时不 resolve，等 resume() 播完后再 resolve
   */
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
          if (!this.paused) {
            this.currentBuffer = null;
            this.pendingPlayResolve = null;
            resolve();
          }
          // 暂停时不要 resolve，等 resume() 的 onended 来 resolve
        };

        source.start();
      };

      if (ctx.state === "suspended") {
        ctx.resume().then(startPlayback);
      } else {
        startPlayback();
      }
    });
  }

  /**
   * 流式生成并播放：逐段推理，每段完成即播放
   */
  async speak(text: string, speed: number, callbacks: TTSPlaybackCallbacks): Promise<void> {
    this.stop();
    this.stopped = false;

    const ctx = this.getAudioContext();
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    let firstChunk = true;

    try {
      await generateAudio(text, { voice: this.voice, speed }, async (audioData) => {
        if (this.stopped) return;

        const buffer = ctx.createBuffer(1, audioData.length, 24000);
        buffer.copyToChannel(new Float32Array(audioData), 0);

        if (firstChunk) {
          firstChunk = false;
          callbacks.onPlay?.();
        }

        // 播放当前段，等待播完
        await this.playOneBuffer(buffer);
      });

      // 所有段播放完毕
      if (!this.stopped) {
        callbacks.onEnd?.();
      }
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
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      const source = ctx.createBufferSource();
      source.buffer = this.currentBuffer;
      source.connect(ctx.destination);

      const resolve = this.pendingPlayResolve;
      source.onended = () => {
        this.currentSource = null;
        this.currentBuffer = null;
        this.pendingPlayResolve = null;
        resolve?.(); // 通知 playOneBuffer 播放完毕
      };

      this.currentSource = source;
      this.startedAt = ctx.currentTime - this.pausedAt;
      this.paused = false;

      source.start(0, this.pausedAt);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch { /* already stopped */ }
      this.currentSource = null;
    }
    // 暂停后 stop：onended 不会触发，需要手动 resolve
    if (this.pendingPlayResolve) {
      this.pendingPlayResolve();
      this.pendingPlayResolve = null;
    }
    this.currentBuffer = null;
    this.paused = false;
    this.pausedAt = 0;
  }

  isSpeaking(): boolean {
    return this.currentSource !== null && !this.paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  destroy(): void {
    this.stop();
    if (this.audioContext) {
      this.audioContext.close().catch(() => { /* ignore */ });
      this.audioContext = null;
    }
  }
}

/**
 * TTS 管理器（支持流式播放）
 */
export class TTSManager {
  private engine: TTSEngine = "webspeech";
  private webSpeech: WebSpeechTTSEngine;
  private kokoro: KokoroTTSEngine | null = null;
  private chunks: TTSChunk[] = [];
  private currentChunkIndex = 0;
  private callbacks: TTSPlaybackCallbacks = {};
  private speed = 1.0;
  private voiceId = "zf_001";
  private stopped = false;

  // 代数计数器：每次 seek/stop 递增，用于使旧的回调失效
  private generationId = 0;

  constructor() {
    this.webSpeech = new WebSpeechTTSEngine();
  }

  /**
   * 设置 TTS 引擎
   */
  setEngine(engine: TTSEngine) {
    this.engine = engine;
  }

  /**
   * 设置语音（清除预生成缓冲，新语音在下一段生成时生效）
   */
  setVoice(voiceId: string) {
    this.voiceId = voiceId;
    if (this.engine === "webspeech") {
      this.webSpeech.setVoice(voiceId);
    } else if (this.kokoro) {
      this.kokoro.setVoice(voiceId);
    }
  }

  /**
   * 设置语速（清除预生成缓冲，新语速在下一段生成时生效）
   * 注意：不递增 generationId，避免中断当前播放链路
   */
  setSpeed(speed: number) {
    this.speed = Math.max(0.5, Math.min(3.0, speed));
  }

  /**
   * 开始朗读一组文本段落
   */
  async speak(chunks: TTSChunk[], callbacks: TTSPlaybackCallbacks): Promise<void> {
    // 先清除旧回调，再停止（防止 stop() 触发旧 onStop/onEnd）
    this.callbacks = {};
    this.stop();
    this.chunks = chunks;
    this.currentChunkIndex = 0;
    this.callbacks = callbacks;
    this.stopped = false;
    this.generationId++;

    if (chunks.length === 0) {
      callbacks.onError?.("没有可朗读的内容");
      return;
    }

    // 确保 Kokoro 引擎已初始化
    if (this.engine === "kokoro") {
      try {
        // 先创建引擎并恢复 AudioContext（必须在 await 之前，保持用户手势上下文）
        if (!this.kokoro) {
          this.kokoro = new KokoroTTSEngine();
        }
        this.kokoro.setVoice(this.voiceId);
        await this.kokoro.ensureResumed();

        if (!isKokoroLoaded()) {
          const genBeforeLoad = this.generationId;
          callbacks.onModelProgress?.(0);
          await loadKokoroModel({
            onProgress: (p) => callbacks.onModelProgress?.(p),
          });
          // 模型加载期间如果再次调用了 speak()，本次应作废
          if (this.generationId !== genBeforeLoad) return;
          callbacks.onModelLoaded?.();
        }
      } catch (err) {
        // Kokoro 加载失败，降级到 Web Speech API
        console.warn("[TTS] Kokoro 加载失败，降级到 Web Speech API:", err);
        this.engine = "webspeech";
        callbacks.onFallback?.("kokoro", "webspeech");
      }
    }

    await this.speakNextChunk();
  }

  /**
   * 播放下一个段落（流式：检查预生成缓冲 → 播放 → 预生成下一个）
   */
  private async speakNextChunk(): Promise<void> {
    if (this.stopped) return;
    if (this.currentChunkIndex >= this.chunks.length) {
      this.callbacks.onEnd?.();
      return;
    }

    const chunk = this.chunks[this.currentChunkIndex];
    const genId = this.generationId; // 捕获当前代数，用于检测 stale 回调
    this.callbacks.onChunkStart?.(this.currentChunkIndex, this.chunks.length);

    if (this.engine === "kokoro" && this.kokoro) {
      // 让出主线程，使 UI 能更新（进度条、段落计数）
      await new Promise(r => setTimeout(r, 0));

      // 流式播放：kokoro.speak 内部逐段推理并播放
      await this.kokoro.speak(chunk.text, this.speed, {
        onPlay: () => this.callbacks.onPlay?.(),
        onEnd: () => {
          // 代数不匹配说明 seekToChunk/stop/speak 已中断此链路
          if (this.stopped || this.generationId !== genId) return;
          this.callbacks.onChunkEnd?.(this.currentChunkIndex, this.chunks.length);
          this.currentChunkIndex++;
          this.speakNextChunk();
        },
        onError: (err) => this.callbacks.onError?.(err),
      });
    } else {
      // Web Speech API（无预生成，直接播放）
      this.webSpeech.speak(chunk.text, this.speed, {
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

  /**
   * 暂停
   */
  pause(): void {
    if (this.engine === "kokoro" && this.kokoro) {
      this.kokoro.pause();
    } else {
      this.webSpeech.pause();
    }
    this.callbacks.onPause?.();
  }

  /**
   * 恢复
   */
  async resume(): Promise<void> {
    if (this.engine === "kokoro" && this.kokoro) {
      await this.kokoro.resume();
    } else {
      this.webSpeech.resume();
    }
    this.callbacks.onResume?.();
  }

  /**
   * 停止
   */
  stop(): void {
    this.stopped = true;
    if (this.kokoro) this.kokoro.stop();
    this.webSpeech.stop();
    this.callbacks.onStop?.();
  }

  /**
   * 跳到指定段落
   */
  seekToChunk(index: number): void {
    if (index >= 0 && index < this.chunks.length) {
      this.stopped = true; // 阻止旧 onEnd 回调
      this.generationId++; // 使所有旧的回调失效
      if (this.kokoro) this.kokoro.stop();
      this.webSpeech.stop();
      this.currentChunkIndex = index;
      this.stopped = false; // 重新启用
      this.speakNextChunk();
    }
  }

  /**
   * 是否正在播放
   */
  isPlaying(): boolean {
    if (this.engine === "kokoro" && this.kokoro) {
      return this.kokoro.isSpeaking();
    }
    return this.webSpeech.isSpeaking() && !this.webSpeech.isPaused();
  }

  /**
   * 是否暂停
   */
  isPaused(): boolean {
    if (this.engine === "kokoro" && this.kokoro) {
      return this.kokoro.isPaused();
    }
    return this.webSpeech.isPaused();
  }

  /**
   * 销毁
   */
  destroy(): void {
    this.stopped = true;
    this.generationId++;
    if (this.kokoro) {
      this.kokoro.destroy();
      this.kokoro = null;
    }
    this.webSpeech.destroy();
  }
}
