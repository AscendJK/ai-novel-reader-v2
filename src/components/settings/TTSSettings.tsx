/**
 * TTS 语音朗读设置
 * 三引擎：
 * - 服务端推理（server）：Python sherpa-onnx 原生多线程，快（RTF≈0.6），需服务器装 Python
 * - 浏览器推理（zipvoice）：sherpa-onnx WASM 离线推理，可离线，较慢（RTF≈12）
 * - Web Speech（webspeech）：浏览器内置，免下载
 * 模型下载改为按需：选择对应功能时通过「启用」按钮触发，不再登录后自动下载。
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Loader2, Play, Server, Cpu, Volume2, Download, CheckCircle2, AlertTriangle } from "lucide-react";
import { useTTSStore } from "@/stores/tts-store";
import { classifyVoices } from "@/tts/voice-classify";
import { ZH_VOICES, generateAudioFull, loadModel, isModelLoaded } from "@/tts/zipvoice-engine";
import { checkServerInference, synthesizeServer } from "@/tts/server-engine";
import { getActiveTTSManager } from "@/tts/tts-manager";
import { getTTSPreloadStatus, preloadZipVoice } from "@/tts/tts-preload";
import { apiFetch } from "@/lib/api-client";

export function TTSSettings() {
  const {
    voiceId, speed, pitch, autoNextChapter, browserVoices, engine, chunkSize,
    prefetchCount, workerCount,
    setVoiceId, setSpeed, setPitch, setAutoNextChapter, setBrowserVoices, setEngine, setChunkSize,
    setPrefetchCount, setWorkerCount,
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
      // 首次试听需显式加载模型：generateAudioFull 不自动加载，
      // 而正文朗读的 speak() 内部会先 loadModel，所以正文能启动而试听报“模型未加载”。
      // loadModel 幂等：已在正文朗读加载过则直接返回。
      await loadModel();
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
      // 拷贝一份再写入：copyToChannel 在 TS 5.7+ DOM 类型中要求 Float32Array<ArrayBuffer>，
      // 与 tts-manager 的 playOneBuffer 写法保持一致
      buffer.copyToChannel(new Float32Array(result.audio), 0);
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

  // ── 服务端推理（server）状态 ──
  const [serverStatus, setServerStatus] = useState<{ supported: boolean; ready: boolean; reason: string } | null>(null);
  const [serverChecking, setServerChecking] = useState(true);
  const [serverPreparing, setServerPreparing] = useState(false);
  const [serverPrepareStep, setServerPrepareStep] = useState("");
  const [serverPrepareDetail, setServerPrepareDetail] = useState("");
  const [serverPrepareDone, setServerPrepareDone] = useState(false);
  const [serverPreviewing, setServerPreviewing] = useState(false);
  const [serverPreviewError, setServerPreviewError] = useState<string | null>(null);
  const serverPreviewCtxRef = useRef<AudioContext | null>(null);
  const serverPreviewSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const serverPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 刷新服务端推理可用性（不触发下载，仅探测）
  const refreshServerStatus = useCallback(async () => {
    setServerChecking(true);
    const st = await checkServerInference();
    setServerStatus(st);
    setServerChecking(false);
  }, []);

  useEffect(() => {
    // 延迟到 effect 之后的宏任务再 setState，避免级联渲染
    const t = setTimeout(() => refreshServerStatus(), 0);
    const timer = setInterval(refreshServerStatus, 30000); // 30s 轮询（下载完成/服务器状态变化后自动刷新）
    return () => { clearTimeout(t); clearInterval(timer); };
  }, [refreshServerStatus]);

  useEffect(() => () => {
    if (serverPreviewTimerRef.current) clearTimeout(serverPreviewTimerRef.current);
    try { serverPreviewSourceRef.current?.stop(); } catch { /* 忽略 */ }
    serverPreviewSourceRef.current = null;
    try { serverPreviewCtxRef.current?.close(); } catch { /* 忽略 */ }
    serverPreviewCtxRef.current = null;
  }, []);

  /**
   * 启用服务端推理：确保模型在服务器上就绪（懒下载，SSE 进度）。
   * 通过 /api/rag/tts/prepare 触发，服务器资源已就绪时秒回。
   */
  const enableServerInference = useCallback(async () => {
    setServerPreparing(true);
    setServerPrepareDone(false);
    setServerPrepareStep("检查中...");
    setServerPrepareDetail("");
    try {
      const res = await apiFetch("/api/rag/tts/prepare");
      if (!res.ok) throw new Error(`服务器返回 ${res.status}`);
      if (!res.body) throw new Error("响应为空");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === "step") {
              setServerPrepareStep(data.step);
              setServerPrepareDetail(data.detail || "");
            } else if (data.type === "done") {
              completed = true;
            } else if (data.type === "error") {
              throw new Error(data.message);
            }
          } catch (e) {
            if (e instanceof Error && e.message !== "服务器连接失败") throw e;
          }
        }
      }
      if (!completed) throw new Error("服务器未返回完成状态");
      setServerPrepareDone(true);
      await refreshServerStatus();
    } catch (err) {
      setServerPrepareStep("失败");
      setServerPrepareDetail(err instanceof Error ? err.message : String(err));
    } finally {
      setServerPreparing(false);
    }
  }, [refreshServerStatus]);

  // 服务端推理音色试听
  const previewServerVoice = useCallback(async (previewVoiceId: string) => {
    if (serverPreviewing) return;
    const state = useTTSStore.getState();
    if (state.playing) {
      const manager = getActiveTTSManager();
      if (manager) manager.stop();
      else state.reset();
    }
    setServerPreviewError(null);
    setServerPreviewing(true);
    try {
      if (!serverPreviewCtxRef.current) serverPreviewCtxRef.current = new AudioContext();
      const ctx = serverPreviewCtxRef.current;
      if (ctx.state === "suspended") {
        try { await ctx.resume(); } catch { /* 统一检查 */ }
      }
      const result = await synthesizeServer(
        "各位村民，大家新年好。近期，湖北省武汉市等多个地区。",
        { voice: previewVoiceId, speed: useTTSStore.getState().speed },
      );
      if (ctx.state !== "running") {
        setServerPreviewError("浏览器阻止了自动播放，请点击页面任意位置后重试");
        setServerPreviewing(false);
        return;
      }
      const buffer = ctx.createBuffer(1, result.samples.length, result.sampleRate);
      buffer.copyToChannel(new Float32Array(result.samples), 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      serverPreviewSourceRef.current = source;
      source.onended = () => {
        serverPreviewSourceRef.current = null;
        setServerPreviewing(false);
      };
      source.start();
      serverPreviewTimerRef.current = setTimeout(() => {
        try { source.stop(); } catch { /* 已结束 */ }
        serverPreviewSourceRef.current = null;
        setServerPreviewing(false);
      }, 60000);
    } catch (err) {
      setServerPreviewError(err instanceof Error ? err.message : String(err));
      setServerPreviewing(false);
    }
  }, [serverPreviewing]);

  // 浏览器推理资源就绪状态（IndexedDB 缓存 + 服务器模型）
  const browserReady = isModelLoaded() || (typeof window !== "undefined" && !!window.indexedDB);

  return (
    <div className="space-y-4">
      <div>
        <p className="font-medium text-sm">语音朗读</p>
        <p className="text-xs text-muted-foreground">
          {engine === "server"
            ? "服务端推理：服务器 Python 多线程生成（快，可边听边推理）"
            : engine === "zipvoice"
              ? "浏览器推理：本地 wasm 生成（可离线）"
              : "浏览器内置 Web Speech API（免下载）"}
        </p>
      </div>

      <Separator />

      {/* 朗读引擎切换（三选一） */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">朗读引擎</p>
        <div className="grid grid-cols-3 gap-2">
          <button
            aria-label="朗读引擎：服务端推理"
            className={`rounded-lg border px-2 py-2 text-left transition-colors ${engine === "server" ? "border-primary bg-primary/10" : "hover:bg-muted"}`}
            onClick={() => setEngine("server")}
          >
            <p className="text-xs font-medium flex items-center gap-1">
              <Server className="h-3 w-3 shrink-0" /> 服务端推理
            </p>
            <p className="text-[10px] text-muted-foreground">快 · 推荐</p>
            {serverChecking ? (
              <p className="text-[10px] text-muted-foreground flex items-center gap-1 mt-1"><Loader2 className="h-2.5 w-2.5 animate-spin" />检测中</p>
            ) : serverStatus?.supported ? (
              <p className={`text-[10px] mt-1 flex items-center gap-1 ${serverStatus.ready ? "text-green-600" : "text-amber-500"}`}>
                {serverStatus.ready ? <CheckCircle2 className="h-2.5 w-2.5" /> : <AlertTriangle className="h-2.5 w-2.5" />}
                {serverStatus.ready ? "已就绪" : "模型未下载"}
              </p>
            ) : (
              <p className="text-[10px] text-red-500 mt-1">服务器不支持</p>
            )}
          </button>
          <button
            aria-label="朗读引擎：浏览器推理（离线）"
            className={`rounded-lg border px-2 py-2 text-left transition-colors ${engine === "zipvoice" ? "border-primary bg-primary/10" : "hover:bg-muted"}`}
            onClick={() => setEngine("zipvoice")}
          >
            <p className="text-xs font-medium flex items-center gap-1">
              <Cpu className="h-3 w-3 shrink-0" /> 浏览器推理
            </p>
            <p className="text-[10px] text-muted-foreground">离线 · 较慢</p>
            <p className={`text-[10px] mt-1 flex items-center gap-1 ${browserReady ? "text-green-600" : "text-muted-foreground"}`}>
              {browserReady ? <CheckCircle2 className="h-2.5 w-2.5" /> : <Download className="h-2.5 w-2.5" />}
              {browserReady ? "可用" : "需下载模型"}
            </p>
          </button>
          <button
            aria-label="朗读引擎：Web Speech（浏览器内置）"
            className={`rounded-lg border px-2 py-2 text-left transition-colors ${engine === "webspeech" ? "border-primary bg-primary/10" : "hover:bg-muted"}`}
            onClick={() => setEngine("webspeech")}
          >
            <p className="text-xs font-medium flex items-center gap-1">
              <Volume2 className="h-3 w-3 shrink-0" /> Web Speech
            </p>
            <p className="text-[10px] text-muted-foreground">免下载</p>
            <p className="text-[10px] text-muted-foreground mt-1">浏览器内置</p>
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          {engine === "server"
            ? "由服务器 Python 多线程推理（RTF≈0.6，生成比播放快，可边听边推理）。首次使用需在服务器下载模型（约 350MB，仅一次）。"
            : engine === "zipvoice"
              ? "浏览器本地 wasm 推理（RTF≈12），完全离线可用。首次使用需下载模型到浏览器（约 380MB）。"
              : "Android 版 Edge/Chrome 可能无法选择音色，可切换到服务端或浏览器推理"}
        </p>
      </div>

      <Separator />

      {/* 服务端推理：启用 / 状态区 */}
      {engine === "server" && (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-xs font-medium">服务端推理设置</p>
          {serverChecking ? (
            <p className="text-[10px] text-muted-foreground">正在检测服务器推理能力...</p>
          ) : !serverStatus?.supported ? (
            <div className="space-y-2">
              <p className="text-[10px] text-red-500">服务器未启用服务端推理：{serverStatus?.reason || "Python 或 sherpa-onnx 未安装"}</p>
              <p className="text-[10px] text-muted-foreground">
                部署要求：服务器安装 Python 3.9+ 并执行 <code className="bg-muted px-1 rounded">pip install sherpa-onnx</code>（约 30MB）。
                安装完成后刷新本页面即可。
              </p>
            </div>
          ) : serverStatus.ready ? (
            <p className="text-[10px] text-green-600 flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> 服务端推理已就绪（模型已下载到服务器，可直接朗读/试听）
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-[10px] text-amber-500">服务端推理可用，但模型尚未下载到服务器（约 350MB，仅一次）。</p>
              <Button variant="outline" size="sm" className="h-7 text-[10px]"
                onClick={enableServerInference} disabled={serverPreparing}>
                {serverPreparing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Download className="h-3 w-3 mr-1" />}
                {serverPreparing ? "下载中..." : "启用服务端推理（下载模型）"}
              </Button>
              {serverPreparing && (
                <p className="text-[10px] text-amber-500">{serverPrepareStep}{serverPrepareDetail ? `：${serverPrepareDetail}` : ""}</p>
              )}
              {serverPrepareDone && (
                <p className="text-[10px] text-green-600 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" /> 模型下载完成，服务端推理已就绪
                </p>
              )}
              {serverPrepareStep === "失败" && (
                <p className="text-[10px] text-red-500">启用失败：{serverPrepareDetail}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* 浏览器推理：启用 / 状态区 */}
      {engine === "zipvoice" && (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-xs font-medium">浏览器推理设置</p>
          {preloadStatus === "ready" || isModelLoaded() ? (
            <p className="text-[10px] text-green-600 flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> 语音资源已就绪，可离线使用
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-[10px] text-amber-500">需先下载语音模型到浏览器（约 380MB，仅一次，之后完全离线）。</p>
              <Button variant="outline" size="sm" className="h-7 text-[10px]"
                onClick={() => preloadZipVoice()} disabled={preloadStatus === "downloading"}>
                {preloadStatus === "downloading" ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Download className="h-3 w-3 mr-1" />}
                {preloadStatus === "downloading" ? "下载中..." : "启用浏览器推理（下载模型）"}
              </Button>
              {preloadStatus === "downloading" && (
                <p className="text-[10px] text-amber-500">正在后台下载语音资源，完成后即可离线使用</p>
              )}
              {preloadStatus === "failed" && (
                <p className="text-[10px] text-red-500">下载失败，请重试（网络中断时也可稍后再试）</p>
              )}
              {preloadStatus === "skipped" && (
                <p className="text-[10px] text-muted-foreground">服务器资源未就绪，可能需要在服务器端先下载模型</p>
              )}
            </div>
          )}
        </div>
      )}

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
        /* Kokoro 音色选择（服务端推理 & 浏览器推理共用同一模型音色） */
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            {engine === "server" ? "服务端推理音色" : "浏览器推理音色"}
          </p>
          <div className="flex gap-2">
            <select
              aria-label="Kokoro 音色选择"
              className="flex-1 text-xs border rounded px-2 py-1.5 bg-background"
              value={ZH_VOICES[voiceId] ? voiceId : "45"}
              onChange={(e) => setVoiceId(e.target.value)}
            >
              {Object.entries(ZH_VOICES).map(([id, v]) => (
                <option key={id} value={id}>{v.name}</option>
              ))}
            </select>
            {engine === "server" ? (
              <Button variant="outline" size="sm" className="h-7 text-[10px] px-2 shrink-0"
                onClick={() => previewServerVoice(effectiveZipVoiceId)} disabled={serverPreviewing || !serverStatus?.ready}>
                {serverPreviewing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                <span className="ml-1">试听</span>
              </Button>
            ) : (
              <Button variant="outline" size="sm" className="h-7 text-[10px] px-2 shrink-0"
                onClick={() => previewZipVoice(effectiveZipVoiceId)} disabled={zipPreviewing}>
                {zipPreviewing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                <span className="ml-1">试听</span>
              </Button>
            )}
          </div>
          {engine === "server" && serverPreviewError && (
            <p className="text-[10px] text-red-500">试听失败：{serverPreviewError}</p>
          )}
          {engine === "server" && serverPreviewing && (
            <p className="text-[10px] text-amber-500">服务端正在生成试听音频（通常 1-3 秒）...</p>
          )}
          {engine === "zipvoice" && zipPreviewError && (
            <p className="text-[10px] text-red-500">试听失败：{zipPreviewError}</p>
          )}
          {engine === "zipvoice" && zipPreviewing && (
            <p className="text-[10px] text-amber-500">正在加载模型并生成试听音频（首次需下载模型，可能较慢）...</p>
          )}
          <p className="text-[10px] text-muted-foreground">
            {engine === "server"
              ? "Kokoro 模型在服务器生成音频（需已启用服务端推理），无网络上传的隐私顾虑（仅发送文本）"
              : "Kokoro 离线引擎，生成在本地完成（无网络请求）"}
          </p>
        </div>
      )}

      {/* 单次生成字数（当前引擎分块大小，三引擎各自独立；Web Speech 无此概念，隐藏） */}
      {engine !== "webspeech" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">
              {engine === "server" ? "单次生成字数（服务端推理）" : "单次生成字数（浏览器推理）"}
            </p>
            <span className="text-xs text-muted-foreground">{chunkSize} 字</span>
          </div>
          <input type="range" min={30} max={500} step={10}
            value={chunkSize}
            aria-label="单次生成字数"
            onChange={(e) => setChunkSize(parseInt(e.target.value, 10))}
            className="w-full h-1.5" />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>30</span><span>150</span><span>300</span><span>500</span>
          </div>
          <p className="text-[10px] text-muted-foreground">
            {engine === "server"
              ? "每次生成一段音频的字数上限：服务端推理快（RTF≈0.6），可适当调大减少生成次数；按句子边界切分，不会拆开一句话"
              : "每次生成一段音频的字数上限：调小更不容易超时（低配设备），调大减少生成次数（高配设备）。按句子边界切分，不会拆开一句话"}
          </p>
        </div>
      )}

      {/* 开播前预生成段数（Kokoro 引擎：先缓冲 K 段再开始播放，播放中继续后台生成；Web Speech 无此概念） */}
      {engine !== "webspeech" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">
              {engine === "server" ? "开播前预生成段数（服务端推理）" : "开播前预生成段数（浏览器推理）"}
            </p>
            <span className="text-xs text-muted-foreground">{prefetchCount} 段</span>
          </div>
          <input type="range" min={1} max={10} step={1}
            value={prefetchCount}
            aria-label="开播前预生成段数"
            onChange={(e) => setPrefetchCount(parseInt(e.target.value, 10))}
            className="w-full h-1.5" />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>1 段</span><span>5 段</span><span>10 段</span>
          </div>
          <p className="text-[10px] text-muted-foreground">
            {engine === "server"
              ? "点击朗读后先预生成 N 段音频再开始播放，避免播放中等待；服务端生成很快，建议 2-3 段"
              : "点击朗读后先预生成 N 段再开始播放（播放中后台继续生成）。浏览器推理较慢：段数越多开局等待越久、但连续播放越长。默认 3 段，可点「立即播放」跳过等待"}
          </p>
        </div>
      )}

      {/* 并行推理 Worker 数（仅浏览器推理：多 Worker 并行生成，内存换速度） */}
      {engine === "zipvoice" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">并行推理 Worker 数</p>
            <span className="text-xs text-muted-foreground">{workerCount} 个</span>
          </div>
          <input type="range" min={1} max={3} step={1}
            value={workerCount}
            aria-label="并行推理 Worker 数"
            onChange={(e) => setWorkerCount(parseInt(e.target.value, 10))}
            className="w-full h-1.5" />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>1（省内存）</span><span>2</span><span>3（最快）</span>
          </div>
          <p className="text-[10px] text-amber-600">
            每个 Worker 独立加载模型，约占用 400-500MB 内存。3 个 Worker 预生成等待约缩短 3 倍（如 3 段从 3-5 分钟 → 1-1.5 分钟），但总内存约 1.2-1.35GB。
            低内存设备（8GB 以下）建议保持 1 个。修改后下次朗读生效。
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
        {engine !== "webspeech" && (
          <p className="text-[10px] text-amber-500">Kokoro 引擎暂不支持音调调节，此设置仅对 Web Speech 生效</p>
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
