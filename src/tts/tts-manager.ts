/**
 * TTS 管理器
 * 统一的 TTS 引擎抽象层，支持 ZipVoice 和 Web Speech API
 * 支持流式播放（边生成边播放 + 预生成下一章）
 */

import { loadModel, generateAudio, resetWorker } from "./zipvoice-engine";
import { synthesizeServer, cancelServerInference, ServerInferenceTimeoutError } from "./server-engine";

export type TTSEngine = "server" | "zipvoice" | "webspeech";

// 当前活跃的 TTSManager 实例（供设置页试听等场景停止正在进行的朗读）
let activeManager: TTSManager | null = null;
export function getActiveTTSManager(): TTSManager | null { return activeManager; }

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
  /**
   * 朗读出错。info.retryable=false 表示这是"重试只会更糟"的失败
   * （服务端队列超时），UI 不应自动重试。
   */
  onError?: (error: string, info?: { retryable?: boolean }) => void;
  onFallback?: (from: TTSEngine, to: TTSEngine) => void;
  onModelProgress?: (progress: number) => void;
  onModelLoaded?: () => void;
  onVoicesLoaded?: (voices: SpeechSynthesisVoice[]) => void;
  /** 预生成阶段进度（Kokoro 引擎开播前缓冲；total=0 表示未启用） */
  onPrepareProgress?: (ready: number, total: number) => void;
  /** 播放中缓冲水位变化（已缓存待播段数） */
  onBufferChange?: (buffered: number) => void;
  /** 播放中现场生成（缓冲未命中）状态变化：true=正在生成下一段音频 */
  onGenerating?: (generating: boolean) => void;
}

/**
 * 读取 AudioContext 是否可出声。显式标注 boolean（而非让 TS 推断类型谓词），
 * 这样 await 之后复查 state 不会被调用方先前的 `ctx.state` 窄化缓存挡掉——
 * resume() 完成时浏览器确实会改写该 readonly 属性。
 */
function isCtxRunning(ctx: AudioContext): boolean {
  return ctx.state === "running";
}

/**
 * 二分查找：字符位置 → paragraphBreaks 中的段落下标（两引擎共用）
 */
