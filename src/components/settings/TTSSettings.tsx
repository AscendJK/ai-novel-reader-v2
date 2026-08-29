/**
 * TTS 语音朗读设置
 * 支持双引擎：Web Speech（浏览器内置）+ Kokoro（离线，sherpa-onnx 1.13.6 WASM）
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Loader2, Play } from "lucide-react";
import { useTTSStore } from "@/stores/tts-store";
import { classifyVoices } from "@/tts/voice-classify";
import { ZH_VOICES, generateAudioFull } from "@/tts/zipvoice-engine";
import { getActiveTTSManager } from "@/tts/tts-manager";
import { getTTSPreloadStatus } from "@/tts/tts-preload";

export function TTSSettings() {
  const {
    voiceId, speed, pitch, autoNextChapter, browserVoices, engine, zipvoiceChunkSize, webspeechChunkSize,
    setVoiceId, setSpeed, setPitch, setAutoNextChapter, setBrowserVoices, setEngine, setZipvoiceChunkSize, setWebspeechChunkSize,
  } = useTTSStore();

  const [loading, setLoading] = useState(false);
  const [loadAttempted, setLoadAttempted] = useState(false);

  // ZipVoice 预加载状态（登录后自动触发，此处仅展示）
  const [preloadStatus, setPreloadStatus] = useState(getTTSPreloadStatus());
  useEffect(() => {
    const timer = setInterval(() => setPreloadStatus(getTTSPreloadStatus()), 2000);
    return () => clearInterval(timer);
  }, []);

  // 平台能力检测（Web Speech API 支持情况）：
  // - Android Chromium（Chrome/Edge）：speak() 可用，但部分版本 getVoices() 恒空（不提供列表）
  // - iOS（WebKit）：支持，但 speak() 必须在用户手势内调用
  // - 桌面：完整支持
  const speechPlatform = useMemo(() => {
    if (typeof navigator === "undefined" || typeof speechSynthesis === "undefined") return "unsupported";
    const ua = navigator.userAgent || "";
    if (/Android/i.test(ua)) return "android";
    if (/iPad|iPhone|iPod/i.test(ua)) return "ios";
    return "desktop";
  }, []);
  // 安全上下文：Web Speech API 仅在 HTTPS（或 localhost）可用
  const insecureContext = typeof window !== "undefined"
    && typeof window.isSecureContext === "boolean"
    && !window.isSecureContext;

  // 语音列表去重：getVoices() 每次可能返回新数组引用，
  // 内容未变化时不 setState，避免每 2 秒触发重渲染
  const lastVoicesKeyRef = useRef<string>("");
  const applyVoices = useCallback((voices: SpeechSynthesisVoice[]) => {
    if (!voices || voices.length === 0) return;
    const key = voices.map(v => `${v.voiceURI}|${v.lang}|${v.name}`).join("\n");
    if (key === lastVoicesKeyRef.current) return;
    lastVoicesKeyRef.current = key;
    setBrowserVoices(voices);
  }, [setBrowserVoices]);

  // 持续轮询语音列表（每 2 秒检查一次）
  // 注意：不监听 voiceschanged 事件——Android Chromium 上每次 getVoices()
  // 都可能触发该事件，监听器会引发 getVoices()/voiceschanged 事件风暴，
  // 干扰 TTS 引擎初始化导致 getVoices() 恒空（60510448 可用版本的机制）
  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const tryRead = () => {
      const all = speechSynthesis.getVoices();
      applyVoices(all);
    };
    tryRead();
    const poll = setInterval(tryRead, 2000);
    return () => clearInterval(poll);
  }, [applyVoices]);

  // 分类：按语言分组（中文优先）→ 按网络细分（本地/在线/未知）。纯计算，缓存避免重复执行。
  const voiceGroups = useMemo(() => classifyVoices(browserVoices), [browserVoices]);

  // 已选语音（voiceId）从列表中消失时，自动回落：中文第一个 → 列表第一个，避免空白选择
  const effectiveVoiceId = useMemo(() => {
    if (browserVoices.some(v => v.voiceURI === voiceId)) return voiceId;
    const zhFirst = voiceGroups.find(g => g.lang === "zh")?.groups[0]?.voices[0];
    return zhFirst?.voiceURI || browserVoices[0]?.voiceURI || "";
  }, [browserVoices, voiceId, voiceGroups]);

  const voicesLoaded = browserVoices.length > 0;

  // 语音列表加载 — 零宽空格无声触发 Chrome 引擎初始化
  const loadVoicesRef = useRef<{ poll: ReturnType<typeof setInterval> | null; fallback: ReturnType<typeof setTimeout> | null }>({ poll: null, fallback: null });
  useEffect(() => () => {
    const r = loadVoicesRef.current;
    if (r.poll) clearInterval(r.poll);
    if (r.fallback) clearTimeout(r.fallback);
  }, []);

  const loadVoices = useCallback(() => {
    if (voicesLoaded) return;
    if (typeof speechSynthesis === "undefined") {
      setLoading(false);
      setLoadAttempted(true);
      return;
    }
    setLoading(true);
    setLoadAttempted(true);

    // 1) 手势内先读一次（iOS/部分浏览器此时已填充列表）
    const initial = speechSynthesis.getVoices();
    if (initial.length > 0) {
      applyVoices(initial);
      setLoading(false);
      return;
    }

    // 2) 兜底轮询：不依赖 speak 的任何事件回调（Android 上零宽空格可能被
    //    Google TTS 忽略，onstart/onerror 都不触发），12s 内每 500ms 读一次
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      const all = speechSynthesis.getVoices();
      if (all.length > 0) {
        applyVoices(all);
        clearInterval(poll);
        loadVoicesRef.current.poll = null;
        setLoading(false);
      } else if (attempts === 3) {
        // 3) 零宽空格未唤醒引擎时，升级为真实短文本强制唤醒（中文句号几乎无声）
        try {
          const wake = new SpeechSynthesisUtterance("。");
          wake.lang = "zh-CN";
          speechSynthesis.speak(wake);
        } catch { /* 忽略 */ }
      } else if (attempts > 24) {
        clearInterval(poll);
        loadVoicesRef.current.poll = null;
        setLoading(false);
      }
    }, 500);
    loadVoicesRef.current.poll = poll;

    // 4) 零宽空格无声触发（首选：桌面 Chrome/部分 Android 生效）
    try {
      const dummy = new SpeechSynthesisUtterance("​");
      dummy.lang = "zh-CN";
      dummy.onstart = () => { /* 兜底轮询已在运行，无需额外逻辑 */ };
      dummy.onerror = () => {
        // speak 失败但语音列表可能已填充（部分引擎），再读一次兜底
        const after = speechSynthesis.getVoices();
        if (after.length > 0) applyVoices(after);
      };
      speechSynthesis.speak(dummy);
    } catch { /* 忽略 */ }

    const fb = setTimeout(() => setLoading(false), 12000);
    loadVoicesRef.current.fallback = fb;
  }, [voicesLoaded, applyVoices]);

  // 语音试听
  const [previewing, setPreviewing] = useState(false);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
  }, []);

  const previewVoice = useCallback((previewVoiceId: string) => {
    if (previewing) return;
    const state = useTTSStore.getState();
    if (state.playing) {
      speechSynthesis.cancel();
      state.reset();
    }
    const utterance = new SpeechSynthesisUtterance("各位村民，大家新年好。近期，湖北省武汉市等多个地区。");
    utterance.lang = "zh-CN";
    const voice = browserVoices.find(v => v.voiceURI === previewVoiceId);
    if (voice) utterance.voice = voice;
    utterance.onend = () => { if (previewTimerRef.current) { clearTimeout(previewTimerRef.current); previewTimerRef.current = null; } setPreviewing(false); };
    utterance.onerror = () => { if (previewTimerRef.current) { clearTimeout(previewTimerRef.current); previewTimerRef.current = null; } setPreviewing(false); };
    setPreviewing(true);
    speechSynthesis.speak(utterance);
    previewTimerRef.current = setTimeout(() => { speechSynthesis.cancel(); previewTimerRef.current = null; setPreviewing(false); }, 30000);
  }, [browserVoices, previewing]);

  // ── ZipVoice 离线音色试听 ──
  const effectiveZipVoiceId = ZH_VOICES[voiceId] ? voiceId : "45";
  const [zipPreviewing, setZipPreviewing] = useState(false);
  const [zipPreviewError, setZipPreviewError] = useState<string | null>(null);
  const zipPreviewCtxRef = useRef<AudioContext | null>(null);
  const zipPreviewSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const zipPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (zipPreviewTimerRef.current) clearTimeout(zipPreviewTimerRef.current);
    try { zipPreviewSourceRef.current?.stop(); } catch { /* 忽略 */ }
    zipPreviewSourceRef.current = null;
    try { zipPreviewCtxRef.current?.close(); } catch { /* 忽略 */ }
    zipPreviewCtxRef.current = null;
  }, []);

  const previewZipVoice = useCallback(async (previewVoiceId: string) => {
    if (zipPreviewing) return;
    const state = useTTSStore.getState();
    // 停止正在进行的朗读（Web Speech 或 ZipVoice），避免混音
    if (state.playing) {
      const manager = getActiveTTSManager();
      if (manager) manager.stop();
      else state.reset();
    }
    setZipPreviewError(null);
    setZipPreviewing(true);
    try {
      // 用户手势窗口内创建/恢复 AudioContext（否则 resume 被拒 → 播放无声）
      if (!zipPreviewCtxRef.current) zipPreviewCtxRef.current = new AudioContext();
      const ctx = zipPreviewCtxRef.current;
      if (ctx.state === "suspended") {
        try { await ctx.resume(); } catch { /* 下面统一检查 */ }
      }
      const result = await generateAudioFull(
        "各位村民，大家新年好。近期，湖北省武汉市等多个地区。",
        { voice: previewVoiceId, speed: useTTSStore.getState().speed },
      );
      if (ctx.state !== "running") {
        setZipPreviewError("浏览器阻止了自动播放，请点击页面任意位置后重试");
        setZipPreviewing(false);
        return;
      }
      const buffer = ctx.createBuffer(1, result.audio.length, result.sampleRate);
      buffer.copyToChannel(result.audio, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      zipPreviewSourceRef.current = source;
      source.onended = () => {
        zipPreviewSourceRef.current = null;
        setZipPreviewing(false);
      };
      source.start();
      // 兜底：试听超时（60s）自动停止
      zipPreviewTimerRef.current = setTimeout(() => {
        try { source.stop(); } catch { /* 已结束 */ }
        zipPreviewSourceRef.current = null;
        setZipPreviewing(false);
      }, 60000);
    } catch (err) {
      setZipPreviewError(err instanceof Error ? err.message : String(err));
      setZipPreviewing(false);
    }
  }, [zipPreviewing]);

  return (
    <div className="space-y-4">
      <div>
        <p className="font-medium text-sm">语音朗读</p>
        <p className="text-xs text-muted-foreground">
          {engine === "webspeech"
            ? "使用浏览器内置 Web Speech API（免下载）"
            : "使用 ZipVoice 离线引擎（sherpa-onnx WASM，可离线）"}
        </p>
      </div>

      <Separator />

      {/* 朗读引擎切换 */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">朗读引擎</p>
        <div className="grid grid-cols-2 gap-2">
          <button
            aria-label="朗读引擎：Web Speech（浏览器内置）"
            className={`rounded-lg border px-3 py-2 text-left transition-colors ${engine === "webspeech" ? "border-primary bg-primary/10" : "hover:bg-muted"}`}
            onClick={() => setEngine("webspeech")}
          >
            <p className="text-xs font-medium">Web Speech</p>
            <p className="text-[10px] text-muted-foreground">浏览器内置 · 免下载</p>
          </button>
          <button
            aria-label="朗读引擎：ZipVoice（离线引擎）"
            className={`rounded-lg border px-3 py-2 text-left transition-colors ${engine === "zipvoice" ? "border-primary bg-primary/10" : "hover:bg-muted"}`}
            onClick={() => setEngine("zipvoice")}
          >
            <p className="text-xs font-medium">ZipVoice 离线</p>
            <p className="text-[10px] text-muted-foreground">本地推理 · 可离线</p>
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          {engine === "webspeech"
            ? "Android 版 Edge/Chrome 可能无法选择音色，可切换到 ZipVoice"
            : "首次使用需下载语音模型（约 380MB），下载完成后完全离线"}
        </p>
      </div>

      <Separator />

      {/* 语音选择（按引擎分支） */}
      {engine === "webspeech" ? (
        <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">语音选择</p>
        {voicesLoaded ? (
          <div className="flex gap-2">
            <select
              aria-label="语音选择"
              className="flex-1 text-xs border rounded px-2 py-1.5 bg-background"
              value={effectiveVoiceId}
              onChange={(e) => setVoiceId(e.target.value)}
            >
              {/* 无中文语音时的提示项（不可选） */}
              {!voiceGroups.some(g => g.lang === "zh") && (
                <option value="" disabled>此浏览器无中文语音，将使用系统默认</option>
              )}
              {voiceGroups.map((lg) =>
                lg.groups.map((ng) => (
                  <optgroup key={`${lg.lang}-${ng.tag}`} label={`${lg.label} · ${ng.label}`}>
                    {ng.voices.map((v) => (
                      <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>
                    ))}
                  </optgroup>
                ))
              )}
            </select>
            <Button variant="outline" size="sm" className="h-7 text-[10px] px-2"
              onClick={() => previewVoice(effectiveVoiceId)} disabled={previewing}>
              {previewing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              <span className="ml-1">试听</span>
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {speechPlatform === "unsupported" ? (
              <p className="text-xs text-muted-foreground">当前浏览器不支持 Web Speech 语音朗读</p>
            ) : insecureContext ? (
              <p className="text-xs text-muted-foreground">需通过 HTTPS 访问才能使用浏览器语音朗读</p>
            ) : loadAttempted && !loading ? (
              <p className="text-xs text-muted-foreground">
                {speechPlatform === "android"
                  ? "此浏览器（Android 版）不提供语音列表，将使用系统默认语音朗读（朗读功能正常）"
                  : "当前浏览器未返回语音列表，将使用系统默认语音朗读（不影响朗读功能）"}
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {loading ? "正在加载语音列表..." : "未检测到语音，点击下方按钮加载"}
                </p>
                <Button variant="outline" size="sm" className="h-7 text-[10px]"
                  onClick={loadVoices} disabled={loading}>
                  {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                  {loading ? "加载中..." : "加载语音列表"}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      ) : (
        /* ZipVoice：离线音色选择 */
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">离线音色</p>
          <div className="flex gap-2">
            <select
              aria-label="离线音色选择"
              className="flex-1 text-xs border rounded px-2 py-1.5 bg-background"
              value={ZH_VOICES[voiceId] ? voiceId : "45"}
              onChange={(e) => setVoiceId(e.target.value)}
            >
              {Object.entries(ZH_VOICES).map(([id, v]) => (
                <option key={id} value={id}>{v.name}</option>
              ))}
            </select>
            <Button variant="outline" size="sm" className="h-7 text-[10px] px-2 shrink-0"
              onClick={() => previewZipVoice(effectiveZipVoiceId)} disabled={zipPreviewing}>
              {zipPreviewing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              <span className="ml-1">试听</span>
            </Button>
          </div>
          {zipPreviewError && (
            <p className="text-[10px] text-red-500">试听失败：{zipPreviewError}</p>
          )}
          {zipPreviewing && (
            <p className="text-[10px] text-amber-500">正在本地生成试听音频（首次需加载模型，可能较慢）...</p>
          )}
          <p className="text-[10px] text-muted-foreground">
            Kokoro 离线引擎，生成在本地完成（无网络请求）
          </p>
          {/* 资源预加载状态（登录后自动触发） */}
          {engine === "zipvoice" && preloadStatus === "downloading" && (
            <p className="text-[10px] text-amber-500">正在后台下载语音资源（约 190MB），完成后即可离线使用</p>
          )}
          {engine === "zipvoice" && preloadStatus === "ready" && (
            <p className="text-[10px] text-green-600">✓ 语音资源已就绪，可离线使用</p>
          )}
          {engine === "zipvoice" && (preloadStatus === "skipped" || preloadStatus === "failed" || preloadStatus === "idle") && (
            <p className="text-[10px] text-muted-foreground">首次朗读时会自动下载模型，请耐心等待</p>
          )}
        </div>
      )}

      {/* 单次生成字数（离线引擎分块大小；Web Speech 无此概念，隐藏） */}
      {engine === "zipvoice" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">
              {engine === "zipvoice" ? "单次生成字数（ZipVoice）" : "一次朗读字数（Web Speech）"}
            </p>
            <span className="text-xs text-muted-foreground">{engine === "zipvoice" ? zipvoiceChunkSize : webspeechChunkSize} 字</span>
          </div>
          <input type="range" min={30} max={500} step={10}
            value={engine === "zipvoice" ? zipvoiceChunkSize : webspeechChunkSize}
            aria-label={engine === "zipvoice" ? "单次生成字数" : "一次朗读字数"}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (engine === "zipvoice") setZipvoiceChunkSize(v);
              else setWebspeechChunkSize(v);
            }}
            className="w-full h-1.5" />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>30</span><span>150</span><span>300</span><span>500</span>
          </div>
          <p className="text-[10px] text-muted-foreground">
            {engine === "zipvoice"
              ? "每次生成一段音频的字数上限：调小更不容易超时（低配设备），调大减少生成次数（高配设备）。 按句子边界切分，不会拆开一句话"
              : "每次朗读一段文本的字数上限：调大可减少段落切换频率，调小更精细。 按句子边界切分，不会拆开一句话"}
          </p>
        </div>
      )}

      {/* 语速（TTS 生成参数，与正文朗读栏的播放倍速独立） */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">语速（生成参数）</p>
          <span className="text-xs text-muted-foreground">{speed.toFixed(1)}x</span>
        </div>
        <input type="range" min={0.5} max={3.0} step={0.25} value={speed}
          aria-label="语速"
          onChange={(e) => setSpeed(parseFloat(e.target.value))} className="w-full h-1.5" />
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>0.5x</span><span>1.0x</span><span>2.0x</span><span>3.0x</span>
        </div>
        <p className="text-[10px] text-muted-foreground">
          控制语音本身的生成快慢；朗读栏的「播放倍速」独立于此，两者相乘为实际听感语速
        </p>
      </div>

      {/* F8: 音调（仅 Web Speech 生效） */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">音调</p>
          <span className="text-xs text-muted-foreground">{pitch.toFixed(1)}</span>
        </div>
        <input type="range" min={0.5} max={2.0} step={0.1} value={pitch}
          aria-label="音调"
          onChange={(e) => setPitch(parseFloat(e.target.value))} className="w-full h-1.5" />
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>低</span><span>正常</span><span>高</span>
        </div>
        {engine === "zipvoice" && (
          <p className="text-[10px] text-amber-500">ZipVoice 离线引擎暂不支持音调调节，此设置仅对 Web Speech 生效</p>
        )}
      </div>

      {/* 自动翻章 */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-muted-foreground">自动翻章</p>
          <p className="text-[10px] text-muted-foreground">当前章播放完毕后自动播放下一章</p>
        </div>
        <button
          aria-label={`自动翻章：${autoNextChapter ? "开启" : "关闭"}`}
          className={`w-10 h-5 rounded-full transition-colors ${autoNextChapter ? "bg-primary" : "bg-muted"}`}
          onClick={() => setAutoNextChapter(!autoNextChapter)}
        >
          <div className={`w-4 h-4 rounded-full bg-white transition-transform ${autoNextChapter ? "translate-x-5" : "translate-x-0.5"}`} />
        </button>
      </div>
    </div>
  );
}
