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
  private pausedAt = 0;
  private startedAt = 0;
  private currentBuffer: AudioBuffer | null = null;
  private currentCallbacks: TTSPlaybackCallbacks = {};
  private voice = "zf_001";

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
   * 生成音频（不播放）
   */
  async generate(text: string, speed: number): Promise<AudioBuffer | null> {
    try {
      const audioResult = await generateAudio(text, {
        voice: this.voice,
        speed,
      });

      const ctx = this.getAudioContext();
      const buffer = ctx.createBuffer(1, audioResult.audio.length, audioResult.sampleRate);
      buffer.copyToChannel(new Float32Array(audioResult.audio), 0);
      return buffer;
    } catch (err) {
      console.error("[Kokoro] Generate failed:", err);
      return null;
    }
  }

  /**
   * 播放已生成的 AudioBuffer
   */
  async playBuffer(buffer: AudioBuffer, callbacks: TTSPlaybackCallbacks): Promise<void> {
    const ctx = this.getAudioContext();
    // 确保 AudioContext 处于运行状态（浏览器要求用户手势后才能播放音频）
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    this.currentCallbacks = callbacks;
    source.onended = () => {
      this.currentSource = null;
      // 如果是 pause() 触发的 onended，保留 currentBuffer 供 resume() 使用
      if (!this.paused) {
        this.currentBuffer = null;
        callbacks.onEnd?.();
      }
    };

    this.currentBuffer = buffer;
    this.currentSource = source;
    this.startedAt = ctx.currentTime;
    this.pausedAt = 0;
    this.paused = false;

    source.start();
    callbacks.onPlay?.();
  }

  /**
   * 生成并播放
   */
  async speak(text: string, speed: number, callbacks: TTSPlaybackCallbacks): Promise<void> {
    this.stop();

    const buffer = await this.generate(text, speed);
    if (buffer) {
      this.playBuffer(buffer, callbacks);
    } else {
      callbacks.onError?.("音频生成失败");
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

      const callbacks = this.currentCallbacks;
      source.onended = () => {
        this.currentSource = null;
        if (!this.paused) {
          this.currentBuffer = null;
          callbacks.onEnd?.();
        }
      };

      this.currentSource = source;
      this.startedAt = ctx.currentTime - this.pausedAt;
      this.paused = false;

      source.start(0, this.pausedAt);
    }
  }

  stop(): void {
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch { /* already stopped */ }
      this.currentSource = null;
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

  // 预生成缓冲（流式播放核心）
  private preloadedBuffer: AudioBuffer | null = null;
  private preloadedIndex = -1;
  private isPreloading = false;
  // 代数计数器：每次 seek/stop 递增，用于使旧的预生成回调失效
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
    this.preloadedBuffer = null;
    this.preloadedIndex = -1;
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
    this.preloadedBuffer = null;
    this.preloadedIndex = -1;
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
    this.preloadedBuffer = null;
    this.preloadedIndex = -1;
    this.generationId++;

    if (chunks.length === 0) {
      callbacks.onError?.("没有可朗读的内容");
      return;
    }

    // 确保 Kokoro 引擎已初始化
    if (this.engine === "kokoro") {
      try {
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
        if (!this.kokoro) {
          this.kokoro = new KokoroTTSEngine();
        }
        this.kokoro.setVoice(this.voiceId);
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
      // 检查是否有预生成的音频
      let buffer: AudioBuffer | null = null;

      if (this.preloadedBuffer && this.preloadedIndex === this.currentChunkIndex) {
        // 命中预生成缓冲
        buffer = this.preloadedBuffer;
        this.preloadedBuffer = null;
        this.preloadedIndex = -1;
      } else {
        // 未命中，生成当前段落
        buffer = await this.kokoro.generate(chunk.text, this.speed);
      }

      if (this.stopped || this.generationId !== genId) return;

      if (buffer) {
        // 开始播放
        await this.kokoro.playBuffer(buffer, {
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

        // 预生成下一个段落（不阻塞当前播放）
        this.preloadNextChunk();
      } else {
        this.callbacks.onError?.("音频生成失败");
      }
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
   * 预生成下一个段落（后台执行，不阻塞播放）
   */
  private preloadNextChunk(): void {
    if (this.isPreloading) return;
    if (!this.kokoro) return;

    const nextIndex = this.currentChunkIndex + 1;
    if (nextIndex >= this.chunks.length) return;

    this.isPreloading = true;
    const nextChunk = this.chunks[nextIndex];
    const genId = this.generationId; // 捕获当前代数
    const capturedSpeed = this.speed; // 捕获当前语速
    const capturedVoice = this.voiceId; // 捕获当前语音

    this.kokoro.generate(nextChunk.text, this.speed).then((buffer) => {
      // 代数不匹配、语速或语音已变则丢弃
      if (this.generationId !== genId || this.speed !== capturedSpeed || this.voiceId !== capturedVoice) {
        this.isPreloading = false;
        return;
      }
      if (!this.stopped && buffer) {
        this.preloadedBuffer = buffer;
        this.preloadedIndex = nextIndex;
      }
      this.isPreloading = false;
    }).catch(() => {
      this.isPreloading = false;
    });
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
    this.preloadedBuffer = null;
    this.preloadedIndex = -1;
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
      this.generationId++; // 使所有旧的预生成回调失效
      this.preloadedBuffer = null;
      this.preloadedIndex = -1;
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
    this.preloadedBuffer = null;
    this.preloadedIndex = -1;
    if (this.kokoro) {
      this.kokoro.destroy();
      this.kokoro = null;
    }
    this.webSpeech.destroy();
  }
}