export function findParagraphByCharIndex(charIdx: number, breaks: number[]): number {
  let lo = 0, hi = breaks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (breaks[mid] <= charIdx) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 线性进度 → 段落原始索引（ZipVoice 用：音频匀速播放，
 * 播放进度 × 总字符数 → 字符位置 → 段落映射）。
 * progress 需在 [0,1] 内；totalChars ≤ 0 时按 1 处理避免除零。
 */
export function mapProgressToParagraph(
  progress: number,
  totalChars: number,
  breaks: number[],
  indices: number[],
): number | null {
  if (breaks.length === 0 || indices.length === 0) return null;
  const p = Math.max(0, Math.min(1, progress));
  const charPos = Math.floor(p * Math.max(1, totalChars));
  const idx = findParagraphByCharIndex(charPos, breaks);
  return idx >= 0 && idx < indices.length ? indices[idx] : null;
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
  private lastBoundaryPara: number | null = null; // 上次上报的段落（仅变化时上报）

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
    // Android Chromium 部分版本 getVoices() 恒空（不提供列表，但 speak() 正常）。
    // 此时等待 10s 超时毫无意义——直接返回当前列表，朗读用系统默认语音。
    const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
    if (/Android/i.test(ua)) return speechSynthesis.getVoices();
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

  /** 从已用时间估算当前字符位置，再映射到段落（降级方案） */
  private estimateParagraphFromTime(
    elapsedMs: number, text: string, speed: number,
    breaks: number[], indices: number[],
  ): number {
    const charsPerSec = this.calibratedCharsPerSec * Math.max(0.5, Math.min(3, speed));
    const charPos = Math.min(Math.floor((elapsedMs / 1000) * charsPerSec), text.length - 1);
    return indices[findParagraphByCharIndex(charPos, breaks)];
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
    this.lastBoundaryPara = null; // 重置：新 chunk 首次 boundary 必须上报

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

      // 字符位置 → 段落映射（二分查找）；仅段落变化时上报
      //（同一段落内多个 boundary 事件不重复触发 store 更新）
      const paraIdx = findParagraphByCharIndex(e.charIndex, breaks);
      if (paraIdx >= 0 && paraIdx < indices.length) {
        const target = indices[paraIdx];
        if (target !== this.lastBoundaryPara) {
          this.lastBoundaryPara = target;
          onParagraphChange(target);
        }
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

  stop(): void {
    this.clearParaTimer();
    // 清理降级检测定时器（stop 后不再需要，避免悬空 1.5s）
    if (this.fallbackCheckTimer) {
      clearTimeout(this.fallbackCheckTimer);
      this.fallbackCheckTimer = null;
    }
    // cancel() 前先摘掉当前 utterance 的回调：Firefox/部分 WebView 对 cancel
    // 会补发 onend，若留着就会被当成"自然播完"→ 暂停后继续朗读下一段。
    // 另外 Chrome 的 cancel 是异步的，旧 utterance 的回调可能在新 utterance
    // 开播后才到达，摘除回调同时挡住这条跨代次污染路径。
    if (this.utterance) {
      this.utterance.onstart = null;
      this.utterance.onend = null;
      this.utterance.onerror = null;
      this.utterance.onboundary = null;
    }
    if (this.available) speechSynthesis.cancel();
    this.utterance = null;
  }
  isSpeaking(): boolean { return this.available ? speechSynthesis.speaking : false; }
  destroy(): void { this.stop(); }
}

/**
 * 离线 TTS 引擎基类（Kokoro，通过 Web Audio API 播放）
 * 播放逻辑（chunk 播放、段落追踪、暂停/恢复/停止）与音频来源解耦：
 * - ZipVoiceTTSEngine：浏览器 wasm 推理（离线）
 * - ServerTTSEngine：服务器 Python 推理（快，RTF≈0.6）
 */
class ZipVoiceTTSEngine {
  protected audioContext: AudioContext | null = null;
  protected currentSource: AudioBufferSourceNode | null = null;
  protected paused = false;
  // 用户在"生成间隙"（上一段播完、下一段生成中，currentSource 为 null）按下的
  // 暂停意图：此时 pause() 无源可停，靠本标志在下一段开播前挂起。
  // 不这样做的话生成完成后音频照常自动出声，暂停操作被无声吞掉。
  protected pauseRequested = false;
  protected stopped = false;
  protected pausedAt = 0;
  protected startedAt = 0;
  protected currentBuffer: AudioBuffer | null = null;
  protected voice = "45";
  protected pendingPlayResolve: (() => void) | null = null;
  // resume() 在飞行中（等待 ctx.resume）：并发调用合并到这一轮，避免各建一个 source 混播
  private resumeInFlight: Promise<boolean> | null = null;
  // 段落追踪状态（基于音频播放时间的线性估算）
  private paraTimer: ReturnType<typeof setInterval> | null = null;
  private trackText = "";
  private trackBreaks: number[] | null = null;
  private trackIndices: number[] | null = null;
  private trackOnParagraphChange: ((paraIdx: number) => void) | null = null;

  /**
   * 生成音频（由子类实现）：返回 PCM Float32 样本
   * @param _text 已清洗的文本
   * @param _voice 音色 id
   * @param _speed 语速
   */
  protected async generate(_text: string, _voice: string, _speed: number, _priority?: boolean): Promise<{ samples: Float32Array; sampleRate: number }> {
    void _text; void _voice; void _speed; void _priority;
    throw new Error("generate() 未实现");
  }

  setVoice(voiceId: string) { this.voice = voiceId; }

  private getAudioContext(): AudioContext {
    if (!this.audioContext) this.audioContext = new AudioContext();
    return this.audioContext;
  }

  /**
   * 尝试恢复 AudioContext，返回"是否真的可以出声"。
   * 三条退出路径都必须落到 state 复查上：
   * - resume() reject（自动播放策略拒绝）
   * - resume() resolve 但 state 仍是 suspended（iOS Safari 的常见行为）
   * - resume() 既不 resolve 也不 reject（iOS 音频中断后挂死）→ 超时兜底
   * 调用方若不看返回值直接 source.start()，在 suspended 下是静默失败：
   * 不出声也不触发 onended，等待 onended 的播放链会永久挂起。
   */
  private async tryResumeContext(ctx: AudioContext, timeoutMs = 3000): Promise<boolean> {
    if (isCtxRunning(ctx)) return true;
    if (ctx.state === "closed") return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      ctx.resume().catch(() => { /* 由下方 state 复查兜底 */ }),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    return isCtxRunning(ctx);
  }

  async ensureResumed(): Promise<void> {
    await this.tryResumeContext(this.getAudioContext());
  }

  /**
   * 在用户手势窗口内同步创建 AudioContext 并发起 resume（不等待结果）。
   * 首次朗读时模型加载需数秒，若等 speak 内才创建 AudioContext，
   * 手势激活窗口已过期 → Chrome 自动播放策略置为 suspended → 播放无声。
   * 调用方需在用户点击事件（如“朗读”按钮）的同步阶段调用本方法。
   */
  prewarm(): void {
    const ctx = this.getAudioContext();
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => { /* 后续 speak 内还会再尝试 */ });
    }
  }

  /**
   * 启动 chunk 内逐段高亮：字符速率校准 + 时间推进映射。
   * 初始用「总字符数 / 音频时长」的平均速率，每次跨过段落边界时用
   * 「实际到达的字符位置 / 已播时长」平滑校准（吸收标点停顿、数字英文
   * 朗读时长差异），比纯线性进度映射更贴合真实朗读节奏。
   * 仅段落变化时上报（避免每 200ms 无谓更新 store / 重渲染）。
   */
  private startParagraphTracking(
    buffer: AudioBuffer, text: string,
    breaks: number[], indices: number[],
    onParagraphChange: (paraIdx: number) => void,
  ): void {
    this.stopParagraphTracking();
    this.trackText = text;
    this.trackBreaks = breaks;
    this.trackIndices = indices;
    this.trackOnParagraphChange = onParagraphChange;
    const ctx = this.getAudioContext();
    // 初始校准值：整体平均字符速率（字符/秒）
    const avgRate = text.length / Math.max(0.1, buffer.duration);
    let calibrated = avgRate;
    let lastParaIdx: number | null = null;
    this.paraTimer = setInterval(() => {
      // 暂停/未播放时不推进；currentSource 被 stop（暂停）时跳过
      if (this.paused || !this.currentSource) return;
      const elapsed = ctx.currentTime - this.startedAt;
      if (elapsed < 0) return;
      const charPos = Math.min(Math.floor(elapsed * calibrated), Math.max(1, text.length));
      const idx = findParagraphByCharIndex(charPos, breaks);
      if (idx < 0 || idx >= indices.length) return;
      const paraIdx = indices[idx];
      // 跨过段落边界（idx>0）时校准：实际到达 breaks[idx] 用了 elapsed 秒
      if (idx > 0 && elapsed > 0.3) {
        const observed = breaks[idx] / elapsed; // 字符/秒（从音频起点到该边界的平均速率）
        // 平滑更新并限幅，避免单段极短/超长导致速率突变
        calibrated = Math.max(
          avgRate * 0.5,
          Math.min(avgRate * 2.0, calibrated * 0.6 + observed * 0.4),
        );
      }
      // 仅段落变化时上报（B: 消除每 200ms 的无谓 store 更新）
      if (paraIdx !== lastParaIdx) {
        lastParaIdx = paraIdx;
        onParagraphChange(paraIdx);
      }
    }, 200);
  }

  private stopParagraphTracking(): void {
    if (this.paraTimer) { clearInterval(this.paraTimer); this.paraTimer = null; }
  }

  /** 恢复播放时重启段落追踪（startedAt 已在 resume 中修正） */
  private restartParagraphTracking(buffer: AudioBuffer): void {
    if (this.trackBreaks && this.trackIndices && this.trackOnParagraphChange) {
      this.startParagraphTracking(
        buffer, this.trackText, this.trackBreaks, this.trackIndices,
        this.trackOnParagraphChange,
      );
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
          this.stopParagraphTracking();
          if (!this.paused) { this.currentBuffer = null; this.pendingPlayResolve = null; resolve(); }
        };
        try { source.start(); } catch { resolve(); } // context 已关闭等异常时不要卡死
        this.pendingPlayResolve = resolve;
      };
      if (ctx.state === "suspended") {
        void this.tryResumeContext(ctx).then((running) => {
          if (running) startPlayback();
          else { console.warn("[TTS] AudioContext.resume 后仍非 running，跳过该 chunk"); resolve(); }
        });
      } else startPlayback();
    });
  }

  /**
   * 仅生成音频（不播放）：返回 AudioBuffer。
   * 供流水线预生成下一段使用；isCancelled 在生成完成后检查（wasm 同步推理无法中途取消）。
   * 注意：不能调用 this.stop()——缓冲池模式下 pumpPrefetch 会在播放当前段时
   * 并行调用本方法，stop() 会中断正在播放的 source 导致当前段被截断。
   * 播放状态（currentSource/currentBuffer）由 playBuffer/pause/resume/stop 管理。
   */
  async generateBuffer(
    text: string, speed: number, isCancelled?: () => boolean, priority?: boolean,
  ): Promise<AudioBuffer> {
    this.stopped = false; // 重置引擎级作废标志（新一轮生成）
    const ctx = this.getAudioContext();
    // tryResumeContext 带超时兜底：iOS 的 ctx.resume() 可能永不 settle，
    // 直接 await 会把生成链挂在这里
    if (!(await this.tryResumeContext(ctx))) {
      throw new Error("浏览器阻止了自动播放，请点击页面任意位置后重试");
    }
    const { samples, sampleRate } = await this.generate(text, this.voice, speed, priority);
    if (this.stopped || isCancelled?.()) throw new Error("已取消");
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(new Float32Array(samples), 0);
    return buffer;
  }

  /**
   * 播放已生成的 AudioBuffer（不生成）。
   * onPlay 在开始出声时回调；onEnd 在播放完毕回调（主动 stop 不触发）。
   * @param text 段落追踪用文本（多段 chunk 按音频进度映射段落）
   */
  async playBuffer(
    buffer: AudioBuffer,
    callbacks: { onPlay?: () => void; onEnd?: () => void; onError?: (err: string) => void },
    isCancelled?: () => boolean,
    text?: string,
    paragraphBreaks?: number[], paragraphIndices?: number[],
    onParagraphChange?: (paraIdx: number) => void,
  ): Promise<void> {
    if (this.stopped || isCancelled?.()) return;
    // 消费生成间隙的暂停请求：把本段挂起为"待恢复"（管线在此等待，不推进），
    // resume() 会从 currentBuffer 开头播放本段并在结束时 resolve。
    if (this.pauseRequested && !this.paused) {
      this.pauseRequested = false;
      this.paused = true;
      this.pausedAt = 0;
      this.currentBuffer = buffer;
      // 段落追踪必须以本 chunk 的参数建立：resume 的 restartParagraphTracking
      // 读的是追踪状态，若不在挂起前写入，会用上一个 chunk 的旧参数映射本段
      if (text && paragraphBreaks && paragraphIndices && paragraphIndices.length > 1 && onParagraphChange) {
        this.startParagraphTracking(buffer, text, paragraphBreaks, paragraphIndices, onParagraphChange);
      }
      await new Promise<void>((resolve) => { this.pendingPlayResolve = resolve; });
      // stop() 会 resolve 该 promise 并置 stopped；resume() 播放完本段后 resolve
      if (this.stopped || isCancelled?.()) return;
      callbacks.onPlay?.();
      if (!this.stopped && !isCancelled?.()) callbacks.onEnd?.();
      return;
    }
    const ctx = this.getAudioContext();
    if (!(await this.tryResumeContext(ctx))) {
      callbacks.onError?.("浏览器阻止了自动播放，请点击页面任意位置后重试");
      return;
    }
    callbacks.onPlay?.();
    // 多段 chunk：播放期间按音频进度逐段高亮（与 Web Speech onboundary 对齐）
    if (text && paragraphBreaks && paragraphIndices && paragraphIndices.length > 1 && onParagraphChange) {
      this.startParagraphTracking(buffer, text, paragraphBreaks, paragraphIndices, onParagraphChange);
    }
    await this.playOneBuffer(buffer);
    if (!this.stopped && !isCancelled?.()) callbacks.onEnd?.();
  }

  /** 生成并播放一段（便捷方法：generateBuffer + playBuffer） */
  async speak(
    text: string, speed: number, callbacks: TTSPlaybackCallbacks, isCancelled?: () => boolean,
    paragraphBreaks?: number[], paragraphIndices?: number[],
    onParagraphChange?: (paraIdx: number) => void,
  ): Promise<void> {
    try {
      const buffer = await this.generateBuffer(text, speed, isCancelled);
      if (this.stopped || isCancelled?.()) return;
      await this.playBuffer(
        buffer,
        { onPlay: () => callbacks.onPlay?.(), onEnd: () => callbacks.onEnd?.(), onError: (err) => callbacks.onError?.(err) },
        isCancelled, text, paragraphBreaks, paragraphIndices, onParagraphChange,
      );
    } catch (err) {
      if (this.stopped) return; // 主动停止（resetWorker reject）导致的取消，静默丢弃
      const msg = err instanceof Error ? err.message : String(err);
      callbacks.onError?.(`音频生成失败: ${msg}`);
    }
  }

  pause(): void {
    // 无论是否有正在播放的 source 都要记录暂停意图（生成间隙消费）
    this.pauseRequested = true;
    if (this.currentSource && !this.paused) {
      try {
        const ctx = this.getAudioContext();
        this.pausedAt = ctx.currentTime - this.startedAt;
        this.currentSource.stop();
      } catch { /* already stopped */ }
      this.currentSource = null;
      this.paused = true;
      this.stopParagraphTracking();
    }
  }

  /**
   * 恢复暂停的播放。返回 false = 没能恢复（AudioContext 仍被浏览器挂起，
   * 如 iOS 来电/锁屏/静音中断后 resume 被拒），调用方必须保持"暂停"UI。
   * 这里的关键是绝不创建 source：suspended 下 start() 静默失败——不出声、
   * 也不触发 onended，pendingPlayResolve 永不 resolve → 整条朗读链永久停摆，
   * 本会话只能刷新页面。放弃恢复并保持暂停态后，用户下一次手势内 resume 成功
   * 即从暂停点继续。
   */
  async resume(): Promise<boolean> {
    // 清除未消费的暂停请求：若用户"生成期间按暂停 → 又按播放"，生成完成时
    // pauseRequested 若还在，会把新 buffer 错误挂起（按了播放却不出声）。
    // 已挂起（paused && currentBuffer）的场景由下方分支正常消费，不受影响。
    this.pauseRequested = false;
    if (!this.paused || !this.currentBuffer) return true;
    // 连点两下/并发调用：合并为同一轮，否则两轮各建一个 source 叠播（混播）
    if (this.resumeInFlight) return await this.resumeInFlight;
    const round = this.doResume();
    this.resumeInFlight = round;
    try {
      return await round;
    } finally {
      this.resumeInFlight = null;
    }
  }

  private async doResume(): Promise<boolean> {
    const ctx = this.getAudioContext();
    const running = await this.tryResumeContext(ctx);
    // await 期间可能已被 stop()/seek/新朗读作废：此时 currentBuffer 已换或清空，
    // 必须重新取值并复查状态，否则会凭空造出一条属于上一轮的播放链
    if (!running || this.stopped || !this.paused || !this.currentBuffer) return false;
    const buffer = this.currentBuffer;
    const resolve = this.pendingPlayResolve;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // 同 playOneBuffer：播放固定 1.0 倍速，倍速由生成 speed 控制（保音高）
    source.connect(ctx.destination);
    source.onended = () => {
      this.currentSource = null;
      this.stopParagraphTracking();
      if (!this.paused) { this.currentBuffer = null; this.pendingPlayResolve = null; resolve?.(); }
    };
    this.currentSource = source;
    this.startedAt = ctx.currentTime - this.pausedAt;
    this.paused = false;
    try {
      source.start(0, this.pausedAt);
    } catch {
      this.currentSource = null;
      this.currentBuffer = null;
      this.pendingPlayResolve = null;
      resolve?.();
      return false;
    }
    // 恢复播放：重启段落追踪（startedAt 已修正，进度从暂停点继续）
    this.restartParagraphTracking(buffer);
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.stopParagraphTracking();
    this.pauseRequested = false;
    if (this.currentSource) { try { this.currentSource.stop(); } catch { /* 已停止的 source 忽略 */ } this.currentSource = null; }
    if (this.pendingPlayResolve) { this.pendingPlayResolve(); this.pendingPlayResolve = null; }
    this.currentBuffer = null;
    this.paused = false;
    this.pausedAt = 0;
  }

  isSpeaking(): boolean { return this.currentSource !== null && !this.paused; }
  isPaused(): boolean { return this.paused; }
  /**
   * 只读运行时快照（真机自检用）。iOS 上"按了继续却没声"这类问题只能靠
   * AudioContext 状态与暂停标志判定，手机又开不了 devtools，所以把它导成一行文本。
   */
  describeAudio(): string {
    const ctxState = this.audioContext ? this.audioContext.state : "(未创建)";
    return `ctx=${ctxState} paused=${this.paused} pauseRequested=${this.pauseRequested} ` +
      `source=${this.currentSource ? "有" : "无"} buffer=${this.currentBuffer ? "有" : "无"} ` +
      `pendingResolve=${this.pendingPlayResolve ? "挂着(链在等恢复)" : "无"} stopped=${this.stopped}`;
  }
  destroy(): void {
    this.stop();
    if (this.audioContext) { this.audioContext.close().catch(() => {}); this.audioContext = null; }
  }
}

