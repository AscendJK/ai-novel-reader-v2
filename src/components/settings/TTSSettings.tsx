/**
 * TTS 语音朗读设置
 * ZipVoice + sherpa-onnx 方案
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Loader2, Volume2, Zap, Play } from "lucide-react";
import { useTTSStore } from "@/stores/tts-store";
import { ZH_VOICES } from "@/tts/zipvoice-engine";

export function TTSSettings() {
  const {
    engine,
    voiceId, speed, autoNextChapter,
    modelDownloaded, modelDownloading, modelDownloadProgress,
    setEngine, setVoiceId, setSpeed, setAutoNextChapter,
    setModelDownloaded, setModelDownloading,
  } = useTTSStore();

  // Web Speech API 可用语音列表（中文）
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const updateVoices = () => {
      setVoices(speechSynthesis.getVoices().filter(v => v.lang.startsWith("zh")));
    };
    updateVoices();
    speechSynthesis.addEventListener("voiceschanged", updateVoices);
    return () => speechSynthesis.removeEventListener("voiceschanged", updateVoices);
  }, []);

  // 语音试听
  const [previewing, setPreviewing] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<string>("");
  // H9 fix: 追踪预览资源，组件卸载时清理
  const previewCtxRef = useRef<AudioContext | null>(null);
  const previewSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      // 组件卸载时清理预览资源
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      if (previewSourceRef.current) { try { previewSourceRef.current.stop(); } catch {} }
      if (previewCtxRef.current) { try { previewCtxRef.current.close(); } catch {} }
    };
  }, []);

  const previewVoice = useCallback((previewVoiceId: string) => {
    if (previewing) return;

    if (engine === "zipvoice") {
      const ctx = new AudioContext();
      previewCtxRef.current = ctx;
      setPreviewing(true);
      setPreviewStatus("正在加载模型...");
      import("@/tts/zipvoice-engine").then(({ loadModel, generateAudio, isModelLoaded }) => {
        const modelReady = isModelLoaded();
        if (!modelReady) {
          setPreviewStatus("首次使用，正在下载模型...");
          setModelDownloading(true, 0);
        }
        return loadModel({
          onProgress: (p) => {
            if (!modelReady) {
              setPreviewStatus(`正在下载模型 ${p}%...`);
              setModelDownloading(true, p);
            }
          }
        }).then(() => {
          setModelDownloading(false);
          setModelDownloaded(true);
          setPreviewStatus("正在生成音频...");
          const audioChunks: Float32Array[] = [];
          return generateAudio("你好，这是一段语音试听。", { voice: previewVoiceId, speed: 1.0 }, (chunk) => {
            audioChunks.push(chunk);
          }).then(() => {
            setPreviewStatus("");
            if (ctx.state === "suspended") ctx.resume();
            const totalLen = audioChunks.reduce((s, c) => s + c.length, 0);
            const merged = new Float32Array(totalLen);
            let off = 0;
            for (const c of audioChunks) { merged.set(c, off); off += c.length; }
            const buffer = ctx.createBuffer(1, merged.length, 24000);
            buffer.copyToChannel(merged, 0);
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            previewSourceRef.current = source;
            source.onended = () => {
              previewSourceRef.current = null;
              previewCtxRef.current = null;
              ctx.close();
              setPreviewing(false);
            };
            source.start();
          });
        });
      }).catch((err) => {
        previewCtxRef.current = null;
        try { ctx.close(); } catch { /* already closed */ }
        setPreviewing(false);
        setPreviewStatus(`加载失败: ${err instanceof Error ? err.message : "未知错误"}`);
        console.error("[TTS] Preview failed:", err);
      });
    } else {
      const utterance = new SpeechSynthesisUtterance("你好，这是一段语音试听。");
      utterance.lang = "zh-CN";
      const voice = voices.find(v => v.voiceURI === previewVoiceId);
      if (voice) utterance.voice = voice;
      utterance.onend = () => {
        if (previewTimerRef.current) { clearTimeout(previewTimerRef.current); previewTimerRef.current = null; }
        setPreviewing(false);
      };
      utterance.onerror = () => {
        if (previewTimerRef.current) { clearTimeout(previewTimerRef.current); previewTimerRef.current = null; }
        setPreviewing(false);
      };
      setPreviewing(true);
      speechSynthesis.speak(utterance);
      // H10 fix: 安全超时，防止 onend/onerror 永不触发
      previewTimerRef.current = setTimeout(() => {
        speechSynthesis.cancel();
        previewTimerRef.current = null;
        setPreviewing(false);
      }, 30000);
    }
  }, [engine, voices, previewing, setModelDownloading, setModelDownloaded]);

  return (
    <div className="space-y-4">
      <div>
        <p className="font-medium text-sm">语音朗读</p>
        <p className="text-xs text-muted-foreground">基于 sherpa-onnx 的离线语音合成</p>
      </div>

      <Separator />

      {/* TTS 引擎选择 */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">语音引擎</p>
        <div className="flex gap-2">
          <Button
            variant={engine === "zipvoice" ? "default" : "outline"}
            size="sm"
            className="h-8 text-xs"
            onClick={() => setEngine("zipvoice")}
          >
            <Zap className="h-3 w-3 mr-1" />
            ZipVoice（推荐）
          </Button>
          <Button
            variant={engine === "webspeech" ? "default" : "outline"}
            size="sm"
            className="h-8 text-xs"
            onClick={() => setEngine("webspeech")}
          >
            <Volume2 className="h-3 w-3 mr-1" />
            Web Speech API
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          {engine === "zipvoice"
            ? "ZipVoice 高质量中文语音，基于 sherpa-onnx WASM，浏览器端离线推理"
            : "浏览器内置语音，无需下载，质量一般"
          }
        </p>
      </div>

      <Separator />

      {/* 语音选择 */}
      {engine === "zipvoice" ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">语音选择</p>
          <div className="flex gap-2">
            <select
              className="flex-1 text-xs border rounded px-2 py-1.5 bg-background"
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
            >
              {Object.entries(ZH_VOICES).map(([id, v]) => (
                <option key={id} value={id}>{v.name}</option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10px] px-2"
              onClick={() => previewVoice(voiceId)}
              disabled={previewing}
            >
              {previewing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              <span className="ml-1">试听</span>
            </Button>
          </div>
          {previewStatus && (
            <p className={`text-[10px] ${previewStatus.includes("失败") ? "text-destructive" : "text-muted-foreground"}`}>
              {previewStatus}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">语音选择</p>
          {voices.length > 0 ? (
            <div className="flex gap-2">
              <select
                className="flex-1 text-xs border rounded px-2 py-1.5 bg-background"
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
              >
                {voices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>
                ))}
              </select>
              <Button variant="outline" size="sm" className="h-7 text-[10px] px-2"
                onClick={() => previewVoice(voiceId)} disabled={previewing}>
                {previewing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                <span className="ml-1">试听</span>
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">未检测到中文语音，使用系统默认</p>
          )}
        </div>
      )}

      {/* 语速 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">语速</p>
          <span className="text-xs text-muted-foreground">{speed.toFixed(1)}x</span>
        </div>
        <input type="range" min={0.5} max={3.0} step={0.25} value={speed}
          onChange={(e) => setSpeed(parseFloat(e.target.value))} className="w-full h-1.5" />
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>0.5x</span><span>1.0x</span><span>2.0x</span><span>3.0x</span>
        </div>
      </div>

      {/* 自动翻章 */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-muted-foreground">自动翻章</p>
          <p className="text-[10px] text-muted-foreground">当前章播放完毕后自动播放下一章</p>
        </div>
        <button
          className={`w-10 h-5 rounded-full transition-colors ${autoNextChapter ? "bg-primary" : "bg-muted"}`}
          onClick={() => setAutoNextChapter(!autoNextChapter)}
        >
          <div className={`w-4 h-4 rounded-full bg-white transition-transform ${autoNextChapter ? "translate-x-5" : "translate-x-0.5"}`} />
        </button>
      </div>

      {/* 模型状态 */}
      {engine === "zipvoice" && (
        <>
          <Separator />
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">模型状态</p>
            {modelDownloaded ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-green-600">✓ 已就绪</span>
              </div>
            ) : modelDownloading ? (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span className="text-xs">正在下载模型 {modelDownloadProgress}%</span>
                </div>
                <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-primary transition-all" style={{ width: `${modelDownloadProgress}%` }} />
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">首次播放时自动下载</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