/**
 * 浏览器离线推理引擎（Kokoro wasm，单线程，可离线）
 */
class BrowserKokoroEngine extends ZipVoiceTTSEngine {
  protected async generate(text: string, voice: string, speed: number, priority?: boolean): Promise<{ samples: Float32Array; sampleRate: number }> {
    let audio: Float32Array | null = null;
    await generateAudio(text, { voice, speed, priority }, async (audioData) => { audio = audioData; });
    if (audio === null) throw new Error("浏览器推理未生成音频");
    return { samples: audio, sampleRate: 24000 };
  }
}

/**
 * 服务端推理引擎（Kokoro，Python 原生多线程，RTF≈0.6，快）
 * 依赖服务器 Python + sherpa-onnx；音频经 /api/rag/tts/synthesize 获取。
 */
class ServerKokoroEngine extends ZipVoiceTTSEngine {
  protected async generate(text: string, voice: string, speed: number): Promise<{ samples: Float32Array; sampleRate: number }> {
    return await synthesizeServer(text, { voice, speed });
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
  // 上次使用过的 Kokoro 引擎类型（stop/destroy 时决定是否释放浏览器 worker）
  private lastKokoroKind: "server" | "zipvoice" | null = null;
  // ── 预生成缓冲池（A+C 方案）：播放时并行推理后续多段 ──
  private prefetchCount = 3;                       // 目标缓冲段数 K（可配置 1-10）
  private buffered: { index: number; buffer: AudioBuffer }[] = []; // 已缓存待播段（按 index 有序）
  private generateWatermark = 0;                   // 已提交生成的最高 index+1（水位推进）
  private preparing = false;                       // 预生成阶段（开播前）
  private prepareReady = 0;                        // 预生成已完成段数
  private prepareFailed = 0;                       // 预生成已失败的段数（等它们不会等来进展）
  private skipPrepareRequested = false;            // 用户点"立即播放"：提前结束预生成
  // 预生成在途任务：chunk index → 提交它的那一朗读代次。现场生成遇到同段在途时
  // 等它完成而非重复提交。带代次是必须的——旧一轮的 finally 若无条件删标记，
  // 会把新一轮同段的在途标记抹掉并误唤醒它的等待者（同一段被推理两遍）
  private inFlightPrefetch = new Map<number, number>();
  private prefetchWaiters = new Map<number, { genId: number; resolve: () => void }[]>();
  // 生成参数（语速/倍速）epoch：变更后在飞的旧参数预生成不得再入池，
  // 否则同一章里混着两套语速（代次不变，所以不能靠 generationId 作废）
  private generationEpoch = 0;

  constructor() {
    this.webSpeech = new WebSpeechTTSEngine();
    // 注册为活跃实例（供设置页试听停止朗读）；模块级引用非闭包别名，规则误报
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    activeManager = this;
  }

  setEngine(engine: TTSEngine) { this.engine = engine; }

  /**
   * 获取当前引擎对应的离线（Kokoro）引擎实例：
   * - server：服务端 Python 推理（快）
   * - zipvoice：浏览器 wasm 推理（离线）
   * webspeech 引擎返回 null。
   *
   * P0 fix: 校验实例类型与当前 engine 匹配。TTSManager 在组件生命周期内
   * 是单例（useAudioPlayer.getManager 只创建一次），setEngine 只改字段；
   * 若不校验，server → zipvoice 切换后仍返回旧的 ServerKokoroEngine，
   * 导致实际走错引擎（且 zipvoice 路径还会白白下载 380MB 模型）。
   */
  private getKokoroEngine(): ZipVoiceTTSEngine | null {
    if (this.engine === "webspeech") return null;
    const expected = this.engine === "server" ? ServerKokoroEngine : BrowserKokoroEngine;
    if (this.zipvoice && !(this.zipvoice instanceof expected)) {
      console.warn(`[TTS] 引擎类型不匹配（当前 ${this.engine}），重建 Kokoro 引擎实例`);
      this.zipvoice.destroy();
      this.zipvoice = null;
    }
    if (!this.zipvoice) {
      this.zipvoice = this.engine === "server" ? new ServerKokoroEngine() : new BrowserKokoroEngine();
    }
    this.lastKokoroKind = this.engine === "server" ? "server" : "zipvoice";
    return this.zipvoice;
  }

  /**
   * 在用户手势窗口内提前创建/恢复 AudioContext（配合 Kokoro 引擎）。
   * 首次朗读时模型加载需数秒，手势过期后 resume 被拒 → AudioContext 保持
   * suspended → source.start() 静默失败 → 生成成功但无声。
   * 调用方（朗读按钮点击）必须在 await 之前的同步阶段调用。
   */
  prewarmZipVoiceAudio(): void {
    const engine = this.getKokoroEngine();
    engine?.prewarm();
  }

  /**
   * 预生成缓冲池：把生成水位推进到 index+K，并行推理后续段并缓存。
   * 播放 chunks[i] 前调用，确保 chunks[i+1..i+K] 的生成已提交（worker 池并行）。
   * 完成结果按 index 有序存入 buffered；genId 变化（停止/seek）即丢弃。
   */
  private pumpPrefetch(): void {
    const kokoro = this.zipvoice;
    if (!kokoro || this.engine === "webspeech") return;
    if (this.stopped || this.prefetchCount <= 0) return;
    const genId = this.generationId;
    const epoch = this.generationEpoch;
    const effectiveSpeed = Math.max(0.4, Math.min(3.5, this.speed * this.playbackRate));
    // 水位目标：当前播放 index + K；预生成阶段则推进到 K
    const base = this.preparing ? 0 : this.currentChunkIndex + 1;
    const target = Math.min(this.chunks.length, base + this.prefetchCount);
    // 游标从 max(已提交进度, 当前应提交起点) 开始：
    // seek 后 clearPrefetch 把 watermark 重置为 0，但不能重新提交 seek 之前的段
    let cursor = Math.max(this.generateWatermark, base);
    // 播放中每次只提交 1 个任务：防止生成慢时一次积压 K 个预生成任务，
    // 把现场生成（高优先级插队）挤到队尾——这正是"缓冲不足 K 就不播"的根源之一。
    // limit 必须基于游标而非水位：若基于水位，seek/调速/错误重试（都走
    // clearPrefetch 置 0）后 cursor 从 base 起步而水位为 0，首轮 pump 把水位
    // 抬到 base，此后 cursor === limit === 水位+1 永久成立，缓冲池停摆，
    // 每段都退化为现场生成（zipvoice 下每段卡 30-120s）。
    const limit = this.preparing ? target : Math.min(target, cursor + 1);
    while (cursor < limit) {
      const idx = cursor++;
      const chunk = this.chunks[idx];
      if (!chunk) break;
      // 已在途（含其他代次尚未收尾的同段）→ 跳过，不重复提交
      if (this.inFlightPrefetch.get(idx) !== undefined) continue;
      this.inFlightPrefetch.set(idx, genId);
      // 异步生成：完成后若未作废则入缓冲（按 index 有序插入）
      (async () => {
        try {
          const buffer = await kokoro.generateBuffer(
            chunk.text, effectiveSpeed,
            () => this.stopped || this.generationId !== genId,
          );
          if (this.stopped || this.generationId !== genId || epoch !== this.generationEpoch) return; // 作废：停止/seek/语速变更
          // 该段已播放（现场生成插队抢先完成）→ 丢弃，避免残留永不播放的缓冲
          if (this.currentChunkIndex > idx) return;
          // 有序插入（跳过已存在 index，防止重复提交竞态）
          if (!this.buffered.some(b => b.index === idx)) {
            this.buffered.push({ index: idx, buffer });
            this.buffered.sort((a, b) => a.index - b.index);
          }
          if (this.preparing) {
            this.prepareReady++;
            this.callbacks.onPrepareProgress?.(this.prepareReady, this.prepareTotal());
          }
          this.callbacks.onBufferChange?.(this.buffered.length);
          console.log(`[TTS] ⏩ 缓冲 +1（index=${idx + 1}, 水位=${this.buffered.length}）`);
        } catch (e) {
          if (!this.stopped && this.generationId === genId) {
            // 记一笔"这段已经死了"：预生成的等待循环只看 `prepareReady` 的话，服务器
            // 一口回绝（503/未装 sherpa-onnx）时 0/K 段会一直干等到 60 秒无进展兜底才
            // 开始播放——真正的原因要在那一分钟之后才露头。
            this.prepareFailed++;
            console.warn(`[TTS] 预生成 chunk ${idx + 1} 失败（后续播放时会重试）:`, e instanceof Error ? e.message : e);
          }
        } finally {
          // 只收尾自己这一代的标记：新一轮可能已重新提交同一段
          if (this.inFlightPrefetch.get(idx) === genId) this.inFlightPrefetch.delete(idx);
          this.notifyPrefetchDone(idx, genId); // 唤醒等待该段的现场生成（成功→缓冲命中；失败→现场生成重试）
        }
      })();
    }
    this.generateWatermark = cursor; // 更新已提交进度（含 seek 后跳过的旧段）
  }

  /** 预生成阶段目标段数（当前水位与总段数的较小值） */
  private prepareTotal(): number {
    return Math.min(this.prefetchCount, this.chunks.length);
  }

  /**
   * 开播前预生成 K 段：全部完成（或用户"立即播放"跳过）后返回。
   * 期间 onPrepareProgress 持续上报 ready/total，UI 显示"正在预生成 X/K 段"。
   */
  private async prepareBuffers(): Promise<void> {
    const kokoro = this.zipvoice;
    if (!kokoro || this.engine === "webspeech" || this.prefetchCount <= 0) return;
    if (this.chunks.length === 0) return;
    const genId = this.generationId;
    this.preparing = true;
    this.prepareReady = 0;
    this.prepareFailed = 0;
    this.skipPrepareRequested = false;
    const total = this.prepareTotal();
    this.callbacks.onPrepareProgress?.(0, total);
    this.pumpPrefetch(); // 并行提交前 K 段生成（worker 池自动并行）
    // 等待：全部完成（失败也算"有了结果"）或用户立即播放（至少 1 段就绪）或被停止
    // 兜底：60s 无新进展（真卡死）则用已就绪的段开始播放，缺失段播放时现场生成
    let lastReady = this.prepareReady;
    let lastProgressAt = Date.now();
    while (this.preparing && this.prepareReady + this.prepareFailed < total) {
      if (this.stopped || this.generationId !== genId) { this.preparing = false; return; }
      if (this.skipPrepareRequested && this.prepareReady >= 1) { this.preparing = false; break; }
      if (this.prepareReady > lastReady) { lastReady = this.prepareReady; lastProgressAt = Date.now(); }
      else if (Date.now() - lastProgressAt > 60000) {
        console.warn(`[TTS] 预生成无进展 ${this.prepareReady}/${total} 段（60s），提前开始播放`);
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    this.preparing = false;
    // 这一句必须在 `onPrepareProgress` 之前：那次回调会把 UI 拨回"生成中"
    // （`useAudioPlayer.ts:265-268`），而在预生成阶段点"停止"时代次已经变了、
    // 这一代的朗读不会再推进 UI——先报进度再检查停止，播放栏就被重新点亮成
    // "生成中"并永久挂在那里。停止之后 F6 那条判据要的是"栏子收了就不再回来"。
    if (this.stopped || this.generationId !== genId) return;
    this.callbacks.onPrepareProgress?.(this.prepareReady, total);
    console.log(`[TTS] ▶ 预生成完成：${this.prepareReady}/${total} 段就绪，开始播放（缓冲 ${this.buffered.length} 段）`);
  }

  /** 用户"立即播放"：跳过剩余预生成，用已生成的段开始播（至少 1 段） */
  skipPrepare(): void {
    this.skipPrepareRequested = true;
  }

  /** 设置开播前预生成段数（下次朗读生效；0=关闭） */
  setPrefetchCount(count: number): void {
    this.prefetchCount = Math.max(0, Math.min(10, Math.round(count) || 0));
  }

  /** 唤醒等待指定段预生成完成的现场生成（成功/失败都唤醒，调用方重新检查缓冲） */
  private notifyPrefetchDone(idx: number, genId: number): void {
    const waiting = this.prefetchWaiters.get(idx);
    if (!waiting) return;
    // 只唤醒同代次的等待者：别的代次只是恰好也提交了同一段，它的任务还在跑
    const keep = waiting.filter(w => w.genId !== genId);
    if (keep.length > 0) this.prefetchWaiters.set(idx, keep);
    else this.prefetchWaiters.delete(idx);
    for (const w of waiting) if (w.genId === genId) w.resolve();
  }

  /** 注册等待：该段预生成在途时，现场生成等待其完成（不重复提交浪费推理） */
  private waitPrefetchDone(idx: number, genId: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const arr = this.prefetchWaiters.get(idx) ?? [];
      arr.push({ genId, resolve });
      this.prefetchWaiters.set(idx, arr);
    });
  }

  /** 清空缓冲与生成水位（停止/seek/语速变更/新 speak 时调用） */
  private clearPrefetch(): void {
    this.buffered = [];
    this.generateWatermark = 0;
    this.preparing = false;
    this.prepareReady = 0;
    this.prepareFailed = 0;
    this.skipPrepareRequested = false;
    // 唤醒全部等待者：调用方会因 stopped/代次变化退出（安全），并清空等待表防泄漏
    for (const waiters of this.prefetchWaiters.values()) for (const w of waiters) w.resolve();
    this.prefetchWaiters.clear();
    this.inFlightPrefetch.clear();
    this.callbacks.onBufferChange?.(0);
  }

  /**
   * 停止服务端推理的排队请求（fire-and-forget，不阻塞停止流程）。
   * 只有 server 引擎需要：zipvoice（浏览器推理）无服务器队列。
   */
  private cancelServerInference(): void {
    if (this.engine !== "server") return;
    cancelServerInference().catch(() => { /* 静默 */ });
  }

  setVoice(voiceId: string) {
    this.voiceId = voiceId;
    if (this.engine === "webspeech") {
      this.webSpeech.setVoice(voiceId);
      if (this.webSpeech.isSpeaking() && this.currentChunkIndex < this.chunks.length) {
        this.generationId++;
        this.webSpeech.stop();
        this.speakNextChunk();
      }
    } else {
      // 用 getKokoroEngine 统一入口：引擎切换后实例类型已校验重建，参数设置到正确实例
      this.getKokoroEngine()?.setVoice(voiceId);
    }
  }

  setSpeed(speed: number) {
    this.speed = Math.max(0.5, Math.min(3.0, speed));
    // 速度变更时从当前段落位置恢复，不从 chunk 头部重读
    if (this.engine === "webspeech" && this.webSpeech.isSpeaking()) {
      const para = this.currentParagraphIndex;
      this.generationId++;
      this.webSpeech.stop();
      this.speakFromParagraph(para);
    } else {
      this.applyKokoroSpeedChange();
    }
  }

  /**
   * Kokoro（server/zipvoice）语速/倍速变更后的收尾——两种状态分开处理：
   * - 正在播放：seek 回当前 chunk 用新语速重新生成（本段从头重播，保音高）
   * - 暂停中 / 生成间隙：不能 seek（会把已暂停的会话直接播起来），改为作废
   *   已入池与在飞的旧语速音频，下一段开播时按新语速补生成。
   *   漏掉这一步的后果就是"改倍速后同一章混着两套语速"（旧代码只在播放中处理）
   */
  private applyKokoroSpeedChange(): void {
    if (this.engine === "webspeech" || this.stopped || !this.zipvoice) return;
    if (this.zipvoice.isSpeaking()) {
      this.restartZipVoiceFromCurrentChunk();
      return;
    }
    this.generationEpoch++;
    this.clearPrefetch();
  }

  /**
   * 播放倍速（正文朗读栏）。
   * - Kokoro（server/zipvoice）：倍速并入生成 speed（模型级变速保音高），需重新生成当前 chunk；
   *   不再用 AudioBufferSourceNode.playbackRate（重采样会变调）
   * - WebSpeech：最终 rate = 生成语速 × 倍速，需重新 speak
   */
  setPlaybackRate(playbackRate: number) {
    this.playbackRate = Math.max(0.5, Math.min(3.0, playbackRate));
    if (this.engine === "webspeech") {
      if (!this.webSpeech.isSpeaking()) return;
      const para = this.currentParagraphIndex;
      this.generationId++;
      this.webSpeech.stop();
      this.speakFromParagraph(para);
    } else {
      this.applyKokoroSpeedChange();
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
   * Kokoro 引擎（server/zipvoice）语速/倍速变更后的恢复：
   * 从当前 chunk 用新参数重新生成。
   * 一次生成整个 chunk 音频（无 chunk 内段落定位），
   * 因此从当前 chunk 开头重读，与 seekToChunk 行为一致。
   */
  private restartZipVoiceFromCurrentChunk(): void {
    if (!this.zipvoice) return;
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
    this.clearPrefetch();
    this.cancelServerInference(); // 新朗读开始：清理上一轮遗留的排队请求
    if (this.zipvoice) this.zipvoice.stop();
    this.webSpeech.stop();

    this.chunks = chunks;
    this.currentChunkIndex = 0;
    this.currentParagraphIndex = 0;
    this.stopped = false;
    this.generationId++;

    if (chunks.length === 0) { callbacks.onError?.("没有可朗读的内容"); return; }

    const speakGenId = this.generationId; // 本次朗读代次基准（切章/停止后作废）

    if (this.engine === "webspeech") {
      const loadedVoices = await this.webSpeech.waitForVoices();
      // 防切章竞态：waitForVoices 等待（首次朗读可能 0-10s）期间用户切章/停止，
      // 旧朗读链 resolve 后必须丢弃——否则会继续 speakNextChunk 造成：
      //   a) 用户已播新章节 → 同一 chunk 双重朗读（两个 utterance 叠加）
      //   b) 用户仅切章未播放 → 幽灵朗读（声音在响但 UI 无播放状态、无法停止）
      if (this.stopped || this.generationId !== speakGenId) return;
      if (loadedVoices.length > 0) callbacks.onVoicesLoaded?.(loadedVoices);
    }

    if (this.engine !== "webspeech") {
      // 代次必须在 try 外捕获：catch 里的守卫引用 try 块内的 const 会是
      // TS2304（esbuild 构建不查类型，直接变成运行时 ReferenceError）
      const kokoroGenId = this.generationId;
      try {
        const kokoro = this.getKokoroEngine();
        if (!kokoro) throw new Error("Kokoro 引擎创建失败");
        kokoro.setVoice(this.voiceId);
        await kokoro.ensureResumed();

        // 浏览器推理（zipvoice）需要先在浏览器加载模型；服务端推理无需。
        // 无条件调用 loadModel：模型已加载且池大小一致时立即返回（幂等）；
        // 用户修改了 workerCount 时在 loadModel 内检测并重建池。
        if (this.engine === "zipvoice") {
          callbacks.onModelProgress?.(0);
          await loadModel({ onProgress: (p) => callbacks.onModelProgress?.(p) });
          if (this.generationId !== kokoroGenId) return;
          callbacks.onModelLoaded?.();
        }
        // A 方案：开播前预生成 K 段（Kokoro 引擎），期间 UI 显示进度、可"立即播放"
        if (this.prefetchCount > 0) {
          await this.prepareBuffers();
          if (this.stopped || this.generationId !== kokoroGenId) return;
        }
      } catch (err) {
        // 停止/换代触发的中断（resetWorker reject）不是加载失败：立即静默返回，
        // 否则会误降级到 Web Speech 并永久切走用户选的引擎
        if (this.stopped || this.generationId !== kokoroGenId) return;
        console.warn("[TTS] Kokoro 引擎加载失败，降级到 Web Speech API:", err);
        const failedEngine = this.engine; // 保存原引擎（server/zipvoice）
        this.engine = "webspeech";
        callbacks.onFallback?.(failedEngine, "webspeech");
      }
    }

    // 兜底：开始首个 chunk 前再次校验代次（覆盖 fallback 降级路径），
    // 确保任何来源（waitForVoices / prepareBuffers / 引擎降级）的延迟
    // 都不会让已作废的朗读链继续出声。
    if (this.stopped || this.generationId !== speakGenId) return;
    await this.speakNextChunk();
  }

  private async speakNextChunk(): Promise<void> {
    if (this.currentChunkIndex >= this.chunks.length) {
      // 章末释放缓冲池：K 段 AudioBuffer（每段可达数 MB）不该在听完之后继续占着，
      // 浏览器推理的 worker 池另由 stop()/卸载路径释放
      this.clearPrefetch();
      this.callbacks.onEnd?.();
      return;
    }

    const chunk = this.chunks[this.currentChunkIndex];
    const genId = this.generationId;

    if (this.engine !== "webspeech" && this.zipvoice) {
      this.callbacks.onChunkStart?.(this.currentChunkIndex, this.chunks.length, chunk.paragraphIndex);
      await new Promise(r => setTimeout(r, 0));
      // 有效语速 = 设置页生成语速 × 朗读栏播放倍速（clamp 到 sherpa-onnx 官方 0.4-3.5）
      const effectiveSpeed = Math.max(0.4, Math.min(3.5, this.speed * this.playbackRate));

      // ── 缓冲池：优先取已预生成的音频（播放上一段时已并行推理完成）──
      let buffer: AudioBuffer;
      const cachedIdx = this.buffered.findIndex(b => b.index === this.currentChunkIndex);
      if (cachedIdx >= 0) {
        buffer = this.buffered[cachedIdx].buffer;
        this.buffered.splice(cachedIdx, 1);
        this.callbacks.onBufferChange?.(this.buffered.length);
        console.log(`[TTS] ▶ chunk ${this.currentChunkIndex + 1}/${this.chunks.length} 使用缓冲音频（剩余 ${this.buffered.length} 段）`);
      } else {
        const chunkT0 = performance.now();
        console.log(`[TTS] ▶ 生成 chunk ${this.currentChunkIndex + 1}/${this.chunks.length} (${this.engine === "server" ? "服务端" : "浏览器"}): ${chunk.text.length} 字, speed=${effectiveSpeed.toFixed(2)}`);
        // 现场生成（缓冲未命中）：通知 UI 显示"生成中"（浏览器推理可能需 60-120s）
        this.callbacks.onGenerating?.(true);
        try {
          // 该段预生成已在途（worker 正在跑/排队）→ 等它完成，不重复提交浪费推理；
          // 完成后缓冲命中直接播放；预生成失败则回落到现场生成（插队）。
          // 只认同代次的在途标记：旧一轮残留的任务不会为这一轮产出可用音频
          if (!this.preparing && this.inFlightPrefetch.get(this.currentChunkIndex) === genId) {
            await this.waitPrefetchDone(this.currentChunkIndex, genId);
            if (this.stopped || this.generationId !== genId) return;
            const readyIdx = this.buffered.findIndex(b => b.index === this.currentChunkIndex);
            if (readyIdx >= 0) {
              buffer = this.buffered[readyIdx].buffer;
              this.buffered.splice(readyIdx, 1);
              this.callbacks.onBufferChange?.(this.buffered.length);
            } else {
              // 预生成失败：现场生成（priority 插队，不被后台任务阻塞）
              buffer = await this.zipvoice.generateBuffer(
                chunk.text, effectiveSpeed,
                () => this.stopped || this.generationId !== genId,
                true,
              );
            }
          } else {
            buffer = await this.zipvoice.generateBuffer(
              chunk.text, effectiveSpeed,
              () => this.stopped || this.generationId !== genId,
              true, // priority：现场生成插队到 worker 队列队首，不被后台预生成阻塞
            );
          }
        } catch (err) {
          this.callbacks.onGenerating?.(false);
          if (this.stopped || this.generationId !== genId) return; // 取消静默
          const msg = err instanceof Error ? err.message : String(err);
          // 服务端队列超时不标记为可重试：重试只会把排队进一步拉长
          this.callbacks.onError?.(
            `音频生成失败: ${msg}`,
            { retryable: !(err instanceof ServerInferenceTimeoutError) },
          );
          return;
        }
        this.callbacks.onGenerating?.(false);
        console.log(`[TTS] ✓ 生成完成（${((performance.now() - chunkT0) / 1000).toFixed(1)}s）`);
      }
      if (this.stopped || this.generationId !== genId) return;

      // ── 缓冲池：播放当前段的同时，并行推理后续 K 段 ──
      this.pumpPrefetch();

      const chunkT0 = performance.now();
      await this.zipvoice.playBuffer(
        buffer,
        {
          onPlay: () => {
            if (this.stopped || this.generationId !== genId) return;
            this.callbacks.onPlay?.();
          },
          onEnd: () => {
            if (this.stopped || this.generationId !== genId) return;
            // Kokoro 每个 chunk 是一整段音频，无组内逐段追踪；
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
        },
        () => this.stopped || this.generationId !== genId,
        // 多段 chunk：播放期间按音频进度逐段高亮（与 Web Speech 的 onboundary 对齐）
        chunk.text, chunk.paragraphBreaks, chunk.paragraphIndices,
        (paraIdx) => {
          if (this.stopped || this.generationId !== genId) return;
          this.currentParagraphIndex = paraIdx;
          this.callbacks.onParagraphChange?.(paraIdx);
        });
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
    if (this.engine !== "webspeech" && this.zipvoice) this.zipvoice.pause();
    else {
      // Web Speech API：保存当前段落位置，cancel 后恢复时从该位置继续。
      // 先作废旧朗读链再 cancel：引擎 stop() 已摘除 utterance 回调，这里是第二道
      // 防线——代次一变，任何仍在飞行中的 onend/onError 回调都会被守卫丢弃，
      // 不会被误当成"播完"而推进到下一段。
      this.generationId++;
      this.webSpeech.stop();
    }
    this.userPaused = true;
    this.callbacks.onPause?.();
  }

  /**
   * 恢复播放。返回 false = 未能恢复（Kokoro 引擎的 AudioContext 仍被浏览器挂起），
   * 调用方须保持暂停态 UI，不能当作已继续播放。
   */
  async resume(): Promise<boolean> {
    if (this.engine !== "webspeech" && this.zipvoice) {
      const ok = await this.zipvoice.resume();
      if (!ok) return false;      // 保持 userPaused，也不触发 onResume
      this.userPaused = false;    // 与 pause() 对称：否则 isPaused() 恒真，无法再次暂停
    } else {
      this.generationId++;         // 作废暂停期间残留的旧朗读链（同 pause）
      this.webSpeech.stop();
      this.userPaused = false;
      // 从当前段落位置恢复（不是从 chunk 头部）
      this.speakFromParagraph(this.currentParagraphIndex);
    }
    this.callbacks.onResume?.();
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.userPaused = false;
    this.generationId++;
    this.seekId++;
    this.currentParagraphIndex = 0;
    this.clearPrefetch(); // 丢弃预生成
    this.cancelServerInference(); // 释放服务器队列（服务端推理）
    if (this.zipvoice) this.zipvoice.stop();
    this.webSpeech.stop();
    // 仅浏览器推理需要立即中断 worker：wasm 同步推理无法取消单次任务，
    // 只能 terminate worker 让 CPU 立刻释放；结果也不会再回来（pending 已 reject）。
    // server/webspeech 朗读不涉及浏览器 worker，无需卸载（避免反复加载 3-5s）。
    if (this.lastKokoroKind === "zipvoice") {
      resetWorker();
    }
    this.callbacks.onStop?.();
  }

  getCurrentChunkIndex(): number { return this.currentChunkIndex; }
  getCurrentGenerationId(): number { return this.generationId; }

  /**
   * 只读运行时快照（真机自检 / DebugPanel 用）：引擎、进度、缓冲池、AudioContext 状态。
   * 不改变任何状态，也不触发加载。
   */
  describeRuntime(): string {
    const kokoro = this.zipvoice ? this.zipvoice.describeAudio() : "无 Kokoro 实例";
    return `engine=${this.engine} lastKokoro=${this.lastKokoroKind ?? "-"} ` +
      `chunk=${this.currentChunkIndex + 1}/${this.chunks.length} para=${this.currentParagraphIndex} ` +
      `gen=${this.generationId} userPaused=${this.userPaused} stopped=${this.stopped} ` +
      `缓冲池=${this.buffered.length}段 在飞预生成=${this.inFlightPrefetch.size} · 音频侧[${kokoro}]`;
  }

  seekToChunk(index: number): void {
    if (index >= 0 && index < this.chunks.length) {
      this.generationId++;
      this.userPaused = false;
      this.stopped = true;
      this.clearPrefetch(); // 丢弃预生成（目标 chunk 可能不是预生成的）
      this.cancelServerInference(); // 旧 chunk 的排队请求作废，释放队列
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
    if (this.engine === "webspeech") return this.webSpeech.isSpeaking();
    return this.getKokoroEngine()?.isSpeaking() ?? false;
  }

  isPaused(): boolean {
    if (this.engine === "webspeech") return this.userPaused;
    // userPaused 覆盖"生成间隙已按下暂停"的窗口（此时引擎尚无 paused 状态）
    return this.userPaused || (this.getKokoroEngine()?.isPaused() ?? false);
  }

  destroy(): void {
    this.stopped = true;
    this.userPaused = false;
    this.generationId++;
    this.clearPrefetch();
    this.cancelServerInference();
    if (this.zipvoice) { this.zipvoice.destroy(); this.zipvoice = null; }
    this.webSpeech.destroy();
    // 组件卸载：中断 worker 推理，避免页面切走后 CPU 仍在跑
    resetWorker();
    if (activeManager === this) activeManager = null;
    this.callbacks.onStop?.();
  }
}
